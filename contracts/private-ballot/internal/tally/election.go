package tally

import (
	"errors"
	"sort"

	r255 "github.com/gtank/ristretto255"
)

// Setup is what CreateElection fixes. Trustee i (0-based) has identifier i + 1.
type Setup struct {
	Channel    string   `json:"channel"`
	Chaincode  string   `json:"chaincode"`
	ElectionID string   `json:"electionId"`
	Options    []string `json:"options"`
	Threshold  int      `json:"threshold"`
	Trustees   []string `json:"trustees"` // MSP IDs, in the order of the trustee list
}

// Keys is what the key ceremony fixes, as lowercase hex.
type Keys struct {
	PublicKey       string   `json:"publicKey"`
	VerifyingShares []string `json:"verifyingShares"`
}

// Election is a setup with its keys.
type Election struct {
	Setup
	Keys
}

// Prepared is an election with its points decoded and its context computed.
type Prepared struct {
	*Election
	H   *r255.Element
	S   []*r255.Element
	Ctx []byte
	IDs [][]byte
}

func (s *Setup) check() error {
	n := len(s.Trustees)
	if len(s.Options) < 1 || n < 1 || s.Threshold < 1 || s.Threshold > n {
		return errors.New("tally: bad election setup")
	}
	return nil
}

// Prepare decodes the election's key and verifying shares and computes ctx.
func Prepare(e *Election) (*Prepared, error) {
	p, err := prepareKeys(e)
	if err != nil {
		return nil, err
	}
	p.Ctx = Context(e)
	return p, nil
}

// PrepareWithContext decodes the election's key and verifying shares and
// takes ctx as given: the contract uses the context it fixed when the
// election opened, and Setup.Chaincode can then be empty.
func PrepareWithContext(e *Election, ctx []byte) (*Prepared, error) {
	if len(ctx) != 32 {
		return nil, errors.New("tally: ctx is 32 bytes")
	}
	p, err := prepareKeys(e)
	if err != nil {
		return nil, err
	}
	p.Ctx = append([]byte{}, ctx...)
	return p, nil
}

func prepareKeys(e *Election) (*Prepared, error) {
	if err := e.check(); err != nil {
		return nil, err
	}
	if len(e.VerifyingShares) != len(e.Trustees) {
		return nil, errors.New("tally: one verifying share per trustee")
	}
	point := func(h string) (*r255.Element, error) {
		b, ok := FromHex(h, 32)
		if !ok {
			return nil, errors.New("tally: a key isn't 32 bytes of hex")
		}
		p, ok := decodePoint(b)
		if !ok {
			return nil, errors.New("tally: a key isn't a point")
		}
		return p, nil
	}
	H, err := point(e.PublicKey)
	if err != nil {
		return nil, err
	}
	p := &Prepared{Election: e, H: H}
	for i, h := range e.VerifyingShares {
		S, err := point(h)
		if err != nil {
			return nil, err
		}
		p.S = append(p.S, S)
		p.IDs = append(p.IDs, TrusteeID(i))
	}
	return p, nil
}

// ContextParts returns the framed parts of ctx after its label.
func ContextParts(e *Election) []any {
	key, _ := FromHex(e.PublicKey, 32)
	parts := []any{e.Channel, e.Chaincode, e.ElectionID, key, len(e.Options)}
	for _, o := range e.Options {
		parts = append(parts, o)
	}
	parts = append(parts, e.Threshold, len(e.Trustees))
	for i := range e.Trustees {
		S, _ := FromHex(e.VerifyingShares[i], 32)
		parts = append(parts, TrusteeID(i), S)
	}
	return parts
}

// Context returns
//
//	ctx = SHA-256(frame(["weft-ballot v1", channel, chaincode, electionId, H, L, option_1, ..., option_L,
//	                     k, n, id_1, S_1, ..., id_n, S_n]))
func Context(e *Election) []byte { return digest(LabelContext, ContextParts(e)...) }

func sortedTrustees(e *Election) []any {
	msps := append([]string{}, e.Trustees...)
	sort.Strings(msps) // byte order
	parts := make([]any, len(msps))
	for i, m := range msps {
		parts[i] = m
	}
	return parts
}

// FingerprintInput returns the framed input of the fingerprint's hash.
func FingerprintInput(e *Election) []byte {
	return Frame(append([]any{LabelFingerprint, Context(e)}, sortedTrustees(e)...)...)
}

// Fingerprint returns the first 10 bytes of
// SHA-256(frame(["weft-election-fingerprint v1", ctx, msp_(1), ..., msp_(n)])),
// with the trustees' MSP IDs in byte order, as 20 lowercase hex characters.
func Fingerprint(e *Election) string {
	return ToHex(digest(LabelFingerprint, append([]any{Context(e)}, sortedTrustees(e)...)...)[:10])
}

// keysFromCommitments returns H and every S_j from the round 1 commitments:
// H = sum over i of C_i0, S_j = sum over t of (id_j^t)·(sum over i of C_it).
func keysFromCommitments(s *Setup, commitments [][]*r255.Element) (*r255.Element, []*r255.Element) {
	k := s.Threshold
	merged := make([]*r255.Element, k)
	for t := 0; t < k; t++ {
		merged[t] = identity()
		for _, c := range commitments {
			merged[t].Add(merged[t], c[t])
		}
	}
	S := make([]*r255.Element, len(s.Trustees))
	for j := range s.Trustees {
		id := scalarOf(uint64(j + 1))
		pow := scalarOf(1)
		scalars := make([]*r255.Scalar, k)
		for t := 0; t < k; t++ {
			scalars[t] = r255.NewScalar().Set(pow)
			pow.Multiply(pow, id)
		}
		S[j] = r255.NewElement().VarTimeMultiScalarMult(scalars, merged)
	}
	return merged[0], S
}
