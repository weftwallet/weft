package signer_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	"github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract/pseudonym"
	"github.com/ifeanyi-ugwu/weft/packages/idemix/internal/testtool"
	"github.com/ifeanyi-ugwu/weft/packages/idemix/signer"
)

const mspID = "ChairVoters2027MSP"

// enrol does both steps of Fabric CA's idemix enrolment against a scratch
// issuer: the module's credential request for the CA's nonce, then the
// credential the CA issues for it.
func enrol(t *testing.T, is *testtool.Issuer, key *signer.IssuerKey, ou string, role int, eid string) *signer.Credential {
	t.Helper()
	nonce := testtool.Nonce()
	sk, req, err := key.CredentialRequest(nonce)
	if err != nil {
		t.Fatalf("credential request: %v", err)
	}
	raw, err := marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	issued, err := is.Issue(raw, nonce, ou, role, eid)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	return &signer.Credential{SecretKey: sk, Credential: issued.Credential, CRI: issued.CRI, OU: ou, Role: role, EnrollmentID: eid}
}

func setup(t *testing.T) (*testtool.Issuer, *signer.IssuerKey, *testtool.MSP) {
	t.Helper()
	is, err := testtool.NewIssuer()
	if err != nil {
		t.Fatal(err)
	}
	key, err := signer.LoadIssuerKey(is.PublicKey)
	if err != nil {
		t.Fatalf("load issuer key: %v", err)
	}
	v, err := testtool.NewMSP(mspID, is.PublicKey, is.RevocationPublicKey)
	if err != nil {
		t.Fatalf("msp: %v", err)
	}
	return is, key, v
}

func TestIssuerKeyHash(t *testing.T) {
	is, key, _ := setup(t)
	sum := sha256.Sum256(is.PublicKey)
	if key.Hash() != hex.EncodeToString(sum[:]) {
		t.Fatalf("issuerKeyHash %s isn't SHA-256 of the key's bytes", key.Hash())
	}
}

func TestLoadIssuerKeyRefuses(t *testing.T) {
	is, _, _ := setup(t)
	for name, raw := range map[string][]byte{
		"empty":     nil,
		"truncated": is.PublicKey[:len(is.PublicKey)/2],
		"changed":   flip(is.PublicKey, len(is.PublicKey)-40),
	} {
		if _, err := signer.LoadIssuerKey(raw); err == nil {
			t.Errorf("%s issuer key loaded", name)
		}
	}
}

// TestSignVerifiesWithIBMsMSP is the module's whole job: a credential from
// the issuer, a new identity, and a signature that IBM idemix's own MSP,
// set up as a peer sets it up, accepts, over the right message only.
func TestSignVerifiesWithIBMsMSP(t *testing.T) {
	is, key, v := setup(t)
	cred := enrol(t, is, key, "voters", signer.RoleMember, "voter1")
	if err := key.CheckCredential(cred); err != nil {
		t.Fatalf("check: %v", err)
	}
	id, err := key.NewIdentity(cred, mspID)
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	defer id.Dispose()
	creator, err := id.Creator()
	if err != nil {
		t.Fatal(err)
	}
	msg := []byte("the proposal bytes Weft signs")
	sig, err := id.Sign(msg)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	got, err := v.Verify(creator, msg, sig)
	if err != nil {
		t.Fatalf("IBM's MSP refused the signature: %v", err)
	}
	if got.MspID != mspID || got.OU != "voters" || got.Role != "MEMBER" {
		t.Fatalf("the MSP read %+v", got)
	}
	if _, err := v.Verify(creator, []byte("another message"), sig); err == nil {
		t.Fatal("IBM's MSP accepted the signature over another message")
	}
	if bytes.Contains(id.IDBytes, []byte("voter1")) || bytes.Contains(creator, []byte("voter1")) {
		t.Fatal("the creator holds the enrolment ID")
	}
	if len(id.Nym) != 64 {
		t.Fatalf("the Nym is %d bytes", len(id.Nym))
	}
}

func TestNewNymForEveryIdentity(t *testing.T) {
	is, key, v := setup(t)
	cred := enrol(t, is, key, "voters", signer.RoleMember, "voter2")
	a, err := key.NewIdentity(cred, mspID)
	if err != nil {
		t.Fatal(err)
	}
	b, err := key.NewIdentity(cred, mspID)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(a.Nym, b.Nym) || bytes.Equal(a.IDBytes, b.IDBytes) {
		t.Fatal("two identities from one credential share a Nym")
	}
	for _, id := range []*signer.Identity{a, b} {
		creator, _ := id.Creator()
		sig, err := id.Sign([]byte("m"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := v.Verify(creator, []byte("m"), sig); err != nil {
			t.Fatalf("refused: %v", err)
		}
		id.Dispose()
	}
}

func TestAdminCredentialSignsAsAdmin(t *testing.T) {
	is, key, v := setup(t)
	cred := enrol(t, is, key, "voters", signer.RoleAdmin, "registrar")
	id, err := key.NewIdentity(cred, mspID)
	if err != nil {
		t.Fatal(err)
	}
	defer id.Dispose()
	creator, _ := id.Creator()
	sig, _ := id.Sign([]byte("m"))
	got, err := v.Verify(creator, []byte("m"), sig)
	if err != nil {
		t.Fatal(err)
	}
	if got.Role != "ADMIN" {
		t.Fatalf("role %s", got.Role)
	}
}

func TestCheckCredentialRefuses(t *testing.T) {
	is, key, _ := setup(t)
	good := enrol(t, is, key, "voters", signer.RoleMember, "voter3")
	cases := map[string]func(c signer.Credential) signer.Credential{
		"another OU":           func(c signer.Credential) signer.Credential { c.OU = "org1"; return c },
		"another role":         func(c signer.Credential) signer.Credential { c.Role = signer.RoleAdmin; return c },
		"another enrolment ID": func(c signer.Credential) signer.Credential { c.EnrollmentID = "voter4"; return c },
		"another secret key":   func(c signer.Credential) signer.Credential { c.SecretKey = flip(c.SecretKey, 31); return c },
		"a short secret key":   func(c signer.Credential) signer.Credential { c.SecretKey = c.SecretKey[:31]; return c },
		"a zero secret key":    func(c signer.Credential) signer.Credential { c.SecretKey = make([]byte, 32); return c },
		"a changed credential": func(c signer.Credential) signer.Credential { c.Credential = flip(c.Credential, 40); return c },
		"no credential":        func(c signer.Credential) signer.Credential { c.Credential = nil; return c },
		"the order as a key":   func(c signer.Credential) signer.Credential { c.SecretKey = order(); return c },
	}
	for name, change := range cases {
		c := change(*good)
		if err := key.CheckCredential(&c); err == nil {
			t.Errorf("%s: the credential checked out", name)
		}
		if _, err := key.NewIdentity(&c, mspID); err == nil {
			t.Errorf("%s: an identity was made", name)
		}
	}
	// A credential from another issuer.
	other, err := testtool.NewIssuer()
	if err != nil {
		t.Fatal(err)
	}
	otherKey, err := signer.LoadIssuerKey(other.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	foreign := enrol(t, other, otherKey, "voters", signer.RoleMember, "voter3")
	if err := key.CheckCredential(foreign); err == nil {
		t.Error("a credential from another issuer checked out")
	}
}

func TestCredentialRequestNonce(t *testing.T) {
	_, key, _ := setup(t)
	if _, _, err := key.CredentialRequest(make([]byte, 31)); err == nil || !strings.Contains(err.Error(), "nonce") {
		t.Fatalf("a 31-byte nonce: %v", err)
	}
}

func TestDisposeWipes(t *testing.T) {
	is, key, _ := setup(t)
	cred := enrol(t, is, key, "voters", signer.RoleMember, "voter5")
	id, err := key.NewIdentity(cred, mspID)
	if err != nil {
		t.Fatal(err)
	}
	sk, rNym := signer.Secrets(id)
	words := append(append([]big.Word(nil), wordsOf(sk)...), wordsOf(rNym)...)
	if allZero(words) {
		t.Fatal("the identity holds no secret to wipe")
	}
	skWords, rWords := sk.BigInt().Bits(), rNym.BigInt().Bits()
	id.Dispose()
	for _, w := range append(skWords[:cap(skWords)], rWords[:cap(rWords)]...) {
		if w != 0 {
			t.Fatal("a word of the secret key or the Nym's randomness survived Dispose")
		}
	}
	if _, err := id.Sign([]byte("m")); err == nil {
		t.Fatal("a disposed identity signed")
	}
	cred.Wipe()
	if !allZeroBytes(cred.SecretKey) || !allZeroBytes(cred.Credential) {
		t.Fatal("Wipe left bytes")
	}
}

// The identity's pseudonym verifies with the contract's verifier against
// its own Nym, is the same for every identity of one credential in one
// election, and is unrelated across elections.
func TestPseudonym(t *testing.T) {
	is, key, _ := setup(t)
	cred := enrol(t, is, key, "voters", signer.RoleMember, "voter1")
	pk, err := pseudonym.LoadIssuerKey(is.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	tracking := bytes.Repeat([]byte{7}, 32)
	verify := func(id *signer.Identity, j pseudonym.JSON, channel, election string) error {
		nym, ok := pseudonym.DecodePoint(id.Nym)
		if !ok {
			t.Fatal("the identity's Nym isn't a point")
		}
		proof, err := pseudonym.Decode(j)
		if err != nil {
			return err
		}
		return pseudonym.Verify(&pseudonym.Statement{Key: pk, Channel: channel, ElectionID: election, Tracking: tracking, Nym: nym}, proof)
	}
	a, err := key.NewIdentity(cred, mspID)
	if err != nil {
		t.Fatal(err)
	}
	b, err := key.NewIdentity(cred, mspID)
	if err != nil {
		t.Fatal(err)
	}
	pa, err := a.PseudonymProof("privatevote-chair-2027", "chair-2027", tracking)
	if err != nil {
		t.Fatal(err)
	}
	pb, err := b.PseudonymProof("privatevote-chair-2027", "chair-2027", tracking)
	if err != nil {
		t.Fatal(err)
	}
	pc, err := a.PseudonymProof("privatevote-chair-2028", "chair-2028", tracking)
	if err != nil {
		t.Fatal(err)
	}
	if err := verify(a, pa, "privatevote-chair-2027", "chair-2027"); err != nil {
		t.Fatalf("a's own proof: %v", err)
	}
	if err := verify(a, pc, "privatevote-chair-2028", "chair-2028"); err != nil {
		t.Fatalf("a's proof in chair-2028: %v", err)
	}
	if pa.Pseudonym != pb.Pseudonym || pa.Pseudonym == pc.Pseudonym {
		t.Fatal("one credential should have one pseudonym per election")
	}
	p, err := b.Pseudonym("privatevote-chair-2027", "chair-2027")
	if err != nil || hex.EncodeToString(p) != pa.Pseudonym {
		t.Fatalf("Pseudonym gave %x, %v; the proof has %s", p, err, pa.Pseudonym)
	}
	if err := verify(b, pa, "privatevote-chair-2027", "chair-2027"); err != pseudonym.ErrNotValid {
		t.Fatalf("a's proof with b's Nym: %v", err)
	}
	if _, err := a.PseudonymProof("c", "e", tracking[:31]); err == nil {
		t.Fatal("a 31-byte tracking code was accepted")
	}
	a.Dispose()
	if _, err := a.PseudonymProof("c", "e", tracking); err == nil {
		t.Fatal("a disposed identity made a proof")
	}
	if _, err := a.Pseudonym("c", "e"); err == nil {
		t.Fatal("a disposed identity made a pseudonym")
	}
}
