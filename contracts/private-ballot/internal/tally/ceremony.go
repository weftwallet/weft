package tally

import (
	"crypto/sha512"
	"fmt"
	"math/big"

	r255 "github.com/gtank/ristretto255"
)

// dkgPrefix is noble 2.4.0's DKG hash prefix for ristretto255_FROST:
// the suite name "FROST-RISTRETTO255-SHA512-v1" followed by "dkg".
const dkgPrefix = "FROST-RISTRETTO255-SHA512-v1dkg"

// Round1Challenge returns noble's proof of knowledge challenge,
// SHA-512(prefix || id || C_i0 || R) read as a little-endian integer mod l.
func Round1Challenge(index int, C0, R *r255.Element) *r255.Scalar {
	h := sha512.New()
	h.Write([]byte(dkgPrefix))
	h.Write(TrusteeID(index))
	h.Write(C0.Bytes())
	h.Write(R.Bytes())
	s, err := r255.NewScalar().SetUniformBytes(h.Sum(nil))
	if err != nil {
		panic(err)
	}
	return s
}

var round1Schema = sObj(f("commitments", sList(sStr)), f("proof", sStr), f("ceremonyKey", sStr))

// Round1 is a checked round 1 post.
type Round1 struct {
	Commitments []*r255.Element
	R           *r255.Element
	Z           *r255.Scalar
	CeremonyKey *r255.Element
}

// CheckRound1 checks PostCommitments from the trustee at index: k
// commitments, none the identity, the one-time key, and noble's proof of
// knowledge of a_i0, R || z, with R = z·G - c·C_i0.
func CheckRound1(s *Setup, index int, text string) (*Round1, error) {
	if err := s.check(); err != nil {
		return nil, err
	}
	const t = thingRound1
	msp := s.Trustees[index]
	x, err := parseStrict(t, text, round1Schema)
	if err != nil {
		return nil, err
	}
	cs := x["commitments"].([]any)
	if len(cs) != s.Threshold {
		return nil, errCommitmentCount(msp, len(cs), s.Threshold)
	}
	r := &Round1{}
	for i, c := range cs {
		p, _, err := pointAt(t, fmt.Sprintf("commitments[%d]", i), c.(string))
		if err != nil {
			return nil, err
		}
		if isIdentity(p) {
			return nil, errIdentityCommitment(msp, i)
		}
		r.Commitments = append(r.Commitments, p)
	}
	if r.CeremonyKey, _, err = pointAt(t, "ceremonyKey", x["ceremonyKey"].(string)); err != nil {
		return nil, err
	}
	if isIdentity(r.CeremonyKey) {
		return nil, errIdentityCeremonyKey(msp)
	}
	proof, ok := FromHex(x["proof"].(string), 64)
	if !ok {
		return nil, errProofOfKnowledge(msp)
	}
	var okR, okZ bool
	r.R, okR = decodePoint(proof[:32])
	r.Z, okZ = decodeScalar(proof[32:])
	if !okR || !okZ || isIdentity(r.R) {
		return nil, errProofOfKnowledge(msp)
	}
	c := Round1Challenge(index, r.Commitments[0], r.R)
	if lin(r.Z, generator(), c, r.Commitments[0]).Equal(r.R) != 1 {
		return nil, errProofOfKnowledge(msp)
	}
	return r, nil
}

var round2Schema = sObj(f("shares", sList(sObj(f("to", sStr), f("nonce", sStr), f("box", sStr)))))

// CheckRound2 checks PostShares from the trustee at index: one share of the
// right length for each other trustee. The contract can't read the shares.
func CheckRound2(s *Setup, index int, text string) error {
	if err := s.check(); err != nil {
		return err
	}
	const t = thingRound2
	x, err := parseStrict(t, text, round2Schema)
	if err != nil {
		return err
	}
	shares := objects(x["shares"])
	ids := make([]*big.Int, len(shares))
	for i, sh := range shares {
		_, raw, err := scalarAt(t, fmt.Sprintf("shares[%d].to", i), sh["to"].(string))
		if err != nil {
			return err
		}
		if _, ok := FromHex(sh["nonce"].(string), 12); !ok {
			return errNotBytes(t, fmt.Sprintf("shares[%d].nonce", i), 12)
		}
		if _, ok := FromHex(sh["box"].(string), 48); !ok {
			return errNotBytes(t, fmt.Sprintf("shares[%d].box", i), 48)
		}
		le := make([]byte, 32)
		for k := range raw {
			le[31-k] = raw[k]
		}
		ids[i] = new(big.Int).SetBytes(le)
	}
	n := len(s.Trustees)
	seen := map[int64]bool{}
	for _, id := range ids {
		v := id.Int64()
		if !id.IsInt64() || v < 1 || v > int64(n) || v == int64(index+1) || seen[v] {
			return errShareRecipients(s.Trustees[index])
		}
		seen[v] = true
	}
	if len(seen) != n-1 {
		return errShareRecipients(s.Trustees[index])
	}
	return nil
}

// ElectionKeys returns H and every S_j from the round 1 posts, in trustee
// order, as OpenElection computes them.
func ElectionKeys(s *Setup, round1 []*Round1) Keys {
	cs := make([][]*r255.Element, len(round1))
	for i, r := range round1 {
		cs[i] = r.Commitments
	}
	H, S := keysFromCommitments(s, cs)
	k := Keys{PublicKey: pointHex(H)}
	for _, x := range S {
		k.VerifyingShares = append(k.VerifyingShares, pointHex(x))
	}
	return k
}

var confirmSchema = sObj(f("c", sStr), f("z", sStr))

// CheckConfirmation checks ConfirmShares from the trustee at index:
// c = Hs("confirm", [ctx, id_j, S_j, z·G - c·S_j]).
func CheckConfirmation(p *Prepared, index int, text string) error {
	const t = thingConfirm
	x, err := parseStrict(t, text, confirmSchema)
	if err != nil {
		return err
	}
	c, _, err := scalarAt(t, "c", x["c"].(string))
	if err != nil {
		return err
	}
	z, _, err := scalarAt(t, "z", x["z"].(string))
	if err != nil {
		return err
	}
	S := p.S[index]
	R := lin(z, generator(), c, S)
	if Hs(LabelConfirm, p.Ctx, p.IDs[index], S.Bytes(), R.Bytes()).Equal(c) != 1 {
		return errConfirmation(p.Trustees[index])
	}
	return nil
}
