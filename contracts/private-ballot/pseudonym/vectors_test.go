package pseudonym_test

// The test vectors in testdata/v1/pseudonym.json, written from fixed seeds.
// TestVectorsFile regenerates them in memory and compares every byte with
// the committed file; run
//
//	go test ./pseudonym -run TestVectorsFile -update
//
// to write them after a change to the scheme, which needs a new label
// version and a new folder (private-tally-spec.md, Test vectors).

import (
	"bytes"
	"crypto/sha256"
	"crypto/sha3"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"testing"

	idemix "github.com/IBM/idemix/bccsp/schemes/dlog/crypto"
	"github.com/IBM/idemix/bccsp/schemes/dlog/crypto/translator/amcl"
	math "github.com/IBM/mathlib"
	"google.golang.org/protobuf/proto"

	"github.com/weftwallet/weft/contracts/private-ballot/internal/tally"
	"github.com/weftwallet/weft/contracts/private-ballot/pseudonym"
)

var update = flag.Bool("update", false, "write testdata/v1/pseudonym.json")

var (
	vectorsFile = filepath.Join("testdata", "v1", "pseudonym.json")
	curve       = math.Curves[math.FP256BN_AMCL]
	orderR, _   = new(big.Int).SetString(pseudonym.RHex, 16)
	fieldP, _   = new(big.Int).SetString(pseudonym.PHex, 16)
)

// The seeds' streams. A named value is
//
//	OS2IP(SHA-512(frame(["weft-scope test v1", seed, name]))) mod r
//
// and an issuer key is drawn by IBM idemix from the stream
// SHA-512(frame(["weft-scope test rng v1", seed, i])) for i = 0, 1 and so
// on, with i as 4 bytes big-endian.
const (
	labelValue  = "weft-scope test v1"
	labelStream = "weft-scope test rng v1"
)

func framed(parts ...[]byte) []byte {
	var out bytes.Buffer
	for _, p := range parts {
		out.Write(binary.BigEndian.AppendUint32(nil, uint32(len(p))))
		out.Write(p)
	}
	return out.Bytes()
}

func seeded(seed, name string) []byte {
	d := sha512.Sum512(framed([]byte(labelValue), []byte(seed), []byte(name)))
	return d[:]
}

func seededScalar(seed, name string) *math.Zr {
	n := new(big.Int).SetBytes(seeded(seed, name))
	n.Mod(n, orderR)
	if n.Sign() == 0 {
		panic("a seed gave the scalar 0")
	}
	return curve.NewZrFromBigInt(n)
}

func seededBytes32(seed, name string) []byte { return seeded(seed, name)[:32] }

type stream struct {
	seed string
	i    uint32
	buf  []byte
}

func (s *stream) Read(p []byte) (int, error) {
	for len(s.buf) < len(p) {
		d := sha512.Sum512(framed([]byte(labelStream), []byte(s.seed), binary.BigEndian.AppendUint32(nil, s.i)))
		s.i++
		s.buf = append(s.buf, d[:]...)
	}
	n := copy(p, s.buf)
	s.buf = s.buf[n:]
	return n, nil
}

var _ io.Reader = (*stream)(nil)

// issuerKey draws an issuer key as Fabric CA's IBM idemix does, from the seed.
func issuerKey(seed string) []byte {
	ix := &idemix.Idemix{Curve: curve, Translator: &amcl.Fp256bn{C: curve}}
	k, err := ix.NewIssuerKey(pseudonym.AttributeNames, &stream{seed: seed}, ix.Translator)
	if err != nil {
		panic(err)
	}
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(k.Ipk)
	if err != nil {
		panic(err)
	}
	return b
}

func h(b []byte) string            { return hex.EncodeToString(b) }
func pt(g *math.G1) string         { return h(pseudonym.EncodePoint(g)) }
func sc(z *math.Zr) string         { return h(pseudonym.EncodeScalar(z)) }
func sha(b []byte) []byte          { d := sha256.Sum256(b); return d[:] }
func must[T any](v T, err error) T { check(err); return v }
func check(err error) {
	if err != nil {
		panic(err)
	}
}

// The file's format. Every byte string is lowercase hex.

type VectorFile struct {
	Description string            `json:"description"`
	Curve       string            `json:"curve"`
	P           string            `json:"p"`
	R           string            `json:"r"`
	Streams     map[string]string `json:"streams"`
	HashToG1    []HashToG1Vector  `json:"hashToG1"`
	Issuers     []IssuerVector    `json:"issuers"`
	Positive    []PositiveVector  `json:"positive"`
	Negative    []NegativeVector  `json:"negative"`
	Counts      map[string]int    `json:"counts"`
}

type HashToG1Vector struct {
	Name       string `json:"name"`
	Input      string `json:"input"`
	Shake256   string `json:"shake256"`
	X0         string `json:"x0"`
	Increments int    `json:"increments"`
	Point      string `json:"point"`
}

type IssuerVector struct {
	Name            string `json:"name"`
	Seed            string `json:"seed"`
	IssuerPublicKey string `json:"issuerPublicKey"`
	IssuerKeyHash   string `json:"issuerKeyHash"`
	HSk             string `json:"HSk"`
	HRand           string `json:"HRand"`
}

type PositiveVector struct {
	Name           string         `json:"name"`
	Issuer         string         `json:"issuer"`
	Seed           string         `json:"seed"`
	Channel        string         `json:"channel"`
	ElectionID     string         `json:"electionId"`
	MspID          string         `json:"mspId"`
	Tracking       string         `json:"tracking"`
	Sk             string         `json:"sk"`
	RNym           string         `json:"rNym"`
	A              string         `json:"a"`
	B              string         `json:"b"`
	Nym            string         `json:"nym"`
	Base           string         `json:"B"`
	P              string         `json:"P"`
	T1             string         `json:"T1"`
	T2             string         `json:"T2"`
	ChallengeInput string         `json:"challengeInput"`
	C              string         `json:"c"`
	SSk            string         `json:"ssk"`
	SR             string         `json:"sr"`
	PseudonymJSON  string         `json:"pseudonymJson"`
	VoterTag       string         `json:"voterTag"`
	Proof          pseudonym.JSON `json:"-"`
}

type NegativeVector struct {
	Name          string `json:"name"`
	Issuer        string `json:"issuer"`
	Channel       string `json:"channel"`
	ElectionID    string `json:"electionId"`
	Tracking      string `json:"tracking"`
	Nym           string `json:"nym"`
	PseudonymJSON string `json:"pseudonymJson"`
	Error         string `json:"error"`
}

// The positive vectors: voter1 twice in chair-2027 with two Nyms (one
// pseudonym), voter1 in chair-2028 (another pseudonym), voter2 in chair-2027.
var positives = []struct{ name, issuer, seed, channel, election, msp string }{
	{"voter1 in chair-2027", "issuer-a", "voter1", "privatevote-chair-2027", "chair-2027", "ChairVoters2027MSP"},
	{"voter1 in chair-2027 with another Nym", "issuer-a", "voter1#2", "privatevote-chair-2027", "chair-2027", "ChairVoters2027MSP"},
	{"voter1 in chair-2028", "issuer-a", "voter1#3", "privatevote-chair-2028", "chair-2028", "ChairVoters2027MSP"},
	{"voter2 in chair-2027", "issuer-a", "voter2", "privatevote-chair-2027", "chair-2027", "ChairVoters2027MSP"},
}

// credentialSeed is the seed of a vector's sk: the part of its seed before
// '#', so that voter1's vectors share one sk.
func credentialSeed(seed string) string {
	if i := bytes.IndexByte([]byte(seed), '#'); i >= 0 {
		return seed[:i]
	}
	return seed
}

func spec256(b []byte) *big.Int { return new(big.Int).SetBytes(b) }

func buildVectors() *VectorFile {
	f := &VectorFile{
		Description: "Test vectors for the per-election pseudonym of a voter credential, version 1, from private-tally-spec.md, The per-election pseudonym. Every byte string is lowercase hex. Written by the pseudonym package's Go tests (go test ./pseudonym -run TestVectorsFile -update) from fixed seeds.",
		Curve:       "FP256BN_AMCL",
		P:           pseudonym.PHex,
		R:           pseudonym.RHex,
		Streams: map[string]string{
			"value":  `OS2IP(SHA-512(frame(["` + labelValue + `", seed, name]))) mod r, for sk (name "sk", from the seed before '#'), rNym, a and b; a tracking code is the first 32 bytes of SHA-512(frame(["` + labelValue + `", seed, "tracking"]))`,
			"issuer": `IBM idemix v0.3.1's NewIssuerKey with Fabric's four attribute names, reading SHA-512(frame(["` + labelStream + `", seed, i])) for i = 0, 1 and so on (i as 4 bytes big-endian), serialised with deterministic protobuf`,
		},
	}

	// HashToG1, step by step as the specification writes it.
	hashInputs := []struct{ name, input string }{
		{"B of chair-2027", h(framed([]byte(pseudonym.LabelScope), []byte("privatevote-chair-2027"), []byte("chair-2027")))},
		{"B of chair-2028", h(framed([]byte(pseudonym.LabelScope), []byte("privatevote-chair-2028"), []byte("chair-2028")))},
		{"the empty string", ""},
		{"abc", h([]byte("abc"))},
	}
	for _, in := range hashInputs {
		m := must(hex.DecodeString(in.input))
		shake, x0, inc, x, y := specHashToG1(m)
		g := curve.HashToG1(m)
		if pt(g) != h(append(pad32(x), pad32(y)...)) {
			panic("HashToG1 isn't what the specification says, for " + in.name)
		}
		f.HashToG1 = append(f.HashToG1, HashToG1Vector{in.name, in.input, h(shake), h(pad32(x0)), inc, pt(g)})
	}

	keys := map[string]*pseudonym.Key{}
	for _, name := range []string{"issuer-a", "issuer-b"} {
		seed := "issuer " + name[len(name)-1:]
		raw := issuerKey(seed)
		k := must(pseudonym.LoadIssuerKey(raw))
		keys[name] = k
		f.Issuers = append(f.Issuers, IssuerVector{name, seed, h(raw), h(sha(raw)), pt(k.HSk), pt(k.HRand)})
	}

	for _, p := range positives {
		k := keys[p.issuer]
		sk := seededScalar(credentialSeed(p.seed), "sk")
		rNym := seededScalar(p.seed, "rNym")
		a, b := seededScalar(p.seed, "a"), seededScalar(p.seed, "b")
		nym := k.HSk.Mul2(sk, k.HRand, rNym)
		tracking := seededBytes32(p.seed, "tracking")
		st := &pseudonym.Statement{Key: k, Channel: p.channel, ElectionID: p.election, Tracking: tracking, Nym: nym}
		proof, tr, err := pseudonym.ProveWith(st, sk, rNym, a, b)
		check(err)
		j := proof.JSON()
		text := string(must(json.Marshal(j)))
		f.Positive = append(f.Positive, PositiveVector{
			Name: p.name, Issuer: p.issuer, Seed: p.seed, Channel: p.channel, ElectionID: p.election, MspID: p.msp,
			Tracking: h(tracking), Sk: sc(sk), RNym: sc(rNym), A: sc(a), B: sc(b),
			Nym: pt(nym), Base: pt(tr.B), P: pt(tr.P), T1: pt(tr.T1), T2: pt(tr.T2),
			ChallengeInput: h(tr.ChallengeInput), C: sc(tr.C), SSk: sc(tr.SSk), SR: sc(tr.SR),
			PseudonymJSON: text, VoterTag: h(tally.VoterTagIdemix(p.channel, p.election, p.msp, pseudonym.EncodePoint(tr.P))),
			Proof: j,
		})
	}
	f.Negative = negatives(f)
	f.Counts = map[string]int{"hashToG1": len(f.HashToG1), "issuers": len(f.Issuers), "positive": len(f.Positive), "negative": len(f.Negative)}
	return f
}

func shake256(m []byte) []byte { return sha3.SumSHAKE256(m, 32) }

func pad32(n *big.Int) []byte { return n.FillBytes(make([]byte, 32)) }

// specHashToG1 is HashToG1 as the specification writes it, with the
// standard library's SHAKE256 and math/big, independent of AMCL:
//
//	x = OS2IP(SHAKE256(m, 32 bytes)) mod p
//	loop: t = x^3 + 3 mod p; if t is a non-zero square, return (x, the even
//	square root); otherwise x = x + 1 mod p
func specHashToG1(m []byte) (shake []byte, x0 *big.Int, increments int, x, y *big.Int) {
	shake = shake256(m)
	x = new(big.Int).Mod(new(big.Int).SetBytes(shake), fieldP)
	x0 = new(big.Int).Set(x)
	exp := new(big.Int).Rsh(new(big.Int).Add(fieldP, big.NewInt(1)), 2) // (p+1)/4
	for {
		t := new(big.Int).Exp(x, big.NewInt(3), fieldP)
		t.Add(t, big.NewInt(3)).Mod(t, fieldP)
		if t.Sign() != 0 {
			r := new(big.Int).Exp(t, exp, fieldP)
			if new(big.Int).Exp(r, big.NewInt(2), fieldP).Cmp(t) == 0 {
				if r.Bit(0) == 1 {
					r.Sub(fieldP, r)
				}
				return shake, x0, increments, x, r
			}
		}
		x.Add(x, big.NewInt(1)).Mod(x, fieldP)
		increments++
	}
}

func encodeVectors(f *VectorFile) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	check(enc.Encode(f))
	return b.Bytes()
}

func TestVectorsFile(t *testing.T) {
	got := encodeVectors(buildVectors())
	if *update {
		check(os.MkdirAll(filepath.Dir(vectorsFile), 0o755))
		check(os.WriteFile(vectorsFile, got, 0o644))
		t.Logf("wrote %s", vectorsFile)
		return
	}
	want, err := os.ReadFile(vectorsFile)
	if err != nil {
		t.Fatalf("read %s: %v (write it with -update)", vectorsFile, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s isn't what the seeds give: regenerate it with -update only after a change to the scheme", vectorsFile)
	}
	// A second run in the same process gives the same bytes.
	if !bytes.Equal(encodeVectors(buildVectors()), got) {
		t.Fatal("two runs gave different vectors")
	}
}

func loadVectors(t *testing.T) *VectorFile {
	t.Helper()
	f := loadVectorsFile()
	if f == nil {
		t.Fatalf("%s doesn't read (write it with -update)", vectorsFile)
	}
	return f
}

func loadVectorsFile() *VectorFile {
	b, err := os.ReadFile(vectorsFile)
	if err != nil {
		return nil
	}
	var f VectorFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil
	}
	return &f
}

func fmtCount(f *VectorFile) string {
	return fmt.Sprintf("%d HashToG1, %d issuers, %d positive, %d negative", len(f.HashToG1), len(f.Issuers), len(f.Positive), len(f.Negative))
}

// negatives are the inputs every verifier must refuse, each with the
// contract's exact message, from the positive vectors changed one way each.
func negatives(f *VectorFile) []NegativeVector {
	v1, v1b, v2 := f.Positive[0], f.Positive[1], f.Positive[3]
	text := func(j pseudonym.JSON) string { return string(must(json.Marshal(j))) }
	from := func(name string, v PositiveVector) NegativeVector {
		return NegativeVector{Name: name, Issuer: v.Issuer, Channel: v.Channel, ElectionID: v.ElectionID, Tracking: v.Tracking, Nym: v.Nym, PseudonymJSON: v.PseudonymJSON, Error: "The pseudonym proof is not valid."}
	}
	changed := func(name string, mod func(*pseudonym.JSON), msg string) NegativeVector {
		j := v1.Proof
		mod(&j)
		n := from(name, v1)
		n.PseudonymJSON, n.Error = text(j), msg
		return n
	}
	addOne := func(s string) string {
		n := new(big.Int).Add(spec256(must(hex.DecodeString(s))), big.NewInt(1))
		return h(pad32(n.Mod(n, orderR)))
	}
	point := func(x, y *big.Int) string { return h(append(pad32(x), pad32(y)...)) }
	notPoint := func(path string) string { return "The pseudonym proof's " + path + " isn't a canonical point." }
	notScalar := func(path string) string { return "The pseudonym proof's " + path + " isn't a canonical scalar." }
	p1 := must(hex.DecodeString(v1.P))
	x1, y1 := spec256(p1[:32]), spec256(p1[32:])

	var out []NegativeVector
	n := from("a proof for another Nym: voter1's proof with voter2's Nym", v1)
	n.Nym = v2.Nym
	out = append(out, n)
	n = from("a proof replayed in another transaction: voter1's proof with the Nym of voter1's next identity", v1)
	n.Nym = v1b.Nym
	out = append(out, n)
	n = from("a proof for another election on the same channel", v1)
	n.ElectionID = "chair-2028"
	out = append(out, n)
	n = from("a proof for another channel", v1)
	n.Channel = "privatevote-chair-2028"
	out = append(out, n)
	n = from("a proof for another ballot's tracking code", v1)
	n.Tracking = v2.Tracking
	out = append(out, n)
	n = from("a proof checked against another issuer key", v1)
	n.Issuer = "issuer-b"
	out = append(out, n)
	out = append(out,
		changed("another voter's pseudonym in voter1's proof", func(j *pseudonym.JSON) { j.Pseudonym = v2.P }, "The pseudonym proof is not valid."),
		changed("a changed c", func(j *pseudonym.JSON) { j.C = addOne(j.C) }, "The pseudonym proof is not valid."),
		changed("a changed ssk", func(j *pseudonym.JSON) { j.SSk = addOne(j.SSk) }, "The pseudonym proof is not valid."),
		changed("a changed sr", func(j *pseudonym.JSON) { j.SR = addOne(j.SR) }, "The pseudonym proof is not valid."),
	)

	// T1' and T2' the identity: answers made so that ssk·HSk + sr·HRand =
	// c·Nym, or ssk·B = c·P.
	order := curve.GroupOrder
	sk, rNym := seededScalar("voter1", "sk"), seededScalar("voter1", "rNym")
	c := seededScalar("identity commitments", "c")
	out = append(out, changed("T1' is the identity", func(j *pseudonym.JSON) {
		// With voter2's P, so that T2' isn't the identity too.
		j.Pseudonym = v2.P
		j.C, j.SSk, j.SR = sc(c), sc(curve.ModMul(c, sk, order)), sc(curve.ModMul(c, rNym, order))
	}, "The pseudonym proof is not valid."))
	kk := seededScalar("identity commitments", "k")
	out = append(out, changed("T2' is the identity", func(j *pseudonym.JSON) {
		j.Pseudonym = pt(pseudonym.Base(v1.Channel, v1.ElectionID).Mul(kk))
		j.C, j.SSk = sc(c), sc(curve.ModMul(c, kk, order))
	}, "The pseudonym proof is not valid."))

	// Decoding, in the order pseudonym, c, ssk, sr.
	out = append(out,
		changed("P off the curve", func(j *pseudonym.JSON) { j.Pseudonym = point(x1, new(big.Int).Add(y1, big.NewInt(1))) }, notPoint("pseudonym")),
		changed("P with x equal to p", func(j *pseudonym.JSON) { j.Pseudonym = point(fieldP, y1) }, notPoint("pseudonym")),
		changed("P with y equal to p", func(j *pseudonym.JSON) { j.Pseudonym = point(x1, fieldP) }, notPoint("pseudonym")),
		changed("P as 64 zero bytes, an attempt at the identity", func(j *pseudonym.JSON) { j.Pseudonym = h(make([]byte, 64)) }, notPoint("pseudonym")),
		changed("P of 63 bytes", func(j *pseudonym.JSON) { j.Pseudonym = j.Pseudonym[:126] }, notPoint("pseudonym")),
		changed("P in uppercase hex", func(j *pseudonym.JSON) { j.Pseudonym = upper(j.Pseudonym) }, notPoint("pseudonym")),
		changed("P with an odd number of hex characters", func(j *pseudonym.JSON) { j.Pseudonym = j.Pseudonym + "0" }, notPoint("pseudonym")),
		changed("c equal to r", func(j *pseudonym.JSON) { j.C = pseudonym.RHex }, notScalar("c")),
		changed("ssk of 2^256 - 1", func(j *pseudonym.JSON) { j.SSk = h(bytes.Repeat([]byte{0xff}, 32)) }, notScalar("ssk")),
		changed("sr equal to r", func(j *pseudonym.JSON) { j.SR = pseudonym.RHex }, notScalar("sr")),
		changed("c in uppercase hex", func(j *pseudonym.JSON) { j.C = upper(j.C) }, notScalar("c")),
		changed("sr of 31 bytes", func(j *pseudonym.JSON) { j.SR = j.SR[:62] }, notScalar("sr")),
		changed("a bad P and a bad c: P first", func(j *pseudonym.JSON) { j.Pseudonym, j.C = "", "" }, notPoint("pseudonym")),
		changed("a bad ssk and a bad sr: ssk first", func(j *pseudonym.JSON) { j.SSk, j.SR = "", "" }, notScalar("ssk")),
	)

	// Parsing, as every other argument is parsed.
	raw := func(name, s, msg string) NegativeVector {
		n := from(name, v1)
		n.PseudonymJSON, n.Error = s, msg
		return n
	}
	q := v1.Proof
	out = append(out,
		raw("not JSON", "pseudonym", "The pseudonym proof isn't JSON."),
		raw("JSON followed by more text", v1.PseudonymJSON+" {}", "The pseudonym proof isn't JSON."),
		raw("null", "null", "The pseudonym proof isn't a JSON object."),
		raw("a list", "[]", "The pseudonym proof isn't a JSON object."),
		raw("unknown fields, the first in byte order named", `{"pseudonym":"`+q.Pseudonym+`","nym":"00","c":"`+q.C+`","ssk":"`+q.SSk+`","sr":"`+q.SR+`","P":"00"}`,
			"The pseudonym proof isn't in the version 1 format: it has an unknown field, P."),
		raw("sr missing", `{"pseudonym":"`+q.Pseudonym+`","c":"`+q.C+`","ssk":"`+q.SSk+`"}`, "The pseudonym proof isn't in the version 1 format: sr is missing."),
		raw("c a number", `{"pseudonym":"`+q.Pseudonym+`","c":1,"ssk":"`+q.SSk+`","sr":"`+q.SR+`"}`, "The pseudonym proof isn't in the version 1 format: c isn't a string."),
		raw("pseudonym null", `{"pseudonym":null,"c":"`+q.C+`","ssk":"`+q.SSk+`","sr":"`+q.SR+`"}`, "The pseudonym proof isn't in the version 1 format: pseudonym isn't a string."),
	)
	return out
}

func upper(s string) string { return string(bytes.ToUpper([]byte(s))) }
