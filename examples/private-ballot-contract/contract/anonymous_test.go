package contract

// Elections with voter credentials: CreateElection with an issuer key, and
// CastAnonymousBallot with real idemix creators. Each creator is built as
// Fabric's idemix MSP serialises one: a SerializedIdentity whose id_bytes
// are a SerializedIdemixIdentity with a new Nym, sk·HSk + rNym·HRand, for a
// credential's secret key, and the ou and role messages the credential
// discloses. Its proof field holds placeholder bytes: the peer checks that
// proof before the contract runs, and the contract doesn't read it. The
// native network run in phase c of ADR 0008's step signs with real
// credentials from Fabric CA.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	idemix "github.com/IBM/idemix/bccsp/schemes/dlog/crypto"
	"github.com/IBM/idemix/bccsp/schemes/dlog/crypto/translator/amcl"
	math "github.com/IBM/mathlib"
	r255 "github.com/gtank/ristretto255"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"google.golang.org/protobuf/proto"

	"github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract/internal/tally"
	"github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract/pseudonym"
)

const votersMSP = "ChairVoters2027MSP"

var fp256bn = math.Curves[math.FP256BN_AMCL]

// scratchIssuer is an idemix issuer key, as fabric-ca-server init makes one.
type scratchIssuer struct {
	raw []byte
	ipk *idemix.IssuerPublicKey
	key *pseudonym.Key
}

func (is *scratchIssuer) b64() string { return base64.StdEncoding.EncodeToString(is.raw) }
func (is *scratchIssuer) hash() string {
	d := sha256.Sum256(is.raw)
	return hex.EncodeToString(d[:])
}

func newIssuer(t *testing.T, names []string) *scratchIssuer {
	tr := &amcl.Fp256bn{C: fp256bn}
	ix := &idemix.Idemix{Curve: fp256bn, Translator: tr}
	k, err := ix.NewIssuerKey(names, rand.Reader, tr)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := proto.Marshal(k.Ipk)
	if err != nil {
		t.Fatal(err)
	}
	is := &scratchIssuer{raw: raw, ipk: k.Ipk}
	if names[len(names)-1] == "RevocationHandle" {
		if is.key, err = pseudonym.LoadIssuerKey(raw); err != nil {
			t.Fatal(err)
		}
	}
	return is
}

var (
	issuersOnce        sync.Once
	issuerA, issuerB   *scratchIssuer
	issuerOtherAttribs *scratchIssuer
)

// issuers returns two issuer keys with Fabric's attribute names, and one
// with other names.
func issuers(t *testing.T) (a, b, other *scratchIssuer) {
	issuersOnce.Do(func() {
		issuerA = newIssuer(t, pseudonym.AttributeNames)
		issuerB = newIssuer(t, pseudonym.AttributeNames)
		issuerOtherAttribs = newIssuer(t, []string{"OU", "Role", "EnrollmentID", "Handle"})
	})
	return issuerA, issuerB, issuerOtherAttribs
}

// credential is a voter credential's secret key and the attributes it
// discloses, from an issuer.
type credential struct {
	is   *scratchIssuer
	sk   *math.Zr
	ou   string
	role msp.MSPRole_MSPRoleType
	msp  string
}

func newCredential(is *scratchIssuer, ou string, role msp.MSPRole_MSPRoleType) *credential {
	return &credential{is: is, sk: fp256bn.NewRandomZr(rand.Reader), ou: ou, role: role, msp: votersMSP}
}

// oneOff is a one-off identity of a credential: the creator, and the Nym
// with its randomness.
type oneOff struct {
	who  identity
	nym  *math.G1
	rNym *math.Zr
}

func (c *credential) identity(t *testing.T) *oneOff {
	t.Helper()
	rNym := fp256bn.NewRandomZr(rand.Reader)
	nym := c.is.key.HSk.Mul2(c.sk, c.is.key.HRand, rNym)
	xy := pseudonym.EncodePoint(nym)
	ou, err := proto.Marshal(&msp.OrganizationUnit{MspIdentifier: c.msp, OrganizationalUnitIdentifier: c.ou, CertifiersIdentifier: c.is.ipk.Hash})
	if err != nil {
		t.Fatal(err)
	}
	role, err := proto.Marshal(&msp.MSPRole{MspIdentifier: c.msp, Role: c.role})
	if err != nil {
		t.Fatal(err)
	}
	idBytes, err := proto.Marshal(&msp.SerializedIdemixIdentity{NymX: xy[:32], NymY: xy[32:], Ou: ou, Role: role, Proof: []byte("the proof the peer's idemix MSP checks")})
	if err != nil {
		t.Fatal(err)
	}
	return &oneOff{who: identity{c.msp, idBytes}, nym: nym, rNym: rNym}
}

// A ballot prover in Go, for these tests only: the contract and
// internal/tally verify, and @weftwallet/tally proves in Weft.

func randomScalar(t *testing.T) *r255.Scalar {
	b := make([]byte, 64)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	s, err := r255.NewScalar().SetUniformBytes(b)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func base(s *r255.Scalar) *r255.Element                   { return r255.NewElement().ScalarBaseMult(s) }
func times(s *r255.Scalar, p *r255.Element) *r255.Element { return r255.NewElement().ScalarMult(s, p) }
func minus(p, q *r255.Element) *r255.Element              { return r255.NewElement().Subtract(p, q) }
func plus(p, q *r255.Element) *r255.Element               { return r255.NewElement().Add(p, q) }
func hexOf(b []byte) string                               { return hex.EncodeToString(b) }

// makeBallot encrypts the choices ms (0 or 1 per option) for the voter tag,
// with the randomness rs where it isn't nil, and proves each slot and the
// sum. A sum other than 1 gets a sum proof that doesn't verify.
func makeBallot(t *testing.T, p *tally.Prepared, id string, tag []byte, ms []int, rs []*r255.Scalar) string {
	t.Helper()
	G := r255.NewGeneratorElement()
	type ct struct{ A, B string }
	type bit struct{ C0, C1, Z0, Z1 string }
	var cts []map[string]string
	var bits []map[string]string
	R := r255.NewScalar()
	A, B := r255.NewIdentityElement(), r255.NewIdentityElement()
	sum := 0
	for j, m := range ms {
		r := randomScalar(t)
		if rs != nil && rs[j] != nil {
			r = rs[j]
		}
		R.Add(R, r)
		sum += m
		a := base(r)
		b := times(r, p.H)
		if m == 1 {
			b = plus(b, G)
		}
		A, B = plus(A, a), plus(B, b)
		// The real branch k = m, the simulated branch 1 - m.
		w := randomScalar(t)
		cs, zs := randomScalar(t), randomScalar(t)
		var A0, B0, A1, B1 *r255.Element
		sim := func(c, z *r255.Scalar, target *r255.Element) (*r255.Element, *r255.Element) {
			return minus(base(z), times(c, a)), minus(times(z, p.H), times(c, target))
		}
		if m == 0 {
			A0, B0 = base(w), times(w, p.H)
			A1, B1 = sim(cs, zs, minus(b, G))
		} else {
			A0, B0 = sim(cs, zs, b)
			A1, B1 = base(w), times(w, p.H)
		}
		c := tally.Hs(tally.LabelBit, p.Ctx, tag, j, a.Bytes(), b.Bytes(), A0.Bytes(), B0.Bytes(), A1.Bytes(), B1.Bytes())
		ck := r255.NewScalar().Subtract(c, cs)
		zk := r255.NewScalar().Add(w, r255.NewScalar().Multiply(ck, r))
		var c0, c1, z0, z1 *r255.Scalar
		if m == 0 {
			c0, z0, c1, z1 = ck, zk, cs, zs
		} else {
			c0, z0, c1, z1 = cs, zs, ck, zk
		}
		cts = append(cts, map[string]string{"a": hexOf(a.Bytes()), "b": hexOf(b.Bytes())})
		bits = append(bits, map[string]string{"c0": hexOf(c0.Bytes()), "c1": hexOf(c1.Bytes()), "z0": hexOf(z0.Bytes()), "z1": hexOf(z1.Bytes())})
	}
	w := randomScalar(t)
	T1, T2 := base(w), times(w, p.H)
	c := tally.Hs(tally.LabelSum, p.Ctx, tag, A.Bytes(), B.Bytes(), T1.Bytes(), T2.Bytes())
	z := r255.NewScalar().Add(w, r255.NewScalar().Multiply(c, R))
	if sum != 1 {
		c, z = randomScalar(t), randomScalar(t)
	}
	b, err := json.Marshal(map[string]any{
		"v": 1, "electionId": id, "ciphertexts": cts, "bitProofs": bits,
		"sumProof": map[string]string{"c": hexOf(c.Bytes()), "z": hexOf(z.Bytes())},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func oneHot(L, choice int) []int {
	ms := make([]int, L)
	ms[choice] = 1
	return ms
}

// anonVote is an anonymous ballot's parts: the identity, the ballot, its
// tracking code, the voter tag and the pseudonym proof.
type anonVote struct {
	from      *oneOff
	ballot    string
	tracking  string
	tag       []byte
	pseudonym string
}

// prepare reads the open election as the verifiers need it.
func prepare(t *testing.T, n *network, id string) (*Record, *tally.Prepared) {
	t.Helper()
	r := record(t, n.get(t, keyElection, id))
	p, err := r.prepared(n.channel)
	if err != nil {
		t.Fatal(err)
	}
	return r, p
}

// proofFor makes the pseudonym proof of a ballot's tracking code for an
// identity, against the issuer key ik.
func (c *credential) proofFor(t *testing.T, n *network, id string, from *oneOff, ik *pseudonym.Key, tracking string) string {
	t.Helper()
	tb, _ := hex.DecodeString(tracking)
	proof, err := pseudonym.Prove(&pseudonym.Statement{Key: ik, Channel: n.channel, ElectionID: id, Tracking: tb, Nym: from.nym}, c.sk, from.rNym, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(proof.JSON())
	return string(b)
}

// vote makes a ballot for the choices, with a new identity, and its proof.
func (c *credential) vote(t *testing.T, n *network, id string, ms []int, rs []*r255.Scalar) *anonVote {
	t.Helper()
	_, p := prepare(t, n, id)
	from := c.identity(t)
	P := pseudonym.EncodePoint(pseudonym.Pseudonym(c.sk, n.channel, id))
	tag := tally.VoterTagIdemix(n.channel, id, c.msp, P)
	ballot := makeBallot(t, p, id, tag, ms, rs)
	d, err := tally.ParseBallot(&p.Setup, ballot)
	if err != nil {
		t.Fatal(err)
	}
	tracking := tally.TrackingCode(p, tag, d)
	return &anonVote{from: from, ballot: ballot, tracking: tracking, tag: tag, pseudonym: c.proofFor(t, n, id, from, c.is.key, tracking)}
}

func (v *anonVote) cast(n *network, id string) *endorsement {
	return n.endorse(v.from.who, "CastAnonymousBallot", id, v.ballot, v.pseudonym)
}

// credentialVoters is CreateElection's voters for voter credentials of votersMSP.
func credentialVoters(is *scratchIssuer, change map[string]any) map[string]any {
	v := map[string]any{
		"kind": "idemix", "msp": votersMSP, "affiliation": "voters", "role": "member",
		"issuerPublicKey": is.b64(), "issuerKeyHash": is.hash(), "curve": "FP256BN_AMCL",
	}
	for k, x := range change {
		if x == nil {
			delete(v, k)
		} else {
			v[k] = x
		}
	}
	return v
}

func TestCreateElectionWithVoterCredentials(t *testing.T) {
	a, b, other := issuers(t)
	n := newNetwork(t, "privatevote-chair-2027")
	org1 := trustee(t, "Org1MSP")
	created := ok(t, n.submit(org1, "CreateElection", newElection(map[string]any{"id": "chair-2027", "voters": credentialVoters(a, nil)})))
	want := `"voters":{"kind":"idemix","msp":"ChairVoters2027MSP","affiliation":"voters","role":"member","issuerPublicKey":"` + a.b64() +
		`","issuerKeyHash":"` + a.hash() + `","curve":"FP256BN_AMCL"},"state":"keygen"}`
	if !strings.HasSuffix(string(created.payload), want) {
		t.Errorf("record %s\nwant it to end %s", created.payload, want)
	}
	eventIs(t, created, "ElectionCreated", `{"electionId":"chair-2027"}`)
	if got := record(t, created.payload).Voters; got.Kind != "idemix" || got.Affiliation != "voters" || got.Msps != nil {
		t.Errorf("voters %+v", got)
	}

	// Go's base64 decoder skips line breaks; the key must be written as
	// base64 writes it.
	nonCanonical := a.b64()[:12] + "\n" + a.b64()[12:]
	cases := []struct {
		voters map[string]any
		want   string
	}{
		{credentialVoters(a, map[string]any{"curve": "BN254"}), "The curve BN254 isn't supported: voter credentials use FP256BN_AMCL."},
		{credentialVoters(a, map[string]any{"curve": "fp256bn_amcl"}), "The curve fp256bn_amcl isn't supported: voter credentials use FP256BN_AMCL."},
		{credentialVoters(a, map[string]any{"affiliation": ""}), "voters.affiliation is empty."},
		{credentialVoters(a, map[string]any{"role": "admin"}), "voters.role isn't member, the only role that can vote."},
		{credentialVoters(a, map[string]any{"role": "Member"}), "voters.role isn't member, the only role that can vote."},
		{credentialVoters(a, map[string]any{"issuerPublicKey": "not base64!"}), "The issuer key isn't an idemix issuer public key for FP256BN_AMCL."},
		{credentialVoters(a, map[string]any{"issuerPublicKey": nonCanonical}), "The issuer key isn't an idemix issuer public key for FP256BN_AMCL."},
		{credentialVoters(a, map[string]any{"issuerPublicKey": base64.StdEncoding.EncodeToString([]byte("an issuer key"))}), "The issuer key isn't an idemix issuer public key for FP256BN_AMCL."},
		{credentialVoters(a, map[string]any{"issuerPublicKey": ""}), "The issuer key isn't an idemix issuer public key for FP256BN_AMCL."},
		{credentialVoters(other, nil), "The issuer key isn't an idemix issuer public key for FP256BN_AMCL."},
		{credentialVoters(a, map[string]any{"issuerKeyHash": b.hash()}), "issuerKeyHash isn't SHA-256 of the issuer key."},
		{credentialVoters(a, map[string]any{"issuerKeyHash": strings.ToUpper(a.hash())}), "issuerKeyHash isn't SHA-256 of the issuer key."},
		{credentialVoters(a, map[string]any{"issuerKeyHash": ""}), "issuerKeyHash isn't SHA-256 of the issuer key."},
		// In order: the curve, the affiliation, the role, the key, the hash.
		{credentialVoters(a, map[string]any{"curve": "BN254", "affiliation": "", "role": "admin"}), "The curve BN254 isn't supported: voter credentials use FP256BN_AMCL."},
		{credentialVoters(a, map[string]any{"affiliation": "", "role": "admin"}), "voters.affiliation is empty."},
		{credentialVoters(a, map[string]any{"role": "admin", "issuerPublicKey": "x"}), "voters.role isn't member, the only role that can vote."},
		{credentialVoters(a, map[string]any{"issuerPublicKey": "x", "issuerKeyHash": "x"}), "The issuer key isn't an idemix issuer public key for FP256BN_AMCL."},
		// The voters are checked last, after the threshold.
		{credentialVoters(a, map[string]any{"curve": "BN254", "threshold": nil}), "The curve BN254 isn't supported: voter credentials use FP256BN_AMCL."},
		// The kind chooses the fields, in the documented order.
		{credentialVoters(a, map[string]any{"affiliation": nil, "role": nil}), "The election isn't in the version 1 format: voters.affiliation is missing."},
		{credentialVoters(a, map[string]any{"role": nil}), "The election isn't in the version 1 format: voters.role is missing."},
		{credentialVoters(a, map[string]any{"role": 1}), "The election isn't in the version 1 format: voters.role isn't a number."},
		{credentialVoters(a, map[string]any{"msps": []string{"Org1MSP"}}), "The election isn't in the version 1 format: it has an unknown field, voters.msps."},
		{credentialVoters(a, map[string]any{"msp": nil}), "The election isn't in the version 1 format: voters.msp is missing."},
	}
	for i, c := range cases {
		delete(c.voters, "threshold")
		got := n.endorse(org1, "CreateElection", newElection(map[string]any{"id": fmt.Sprintf("x%d", i), "voters": c.voters}))
		refused(t, got, strings.Replace(c.want, "isn't a number.", "isn't a string.", 1))
	}
	// The threshold is checked before the voters.
	refused(t, n.endorse(org1, "CreateElection", newElection(map[string]any{"id": "y", "threshold": 3, "voters": credentialVoters(a, map[string]any{"curve": "BN254"})})),
		"The threshold must be from 2 to the number of trustees.")
}

// chair opens the budget-2027 vector's election with voter credentials
// from the issuer key is.
func chair(t *testing.T, is *scratchIssuer) (*vectors, *network, string) {
	v := loadVectors(t)
	n := ceremonyWith(t, v, "budget-2027", 4, credentialVoters(is, nil))
	return v, n, v.elections["budget-2027"].ElectionID
}

func TestCastAnonymousBallot(t *testing.T) {
	a, _, _ := issuers(t)
	_, n, id := chair(t, a)
	L := len(record(t, n.get(t, keyElection, id)).Options)
	voter1 := newCredential(a, "voters", msp.MSPRole_MEMBER)
	voter2 := newCredential(a, "voters", msp.MSPRole_MEMBER)

	first := voter1.vote(t, n, id, oneHot(L, 0), nil)
	cast := ok(t, n.submit(first.from.who, "CastAnonymousBallot", id, first.ballot, first.pseudonym))
	if want := fmt.Sprintf(`{"electionId":%q,"txId":%q,"tracking":%q}`, id, cast.txID, first.tracking); string(cast.payload) != want {
		t.Errorf("result %s, want %s", cast.payload, want)
	}
	eventIs(t, cast, "BallotCast", fmt.Sprintf(`{"electionId":%q,"tracking":%q}`, id, first.tracking))
	if string(n.get(t, keyVoted, id, hexOf(first.tag))) != cast.txID {
		t.Error("the voted marker isn't at the voter tag made from P")
	}
	// GetBallot returns the stored pseudonym proof, in the format's order.
	got := ok(t, n.submit(member(t, "Org2MSP"), "GetBallot", id, first.tracking))
	if !strings.HasSuffix(string(got.payload), `,"pseudonym":`+first.pseudonym+`}`) {
		t.Errorf("GetBallot gave %s", got.payload)
	}

	// The same credential, with a new identity and a new ballot, has the
	// same pseudonym, so the same voter tag.
	again := voter1.vote(t, n, id, oneHot(L, 1), nil)
	if again.from.who.msp != first.from.who.msp || string(again.from.who.idBytes) == string(first.from.who.idBytes) {
		t.Fatal("the second identity should have a new Nym")
	}
	refused(t, again.cast(n, id), "This credential has already voted in this election.")

	second := voter2.vote(t, n, id, oneHot(L, 2), nil)
	ok(t, n.submit(second.from.who, "CastAnonymousBallot", id, second.ballot, second.pseudonym))

	// Closing adds both ballots up.
	ok(t, n.submit(trustee(t, "Org1MSP"), "CloseElection", id))
	closed := record(t, ok(t, n.submit(trustee(t, "Org2MSP"), "CloseElection", id)).payload)
	if closed.State != stateDecrypting || *closed.Ballots != 2 {
		t.Fatalf("closed with %v ballots in %s", closed.Ballots, closed.State)
	}
	refused(t, voter2.vote(t, n, id, oneHot(L, 0), nil).cast(n, id), "Voting has closed.")
}

func TestCastAnonymousBallotRefusals(t *testing.T) {
	a, b, _ := issuers(t)
	_, n, id := chair(t, a)
	L := len(record(t, n.get(t, keyElection, id)).Options)
	voter1 := newCredential(a, "voters", msp.MSPRole_MEMBER)
	voter2 := newCredential(a, "voters", msp.MSPRole_MEMBER)
	r0 := randomScalar(t)
	firstR := make([]*r255.Scalar, L)
	firstR[0] = r0
	earlier := voter1.vote(t, n, id, oneHot(L, 0), firstR)
	ok(t, n.submit(earlier.from.who, "CastAnonymousBallot", id, earlier.ballot, earlier.pseudonym))
	notValid := "The pseudonym proof is not valid."

	// 3. The creator's MSP ID is the voter MSP.
	refused(t, n.endorse(member(t, "Org1MSP"), "CastAnonymousBallot", id, earlier.ballot, earlier.pseudonym),
		"This identity can't vote in this election: Org1MSP isn't one of its voter organisations.")
	elsewhere := newCredential(a, "voters", msp.MSPRole_MEMBER)
	elsewhere.msp = "OtherVotersMSP"
	refused(t, elsewhere.vote(t, n, id, oneHot(L, 0), nil).cast(n, id),
		"This identity can't vote in this election: OtherVotersMSP isn't one of its voter organisations.")

	// 4. An idemix identity with a Nym on the curve.
	for name, who := range map[string]identity{
		"an X.509 identity of the voter MSP": {votersMSP, certificate(t, votersMSP, "admin", nil)},
		"bytes that aren't an identity":      idemixCreator(votersMSP),
		"no id_bytes":                        {votersMSP, nil},
		"a Nym off the curve":                nymOff(t, voter2),
		"a Nym of 31-byte coordinates":       nymShort(t, voter2),
	} {
		got := n.endorse(who, "CastAnonymousBallot", id, "{}", "{}")
		if got.err != "This identity can't vote in this election: it isn't a voter credential." {
			t.Errorf("%s: %q", name, got.err)
		}
	}

	// 5. Its organisational unit is the affiliation, and its role member;
	// the affiliation first.
	for _, c := range []struct {
		ou   string
		role msp.MSPRole_MSPRoleType
		want string
	}{
		{"org1", msp.MSPRole_MEMBER, "This credential can't vote in this election: its affiliation isn't voters."},
		{"", msp.MSPRole_MEMBER, "This credential can't vote in this election: its affiliation isn't voters."},
		{"voters.department1", msp.MSPRole_MEMBER, "This credential can't vote in this election: its affiliation isn't voters."},
		{"voters", msp.MSPRole_ADMIN, "This credential can't vote in this election: its role isn't member."},
		{"", msp.MSPRole_ADMIN, "This credential can't vote in this election: its affiliation isn't voters."},
	} {
		cred := newCredential(a, c.ou, c.role)
		refused(t, cred.vote(t, n, id, oneHot(L, 0), nil).cast(n, id), c.want)
	}
	// The caller is checked before any argument is parsed.
	refused(t, n.endorse(newCredential(a, "org1", msp.MSPRole_MEMBER).identity(t).who, "CastAnonymousBallot", id, "not json", "not json"),
		"This credential can't vote in this election: its affiliation isn't voters.")

	v := voter2.vote(t, n, id, oneHot(L, 1), nil)
	// 6. The ballot, before the pseudonym proof.
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, "not json", "not json"), "The ballot isn't JSON.")
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, strings.Replace(v.ballot, `"v":1`, `"v":2`, 1), v.pseudonym), "The ballot isn't for this election.")
	// 7. The pseudonym proof parses and decodes.
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, v.ballot, "not json"), "The pseudonym proof isn't JSON.")
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, v.ballot, "null"), "The pseudonym proof isn't a JSON object.")
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, v.ballot, `{"pseudonym":"00"}`), "The pseudonym proof isn't in the version 1 format: c is missing.")
	var j pseudonym.JSON
	if err := json.Unmarshal([]byte(v.pseudonym), &j); err != nil {
		t.Fatal(err)
	}
	with := func(change func(*pseudonym.JSON)) string {
		k := j
		change(&k)
		b, _ := json.Marshal(k)
		return string(b)
	}
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, v.ballot, with(func(k *pseudonym.JSON) { k.Pseudonym = strings.Repeat("0", 128) })),
		"The pseudonym proof's pseudonym isn't a canonical point.")
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, v.ballot, with(func(k *pseudonym.JSON) { k.SR = pseudonym.RHex })),
		"The pseudonym proof's sr isn't a canonical scalar.")

	// 9. The pseudonym proof, before the ballot's proofs.
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, v.ballot, with(func(k *pseudonym.JSON) { k.SSk = j.SR })), notValid)
	// A proof for another ballot of the same voter.
	other := voter2.vote(t, n, id, oneHot(L, 2), nil)
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, v.ballot, other.pseudonym), notValid)
	// A proof replayed under another identity of the same credential.
	refused(t, n.endorse(other.from.who, "CastAnonymousBallot", id, v.ballot, v.pseudonym), notValid)
	// voter1's ballot with its pseudonym, copied into voter2's transaction:
	// the pseudonym proof's message, whatever else is wrong.
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, earlier.ballot, earlier.pseudonym), notValid)
	// voter2 claiming voter1's pseudonym under its own Nym.
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, v.ballot, with(func(k *pseudonym.JSON) {
		var e pseudonym.JSON
		_ = json.Unmarshal([]byte(earlier.pseudonym), &e)
		k.Pseudonym = e.Pseudonym
	})), notValid)
	// A proof against another issuer key.
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, v.ballot, voter2.proofFor(t, n, id, v.from, b.key, v.tracking)), notValid)
	// A proof for another election's B.
	tb, _ := hex.DecodeString(v.tracking)
	elsewhereProof, err := pseudonym.Prove(&pseudonym.Statement{Key: a.key, Channel: n.channel, ElectionID: "chair-2028", Tracking: tb, Nym: v.from.nym}, voter2.sk, v.from.rNym, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ej, _ := json.Marshal(elsewhereProof.JSON())
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, v.ballot, string(ej)), notValid)

	// 10. The bit proofs, with a ballot made for another voter tag but a
	// pseudonym proof for the tracking code with this voter's tag.
	_, p := prepare(t, n, id)
	wrongTag := makeBallot(t, p, id, make([]byte, 32), oneHot(L, 0), nil)
	refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, wrongTag, proofOverBallot(t, n, id, voter2, v.from, p, v.tag, wrongTag)), "Ciphertext 0 is not a 0 or a 1.")
	// 11. The sum proof.
	two := make([]int, L)
	two[0], two[1] = 1, 1
	twice := voter2.vote(t, n, id, two, nil)
	refused(t, twice.cast(n, id), "The ballot does not choose exactly one option.")
	// 12. Repeated ciphertexts, in the ballot and on the ledger.
	r := randomScalar(t)
	repeats := make([]*r255.Scalar, L)
	repeats[0], repeats[1] = r, r
	refused(t, voter2.vote(t, n, id, oneHot(L, 0), repeats).cast(n, id), "Ciphertexts 0 and 1 have the same randomness.")
	var stored ballotDoc
	if err := json.Unmarshal([]byte(earlier.ballot), &stored); err != nil {
		t.Fatal(err)
	}
	// The same randomness and choice as voter1's first ciphertext.
	reused := voter2.vote(t, n, id, oneHot(L, 0), firstR)
	if !strings.Contains(reused.ballot, stored.Ciphertexts[0].A) {
		t.Fatal("the reused ciphertext isn't in the ballot")
	}
	refused(t, reused.cast(n, id), "A ciphertext in this ballot is already on the ledger.")
	// 13. And voter2's honest ballot is accepted.
	ok(t, n.submit(v.from.who, "CastAnonymousBallot", id, v.ballot, v.pseudonym))
}

// proofOverBallot proves the pseudonym for a ballot's tracking code made
// with the given voter tag.
func proofOverBallot(t *testing.T, n *network, id string, c *credential, from *oneOff, p *tally.Prepared, tag []byte, ballot string) string {
	d, err := tally.ParseBallot(&p.Setup, ballot)
	if err != nil {
		t.Fatal(err)
	}
	return c.proofFor(t, n, id, from, c.is.key, tally.TrackingCode(p, tag, d))
}

// nymOff is a creator whose Nym is a point off the curve.
func nymOff(t *testing.T, c *credential) identity {
	o := c.identity(t)
	sid := &msp.SerializedIdemixIdentity{}
	if err := proto.Unmarshal(o.who.idBytes, sid); err != nil {
		t.Fatal(err)
	}
	sid.NymY = append([]byte{}, sid.NymY...)
	sid.NymY[31] ^= 1
	b, _ := proto.Marshal(sid)
	return identity{o.who.msp, b}
}

// nymShort is a creator whose Nym's coordinates are 31 bytes.
func nymShort(t *testing.T, c *credential) identity {
	o := c.identity(t)
	sid := &msp.SerializedIdemixIdentity{}
	if err := proto.Unmarshal(o.who.idBytes, sid); err != nil {
		t.Fatal(err)
	}
	sid.NymX, sid.NymY = sid.NymX[1:], sid.NymY[1:]
	b, _ := proto.Marshal(sid)
	return identity{o.who.msp, b}
}

// CastBallot in an election with voter credentials, from any identity.
func TestCastBallotInAnElectionWithVoterCredentials(t *testing.T) {
	a, _, _ := issuers(t)
	_, n, id := chair(t, a)
	L := len(record(t, n.get(t, keyElection, id)).Options)
	voter := newCredential(a, "voters", msp.MSPRole_MEMBER)
	v := voter.vote(t, n, id, oneHot(L, 0), nil)
	for _, who := range []identity{v.from.who, member(t, "Org1MSP"), {votersMSP, certificate(t, votersMSP, "voter", nil)}} {
		refused(t, n.endorse(who, "CastBallot", id, v.ballot), "This election has voter credentials, so its ballots are cast with CastAnonymousBallot.")
	}
	// And in keygen, the state comes first.
	v2 := loadVectors(t)
	keygen := ceremonyWith(t, v2, "budget-2027", 0, credentialVoters(a, nil))
	refused(t, keygen.endorse(v.from.who, "CastAnonymousBallot", id, v.ballot, v.pseudonym), "The election isn't open: it is in keygen.")
	refused(t, keygen.endorse(v.from.who, "CastBallot", id, v.ballot), "The election isn't open: it is in keygen.")
}

// One credential votes once in each of two elections, with a pseudonym in
// each that the other election can't link.
func TestOneCredentialInTwoElections(t *testing.T) {
	a, _, _ := issuers(t)
	v := loadVectors(t)
	voter := newCredential(a, "voters", msp.MSPRole_MEMBER)
	var tags []string
	for _, name := range []string{"budget-2027", "council-2027"} {
		n := ceremonyWith(t, v, name, 4, credentialVoters(a, nil))
		id := v.elections[name].ElectionID
		L := len(record(t, n.get(t, keyElection, id)).Options)
		cast := voter.vote(t, n, id, oneHot(L, 0), nil)
		ok(t, n.submit(cast.from.who, "CastAnonymousBallot", id, cast.ballot, cast.pseudonym))
		refused(t, voter.vote(t, n, id, oneHot(L, 1), nil).cast(n, id), "This credential has already voted in this election.")
		var j pseudonym.JSON
		_ = json.Unmarshal([]byte(cast.pseudonym), &j)
		tags = append(tags, hexOf(cast.tag), j.Pseudonym)
	}
	if tags[0] == tags[2] || tags[1] == tags[3] {
		t.Error("one credential has the same pseudonym or voter tag in two elections")
	}
}

// A voter credential, as a real idemix creator, can't act as a trustee,
// open the election or publish the tally.
func TestVoterCredentialsAreOnlyForBallots(t *testing.T) {
	a, _, _ := issuers(t)
	v := loadVectors(t)
	e := v.elections["budget-2027"]
	c := v.ceremonies["budget-2027"]
	voter := newCredential(a, "voters", msp.MSPRole_MEMBER).identity(t).who
	// A credential of an idemix organisation that calls itself Org1MSP.
	claims := newCredential(a, "voters", msp.MSPRole_ADMIN)
	claims.msp = "Org1MSP"
	org1 := claims.identity(t).who
	n := ceremonyWith(t, v, "budget-2027", 0, credentialVoters(a, nil))
	id := e.ElectionID
	refused(t, n.endorse(voter, "CreateElection", electionJSONWith(e, credentialVoters(a, nil))), "ChairVoters2027MSP isn't one of the trustee organisations named in this election.")
	refused(t, n.endorse(org1, "CreateElection", newElection(map[string]any{"id": "other"})), "This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.")
	for _, fn := range []string{"PostCommitments", "PostShares", "ConfirmShares", "ReportBadShare"} {
		refused(t, n.endorse(voter, fn, id, c.Trustees[0].Round1.JSON), "ChairVoters2027MSP isn't a trustee of this election.")
		refused(t, n.endorse(org1, fn, id, c.Trustees[0].Round1.JSON), "This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.")
	}
	refused(t, n.endorse(voter, "CancelElection", id), "ChairVoters2027MSP didn't create this election, so it can't cancel it.")
	refused(t, n.endorse(org1, "CancelElection", id), "This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.")
	refused(t, n.endorse(voter, "OpenElection", id), "This identity can't open the election: it isn't an X.509 identity.")
	opened := ceremonyWith(t, v, "budget-2027", 4, credentialVoters(a, nil))
	refused(t, opened.endorse(voter, "CloseElection", id), "ChairVoters2027MSP isn't a trustee of this election.")
	refused(t, opened.endorse(org1, "CloseElection", id), "This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.")
	refused(t, opened.endorse(voter, "PublishTally", id), "This identity can't publish the tally: it isn't an X.509 identity.")
	// Readers answer anyone who can read the channel.
	ok(t, opened.submit(voter, "GetElection", id))
	ok(t, opened.submit(voter, "GetCeremony", id))
}
