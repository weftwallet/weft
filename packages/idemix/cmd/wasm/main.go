//go:build js && wasm

// The WebAssembly module: globalThis.weftIdemix, with string-in,
// string-out functions. Bytes are base64, and each function returns JSON,
// {"ok": <result>} or {"error": "<message>"}. Weft runs it in a dedicated
// worker that the page needing it starts and terminates (docs/adr/0008).
package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"runtime/debug"
	"syscall/js"

	"github.com/ifeanyi-ugwu/weft/packages/idemix/signer"
)

// API is the version of the functions below. A change to a function's
// arguments or result changes it. 2: pseudonym and pseudonymProof make the
// per-election pseudonym and its proof. 3: verifyIdentity and
// verifyPseudonym check an anonymous ballot, for the explorer.
const API = 3

// extras are functions a test build adds (vectors.go, with the build tag
// weftvectors). The module Weft runs has none.
var extras []func(api js.Value)

var (
	key        *signer.IssuerKey
	identities = map[int]*signer.Identity{}
	next       = 1
)

type result struct {
	Ok    any    `json:"ok,omitempty"`
	Error string `json:"error,omitempty"`
}

func wrap(f func(args []js.Value) (any, error)) js.Func {
	return js.FuncOf(func(this js.Value, args []js.Value) (out any) {
		defer func() {
			if r := recover(); r != nil {
				b, _ := json.Marshal(result{Error: fmt.Sprint(r)})
				out = string(b)
			}
		}()
		v, err := f(args)
		r := result{Ok: v}
		if err != nil {
			r = result{Error: err.Error()}
		}
		b, _ := json.Marshal(r)
		return string(b)
	})
}

func str(args []js.Value, i int, name string) (string, error) {
	if i >= len(args) || args[i].Type() != js.TypeString {
		return "", fmt.Errorf("%s must be a string", name)
	}
	return args[i].String(), nil
}

func b64(args []js.Value, i int, name string) ([]byte, error) {
	s, err := str(args, i, name)
	if err != nil {
		return nil, err
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("%s isn't base64", name)
	}
	return b, nil
}

func loaded() error {
	if key == nil {
		return errors.New("no issuer key is loaded: call loadIssuerKey first")
	}
	return nil
}

// credentialJSON is a voter credential as Weft keeps it once unsealed.
type credentialJSON struct {
	SecretKey    string `json:"secretKey"`
	Credential   string `json:"credential"`
	CRI          string `json:"cri"`
	OU           string `json:"ou"`
	Role         int    `json:"role"`
	EnrollmentID string `json:"enrollmentId"`
}

func credential(args []js.Value, i int) (*signer.Credential, error) {
	s, err := str(args, i, "credential")
	if err != nil {
		return nil, err
	}
	var c credentialJSON
	if err := json.Unmarshal([]byte(s), &c); err != nil {
		return nil, errors.New("credential isn't the JSON of a voter credential")
	}
	out := &signer.Credential{OU: c.OU, Role: c.Role, EnrollmentID: c.EnrollmentID}
	for _, f := range []struct {
		name string
		in   string
		out  *[]byte
	}{{"secretKey", c.SecretKey, &out.SecretKey}, {"credential", c.Credential, &out.Credential}, {"cri", c.CRI, &out.CRI}} {
		b, err := base64.StdEncoding.DecodeString(f.in)
		if err != nil || len(b) == 0 {
			out.Wipe()
			return nil, fmt.Errorf("credential.%s isn't base64", f.name)
		}
		*f.out = b
	}
	return out, nil
}

func election(args []js.Value) (channel, electionID string, err error) {
	if channel, err = str(args, 1, "channel"); err != nil {
		return "", "", err
	}
	electionID, err = str(args, 2, "electionId")
	return channel, electionID, err
}

func identity(args []js.Value) (*signer.Identity, int, error) {
	if len(args) < 1 || args[0].Type() != js.TypeNumber {
		return nil, 0, errors.New("handle must be a number")
	}
	h := args[0].Int()
	id := identities[h]
	if id == nil {
		return nil, h, fmt.Errorf("there's no identity %d", h)
	}
	return id, h, nil
}

func dependency(path string) string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, d := range info.Deps {
		if d.Path == path {
			return d.Version
		}
	}
	return ""
}

func main() {
	api := js.Global().Get("Object").New()

	// info() → { api, curve, idemix, mathlib, go }
	api.Set("info", wrap(func(a []js.Value) (any, error) {
		info, _ := debug.ReadBuildInfo()
		goVersion := ""
		if info != nil {
			goVersion = info.GoVersion
		}
		return map[string]any{
			"api": API, "curve": signer.Curve, "go": goVersion,
			"idemix": dependency("github.com/IBM/idemix"), "mathlib": dependency("github.com/IBM/mathlib"),
		}, nil
	}))

	// loadIssuerKey(issuerPublicKey) → { issuerKeyHash, curve }
	api.Set("loadIssuerKey", wrap(func(a []js.Value) (any, error) {
		raw, err := b64(a, 0, "issuerPublicKey")
		if err != nil {
			return nil, err
		}
		k, err := signer.LoadIssuerKey(raw)
		if err != nil {
			return nil, err
		}
		key = k
		return map[string]any{"issuerKeyHash": k.Hash(), "curve": signer.Curve}, nil
	}))

	// credentialRequest(nonce) → { secretKey, request }: request is the
	// JSON Fabric CA's /api/v1/idemix/credential takes as "request".
	api.Set("credentialRequest", wrap(func(a []js.Value) (any, error) {
		if err := loaded(); err != nil {
			return nil, err
		}
		nonce, err := b64(a, 0, "nonce")
		if err != nil {
			return nil, err
		}
		sk, req, err := key.CredentialRequest(nonce)
		if err != nil {
			return nil, err
		}
		reqJSON, err := json.Marshal(req)
		if err != nil {
			return nil, err
		}
		out := map[string]any{"secretKey": base64.StdEncoding.EncodeToString(sk), "request": json.RawMessage(reqJSON)}
		clear(sk)
		return out, nil
	}))

	// checkCredential(credential) → "valid"
	api.Set("checkCredential", wrap(func(a []js.Value) (any, error) {
		if err := loaded(); err != nil {
			return nil, err
		}
		c, err := credential(a, 0)
		if err != nil {
			return nil, err
		}
		defer c.Wipe()
		if err := key.CheckCredential(c); err != nil {
			return nil, err
		}
		return "valid", nil
	}))

	// newIdentity(credential, mspId) → { handle, idBytes, nym }: a new
	// one-off identity, with idBytes the SerializedIdemixIdentity and nym
	// its 64-byte X and Y in lowercase hex.
	api.Set("newIdentity", wrap(func(a []js.Value) (any, error) {
		if err := loaded(); err != nil {
			return nil, err
		}
		c, err := credential(a, 0)
		if err != nil {
			return nil, err
		}
		defer c.Wipe()
		mspID, err := str(a, 1, "mspId")
		if err != nil {
			return nil, err
		}
		id, err := key.NewIdentity(c, mspID)
		if err != nil {
			return nil, err
		}
		h := next
		next++
		identities[h] = id
		return map[string]any{"handle": h, "idBytes": base64.StdEncoding.EncodeToString(id.IDBytes), "nym": hex.EncodeToString(id.Nym)}, nil
	}))

	// sign(handle, message) → signature, base64
	api.Set("sign", wrap(func(a []js.Value) (any, error) {
		id, _, err := identity(a)
		if err != nil {
			return nil, err
		}
		msg, err := b64(a, 1, "message")
		if err != nil {
			return nil, err
		}
		sig, err := id.Sign(msg)
		if err != nil {
			return nil, err
		}
		return base64.StdEncoding.EncodeToString(sig), nil
	}))

	// pseudonym(handle, channel, electionId) → P: the credential's
	// per-election pseudonym, its 64 bytes in lowercase hex, the same for
	// every identity of the credential. Weft makes the voter tag from it
	// before it makes the ballot.
	api.Set("pseudonym", wrap(func(a []js.Value) (any, error) {
		id, _, err := identity(a)
		if err != nil {
			return nil, err
		}
		channel, electionID, err := election(a)
		if err != nil {
			return nil, err
		}
		p, err := id.Pseudonym(channel, electionID)
		if err != nil {
			return nil, err
		}
		return hex.EncodeToString(p), nil
	}))

	// pseudonymProof(handle, channel, electionId, tracking) → { pseudonym,
	// c, ssk, sr }: the proof that P and the identity's Nym hold the same
	// secret key, for the ballot whose tracking code is tracking (64
	// lowercase hex characters), as CastAnonymousBallot's pseudonymJson. It
	// comes from the contract's pseudonym package, which the contract
	// verifies with.
	api.Set("pseudonymProof", wrap(func(a []js.Value) (any, error) {
		id, _, err := identity(a)
		if err != nil {
			return nil, err
		}
		channel, electionID, err := election(a)
		if err != nil {
			return nil, err
		}
		t, err := str(a, 3, "tracking")
		if err != nil {
			return nil, err
		}
		tracking, err := hex.DecodeString(t)
		if err != nil || len(tracking) != 32 || hex.EncodeToString(tracking) != t {
			return nil, errors.New("tracking must be 64 lowercase hex characters")
		}
		return id.PseudonymProof(channel, electionID, tracking)
	}))

	// verifyIdentity(idBytes) → { nym, ou, role }: checks a transaction's
	// idemix creator, the SerializedIdemixIdentity in base64, against the
	// loaded issuer key as a peer's idemix MSP validates it, and returns what
	// it discloses: the Nym's 64 bytes in lowercase hex, the organisational
	// unit and the role, "member" or "admin". An explorer checks anonymous
	// ballots with it; it needs no secret.
	api.Set("verifyIdentity", wrap(func(a []js.Value) (any, error) {
		if err := loaded(); err != nil {
			return nil, err
		}
		idBytes, err := b64(a, 0, "idBytes")
		if err != nil {
			return nil, err
		}
		v, err := key.VerifyIdentity(idBytes)
		if err != nil {
			return nil, err
		}
		return map[string]any{"nym": hex.EncodeToString(v.Nym), "ou": v.OU, "role": v.Role}, nil
	}))

	// verifyPseudonym(nym, channel, electionId, tracking, pseudonymJson) →
	// "valid": checks a ballot's pseudonym proof against the creator's Nym
	// (64 bytes in lowercase hex), the loaded issuer key and the ballot's
	// tracking code, with the contract's pseudonym package and its messages.
	api.Set("verifyPseudonym", wrap(func(a []js.Value) (any, error) {
		if err := loaded(); err != nil {
			return nil, err
		}
		n, err := str(a, 0, "nym")
		if err != nil {
			return nil, err
		}
		nym, err := hex.DecodeString(n)
		if err != nil || len(nym) != 64 {
			return nil, errors.New("nym must be 128 lowercase hex characters")
		}
		channel, electionID, err := election(a)
		if err != nil {
			return nil, err
		}
		t, err := str(a, 3, "tracking")
		if err != nil {
			return nil, err
		}
		tracking, err := hex.DecodeString(t)
		if err != nil || len(tracking) != 32 || hex.EncodeToString(tracking) != t {
			return nil, errors.New("tracking must be 64 lowercase hex characters")
		}
		proof, err := str(a, 4, "pseudonymJson")
		if err != nil {
			return nil, err
		}
		if err := key.VerifyPseudonym(nym, channel, electionID, tracking, proof); err != nil {
			return nil, err
		}
		return "valid", nil
	}))

	// dispose(handle) → "disposed": zeroes and drops the identity's secrets.
	api.Set("dispose", wrap(func(a []js.Value) (any, error) {
		id, h, err := identity(a)
		if err != nil {
			return nil, err
		}
		id.Dispose()
		delete(identities, h)
		return "disposed", nil
	}))

	// wipe() → "wiped": disposes of every identity and the issuer key.
	api.Set("wipe", wrap(func(a []js.Value) (any, error) {
		for h, id := range identities {
			id.Dispose()
			delete(identities, h)
		}
		key = nil
		return "wiped", nil
	}))

	for _, add := range extras {
		add(api)
	}
	js.Global().Set("weftIdemix", api)
	select {}
}
