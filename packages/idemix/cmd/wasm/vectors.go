//go:build js && wasm && weftvectors

// A test build's extra function, for the pseudonym vectors: the module
// Weft runs is built without the weftvectors tag and has no such function.
// It proves with the vector's fixed sk, rNym, a and b, which the module's
// own pseudonym never takes from its caller.
package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"syscall/js"

	math "github.com/IBM/mathlib"

	"github.com/weftwallet/weft/contracts/private-ballot/pseudonym"
)

func init() {
	extras = append(extras, func(api js.Value) {
		// pseudonymVector(json) → the proof's trace, every byte string in
		// lowercase hex.
		api.Set("pseudonymVector", wrap(func(a []js.Value) (any, error) {
			s, err := str(a, 0, "vector")
			if err != nil {
				return nil, err
			}
			var in struct {
				IssuerPublicKey string `json:"issuerPublicKey"`
				Channel         string `json:"channel"`
				ElectionID      string `json:"electionId"`
				Tracking        string `json:"tracking"`
				Sk, RNym, A, B  string
			}
			if err := json.Unmarshal([]byte(s), &in); err != nil {
				return nil, err
			}
			raw, err := hex.DecodeString(in.IssuerPublicKey)
			if err != nil {
				return nil, err
			}
			key, err := pseudonym.LoadIssuerKey(raw)
			if err != nil {
				return nil, err
			}
			var zs [4]*math.Zr
			for i, h := range []string{in.Sk, in.RNym, in.A, in.B} {
				b, err := hex.DecodeString(h)
				if err != nil {
					return nil, err
				}
				var ok bool
				if zs[i], ok = pseudonym.DecodeScalar(b); !ok {
					return nil, errors.New("not a scalar")
				}
			}
			tracking, err := hex.DecodeString(in.Tracking)
			if err != nil {
				return nil, err
			}
			nym := key.HSk.Mul2(zs[0], key.HRand, zs[1])
			st := &pseudonym.Statement{Key: key, Channel: in.Channel, ElectionID: in.ElectionID, Tracking: tracking, Nym: nym}
			proof, tr, err := pseudonym.ProveWith(st, zs[0], zs[1], zs[2], zs[3])
			if err != nil {
				return nil, err
			}
			p := func(g *math.G1) string { return hex.EncodeToString(pseudonym.EncodePoint(g)) }
			z := func(x *math.Zr) string { return hex.EncodeToString(pseudonym.EncodeScalar(x)) }
			return map[string]any{
				"nym": p(nym), "B": p(tr.B), "P": p(tr.P), "T1": p(tr.T1), "T2": p(tr.T2),
				"challengeInput": hex.EncodeToString(tr.ChallengeInput), "c": z(tr.C), "ssk": z(tr.SSk), "sr": z(tr.SR),
				"proof": proof.JSON(),
			}, nil
		}))
	})
}
