package pseudonym_test

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"strings"
	"testing"

	idemix "github.com/IBM/idemix/bccsp/schemes/dlog/crypto"
	"github.com/IBM/idemix/bccsp/schemes/dlog/crypto/translator/amcl"
	math "github.com/IBM/mathlib"
	"google.golang.org/protobuf/proto"

	"github.com/weftwallet/weft/contracts/private-ballot/internal/tally"
	"github.com/weftwallet/weft/contracts/private-ballot/pseudonym"
)

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("bad hex %q", s)
	}
	return b
}

func decodePoint(t *testing.T, s string) *math.G1 {
	t.Helper()
	g, ok := pseudonym.DecodePoint(unhex(t, s))
	if !ok {
		t.Fatalf("%s isn't a point", s)
	}
	return g
}

func decodeScalar(t *testing.T, s string) *math.Zr {
	t.Helper()
	z, ok := pseudonym.DecodeScalar(unhex(t, s))
	if !ok {
		t.Fatalf("%s isn't a scalar", s)
	}
	return z
}

// parse runs what the contract runs on pseudonymJson: the strict parse,
// then decoding.
func parse(text string) (*pseudonym.Proof, error) {
	f, err := tally.ParsePseudonym(text)
	if err != nil {
		return nil, err
	}
	return pseudonym.Decode(pseudonym.JSON{Pseudonym: f.Pseudonym, C: f.C, SSk: f.SSk, SR: f.SR})
}

func keysOf(t *testing.T, f *VectorFile) map[string]*pseudonym.Key {
	t.Helper()
	out := map[string]*pseudonym.Key{}
	for _, iv := range f.Issuers {
		k, err := pseudonym.LoadIssuerKey(unhex(t, iv.IssuerPublicKey))
		if err != nil {
			t.Fatalf("%s: %v", iv.Name, err)
		}
		if k.HashHex() != iv.IssuerKeyHash || pt(k.HSk) != iv.HSk || pt(k.HRand) != iv.HRand {
			t.Errorf("%s: the key's hash or points differ from the vector", iv.Name)
		}
		out[iv.Name] = k
	}
	return out
}

func TestConstants(t *testing.T) {
	if curve.GroupOrder.BigInt().Cmp(orderR) != 0 {
		t.Errorf("r isn't IBM mathlib's group order for FP256BN_AMCL")
	}
	// G1's generator and HashToG1's outputs are on y^2 = x^3 + 3 mod p.
	for _, g := range []*math.G1{curve.GenG1, curve.HashToG1([]byte("x"))} {
		if _, ok := pseudonym.DecodePoint(pseudonym.EncodePoint(g)); !ok {
			t.Errorf("a point of G1 isn't on the curve with the specification's p")
		}
	}
	// G1 has order r: (r - 1)·G = -G.
	minusOne := curve.NewZrFromBigInt(new(big.Int).Sub(orderR, big.NewInt(1)))
	neg := curve.GenG1.Copy()
	neg.Neg()
	if !curve.GenG1.Mul(minusOne).Equals(neg) {
		t.Errorf("(r - 1)·G isn't -G")
	}
	if new(big.Int).Mod(fieldP, big.NewInt(4)).Int64() != 3 {
		t.Errorf("p isn't 3 mod 4")
	}
}

// HashToG1 and HashToZr are IBM mathlib's, and match the specification's
// description of them, written here independently, on many inputs.
func TestHashesMatchTheSpecification(t *testing.T) {
	for i := range 300 {
		m := make([]byte, i%70)
		if _, err := rand.Read(m); err != nil {
			t.Fatal(err)
		}
		_, _, _, x, y := specHashToG1(m)
		if pt(curve.HashToG1(m)) != h(append(pad32(x), pad32(y)...)) {
			t.Fatalf("HashToG1(%x) isn't what the specification says", m)
		}
		d := sha256.Sum256(m)
		want := new(big.Int).Mod(new(big.Int).SetBytes(d[:]), orderR)
		if curve.HashToZr(m).BigInt().Cmp(want) != 0 {
			t.Fatalf("HashToZr(%x) isn't OS2IP(SHA-256) mod r", m)
		}
	}
}

func TestHashToG1Vectors(t *testing.T) {
	f := loadVectors(t)
	for _, v := range f.HashToG1 {
		m := unhex(t, v.Input)
		shake, x0, inc, _, _ := specHashToG1(m)
		if h(shake) != v.Shake256 || h(pad32(x0)) != v.X0 || inc != v.Increments || pt(curve.HashToG1(m)) != v.Point {
			t.Errorf("%s: HashToG1 doesn't give the vector", v.Name)
		}
	}
	if pt(pseudonym.Base("privatevote-chair-2027", "chair-2027")) != f.HashToG1[0].Point {
		t.Error("B of chair-2027 isn't HashToG1 of its framed input")
	}
}

func TestPositiveVectors(t *testing.T) {
	f := loadVectors(t)
	keys := keysOf(t, f)
	pseudonyms := map[string]string{}
	for _, v := range f.Positive {
		k := keys[v.Issuer]
		sk, rNym := decodeScalar(t, v.Sk), decodeScalar(t, v.RNym)
		nym := decodePoint(t, v.Nym)
		if !k.HSk.Mul2(sk, k.HRand, rNym).Equals(nym) {
			t.Errorf("%s: the Nym isn't sk·HSk + rNym·HRand", v.Name)
		}
		st := &pseudonym.Statement{Key: k, Channel: v.Channel, ElectionID: v.ElectionID, Tracking: unhex(t, v.Tracking), Nym: nym}

		// The prover reproduces every value from the vector's inputs.
		proof, tr, err := pseudonym.ProveWith(st, sk, rNym, decodeScalar(t, v.A), decodeScalar(t, v.B))
		if err != nil {
			t.Fatalf("%s: %v", v.Name, err)
		}
		got := []string{pt(tr.B), pt(tr.P), pt(tr.T1), pt(tr.T2), h(tr.ChallengeInput), sc(tr.C), sc(tr.SSk), sc(tr.SR)}
		want := []string{v.Base, v.P, v.T1, v.T2, v.ChallengeInput, v.C, v.SSk, v.SR}
		for i := range got {
			if got[i] != want[i] {
				t.Errorf("%s: value %d is %s, not %s", v.Name, i, got[i], want[i])
			}
		}
		if text, _ := json.Marshal(proof.JSON()); string(text) != v.PseudonymJSON {
			t.Errorf("%s: pseudonymJson is %s", v.Name, text)
		}
		if len(v.PseudonymJSON) != 360 {
			t.Errorf("%s: pseudonymJson is %d characters, not 360", v.Name, len(v.PseudonymJSON))
		}

		// The verifier accepts it, through the contract's parse and decode,
		// and computes the same T1 and T2.
		decoded, err := parse(v.PseudonymJSON)
		if err != nil {
			t.Fatalf("%s: %v", v.Name, err)
		}
		vt, err := pseudonym.VerifyTrace(st, decoded)
		if err != nil {
			t.Fatalf("%s: %v", v.Name, err)
		}
		if pt(vt.T1) != v.T1 || pt(vt.T2) != v.T2 {
			t.Errorf("%s: the verifier's T1 or T2 differs from the prover's", v.Name)
		}
		if h(tally.VoterTagIdemix(v.Channel, v.ElectionID, v.MspID, decoded.PBytes())) != v.VoterTag {
			t.Errorf("%s: the voter tag differs", v.Name)
		}
		// The challenge input is frame([label, issuerKeyHash, channel,
		// electionId, tracking, B, Nym, P, T1, T2]).
		wantInput := framed([]byte(pseudonym.LabelProof), k.Hash[:], []byte(v.Channel), []byte(v.ElectionID), unhex(t, v.Tracking),
			unhex(t, v.Base), unhex(t, v.Nym), unhex(t, v.P), unhex(t, v.T1), unhex(t, v.T2))
		if h(wantInput) != v.ChallengeInput {
			t.Errorf("%s: the challenge input isn't the framed statement", v.Name)
		}
		key := v.Channel + "/" + v.ElectionID + "/" + v.Sk
		if prev, ok := pseudonyms[key]; ok && prev != v.P {
			t.Errorf("%s: one credential has two pseudonyms in one election", v.Name)
		}
		pseudonyms[key] = v.P
	}
	// voter1 has one pseudonym in chair-2027, another in chair-2028, and
	// voter2 another again.
	p := []string{f.Positive[0].P, f.Positive[1].P, f.Positive[2].P, f.Positive[3].P}
	if p[0] != p[1] || p[0] == p[2] || p[0] == p[3] || p[2] == p[3] {
		t.Errorf("the pseudonyms aren't one per credential per election: %v", p)
	}
	if f.Positive[0].Nym == f.Positive[1].Nym || f.Positive[0].C == f.Positive[1].C {
		t.Error("voter1's two identities have the same Nym or the same proof")
	}
}

func TestNegativeVectors(t *testing.T) {
	f := loadVectors(t)
	keys := keysOf(t, f)
	for _, v := range f.Negative {
		st := &pseudonym.Statement{Key: keys[v.Issuer], Channel: v.Channel, ElectionID: v.ElectionID, Tracking: unhex(t, v.Tracking), Nym: decodePoint(t, v.Nym)}
		proof, err := parse(v.PseudonymJSON)
		if err == nil {
			err = pseudonym.Verify(st, proof)
		}
		if err == nil {
			t.Errorf("%s: accepted", v.Name)
			continue
		}
		var pe *pseudonym.Error
		var te *tally.Error
		if !errors.As(err, &pe) && !errors.As(err, &te) {
			t.Errorf("%s: %v isn't one of the contract's refusals", v.Name, err)
		}
		if err.Error() != v.Error {
			t.Errorf("%s:\n got %s\nwant %s", v.Name, err, v.Error)
		}
	}
}

// The vectors that make T1' or T2' the identity do make them so.
func TestIdentityCommitmentVectors(t *testing.T) {
	f := loadVectors(t)
	keys := keysOf(t, f)
	for _, v := range f.Negative {
		if !strings.HasSuffix(v.Name, "is the identity") {
			continue
		}
		k := keys[v.Issuer]
		proof, err := parse(v.PseudonymJSON)
		if err != nil {
			t.Fatal(err)
		}
		t1 := k.HSk.Mul2(proof.SSk, k.HRand, proof.SR)
		t1.Sub(decodePoint(t, v.Nym).Mul(proof.C))
		t2 := pseudonym.Base(v.Channel, v.ElectionID).Mul(proof.SSk)
		t2.Sub(proof.P.Mul(proof.C))
		if strings.HasPrefix(v.Name, "T1'") != t1.IsInfinity() || strings.HasPrefix(v.Name, "T2'") != t2.IsInfinity() {
			t.Errorf("%s: T1' %v, T2' %v", v.Name, t1.IsInfinity(), t2.IsInfinity())
		}
	}
}

func TestVectorCounts(t *testing.T) {
	f := loadVectors(t)
	if f.Counts["positive"] != len(f.Positive) || f.Counts["negative"] != len(f.Negative) || len(f.Positive) < 4 || len(f.Negative) < 30 {
		t.Errorf("counts: %v (%s)", f.Counts, fmtCount(f))
	}
}

// A new random identity of one credential: a new Nym, the same pseudonym,
// and a proof only for its own Nym. This is the prototype's replay test,
// against version 1's encoding.
func TestProveAndReplay(t *testing.T) {
	f := loadVectors(t)
	k := keysOf(t, f)["issuer-a"]
	sk := curve.NewRandomZr(rand.Reader)
	tracking := make([]byte, 32)
	if _, err := rand.Read(tracking); err != nil {
		t.Fatal(err)
	}
	type made struct {
		st    *pseudonym.Statement
		proof *pseudonym.Proof
	}
	var ids []made
	for range 2 {
		rNym := curve.NewRandomZr(rand.Reader)
		st := &pseudonym.Statement{Key: k, Channel: "privatevote-chair-2027", ElectionID: "chair-2027", Tracking: tracking, Nym: k.HSk.Mul2(sk, k.HRand, rNym)}
		proof, err := pseudonym.Prove(st, sk, rNym, rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		if err := pseudonym.Verify(st, proof); err != nil {
			t.Fatalf("a fresh proof: %v", err)
		}
		if !proof.P.Equals(pseudonym.Pseudonym(sk, st.Channel, st.ElectionID)) {
			t.Fatal("P isn't sk·B")
		}
		ids = append(ids, made{st, proof})
	}
	if ids[0].st.Nym.Equals(ids[1].st.Nym) || !ids[0].proof.P.Equals(ids[1].proof.P) {
		t.Fatal("two identities of one credential: the Nyms should differ and the pseudonyms match")
	}
	if err := pseudonym.Verify(ids[1].st, ids[0].proof); err != pseudonym.ErrNotValid {
		t.Fatalf("a proof replayed with another identity's Nym: %v", err)
	}
	// Another credential can't claim this pseudonym under its own Nym.
	other := curve.NewRandomZr(rand.Reader)
	rNym := curve.NewRandomZr(rand.Reader)
	st := &pseudonym.Statement{Key: k, Channel: "privatevote-chair-2027", ElectionID: "chair-2027", Tracking: tracking, Nym: k.HSk.Mul2(other, k.HRand, rNym)}
	forged, err := pseudonym.Prove(st, other, rNym, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	forged.P = ids[0].proof.P
	if err := pseudonym.Verify(st, forged); err != pseudonym.ErrNotValid {
		t.Fatalf("a proof with another credential's pseudonym: %v", err)
	}
}

func TestProverRefusals(t *testing.T) {
	f := loadVectors(t)
	k := keysOf(t, f)["issuer-a"]
	one := curve.NewZrFromInt(1)
	st := &pseudonym.Statement{Key: k, Channel: "c", ElectionID: "e", Tracking: make([]byte, 32), Nym: k.HSk}
	if _, _, err := pseudonym.ProveWith(st, curve.NewZrFromInt(0), one, one, one); err == nil {
		t.Error("sk of 0 was accepted")
	}
	if _, _, err := pseudonym.ProveWith(st, one, one, curve.NewZrFromInt(0), curve.NewZrFromInt(0)); err == nil {
		t.Error("a and b of 0, which make T1 and T2 the identity, were accepted")
	}
	st.Tracking = make([]byte, 31)
	if _, _, err := pseudonym.ProveWith(st, one, one, one, one); err == nil {
		t.Error("a 31-byte tracking code was accepted")
	}
}

// A duplicated name keeps its last value, as both JSON parsers do.
func TestParseDuplicate(t *testing.T) {
	f := loadVectors(t)
	v := f.Positive[0]
	var j pseudonym.JSON
	if err := json.Unmarshal([]byte(v.PseudonymJSON), &j); err != nil {
		t.Fatal(err)
	}
	text := `{"pseudonym":"` + j.Pseudonym + `","c":"00","c":"` + j.C + `","ssk":"` + j.SSk + `","sr":"` + j.SR + `"}`
	if _, err := parse(text); err != nil {
		t.Fatal(err)
	}
}

func TestLoadIssuerKey(t *testing.T) {
	f := loadVectors(t)
	raw := unhex(t, f.Issuers[0].IssuerPublicKey)
	if _, err := pseudonym.LoadIssuerKey(raw); err != nil {
		t.Fatal(err)
	}
	ipk := &idemix.IssuerPublicKey{}
	if err := proto.Unmarshal(raw, ipk); err != nil {
		t.Fatal(err)
	}
	reencode := func(change func(*idemix.IssuerPublicKey)) []byte {
		c := proto.Clone(ipk).(*idemix.IssuerPublicKey)
		change(c)
		b, err := proto.MarshalOptions{Deterministic: true}.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	tr := &amcl.Fp256bn{C: curve}
	for name, b := range map[string][]byte{
		"not a key":              []byte("not a key"),
		"empty":                  {},
		"other attribute names":  reencode(func(c *idemix.IssuerPublicKey) { c.AttributeNames = []string{"OU", "Role", "EnrollmentID", "Other"} }),
		"three attribute names":  reencode(func(c *idemix.IssuerPublicKey) { c.AttributeNames = c.AttributeNames[:3]; c.HAttrs = c.HAttrs[:3] }),
		"a changed proof":        reencode(func(c *idemix.IssuerPublicKey) { c.ProofC = curve.NewZrFromInt(7).Bytes() }),
		"HSk off the curve":      reencode(func(c *idemix.IssuerPublicKey) { c.HSk = &amcl.ECP{X: make([]byte, 32), Y: make([]byte, 32)} }),
		"HRand with a 31-byte x": reencode(func(c *idemix.IssuerPublicKey) { c.HRand = &amcl.ECP{X: c.HRand.X[:31], Y: c.HRand.Y} }),
		"HSk as the identity":    reencode(func(c *idemix.IssuerPublicKey) { c.HSk = tr.G1ToProto(curve.GenG1.Mul(curve.NewZrFromInt(0))) }),
	} {
		if _, err := pseudonym.LoadIssuerKey(b); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
