package tally

import (
	"bytes"
	"crypto/sha512"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	r255 "github.com/gtank/ristretto255"
)

// The vectors @weftwallet/tally writes, read by relative path from the
// repository's root.
var vectorsDir = filepath.Join("..", "..", "..", "..", "packages", "tally", "vectors", "v1")

func load(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(vectorsDir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
}

func hx(t *testing.T, s string) []byte {
	t.Helper()
	b, ok := FromHex(s, -1)
	if !ok {
		t.Fatalf("bad hex in a vector: %q", s)
	}
	return b
}

type electionVector struct {
	Name string `json:"name"`
	Setup
	Keys
	ContextInput     string `json:"contextInput"`
	Ctx              string `json:"ctx"`
	FingerprintInput string `json:"fingerprintInput"`
	Fingerprint      string `json:"fingerprint"`
}

func elections(t *testing.T) map[string]*Prepared { return allElections(t) }

type part struct {
	String *string `json:"string"`
	Int    *int    `json:"int"`
	Bytes  *string `json:"bytes"`
}

func parts(t *testing.T, ps []part) []any {
	out := []any{}
	for _, p := range ps {
		switch {
		case p.String != nil:
			out = append(out, *p.String)
		case p.Int != nil:
			out = append(out, *p.Int)
		default:
			out = append(out, hx(t, *p.Bytes))
		}
	}
	return out
}

func TestFraming(t *testing.T) {
	var v struct {
		Frame []struct {
			Parts  []part `json:"parts"`
			Framed string `json:"framed"`
		} `json:"frame"`
		ExpandMessageXmd []struct {
			Msg    string `json:"msg"`
			DST    string `json:"dst"`
			Length int    `json:"length"`
			Output string `json:"output"`
		} `json:"expandMessageXmd"`
		Hs []struct {
			Label  string `json:"label"`
			Parts  []part `json:"parts"`
			Input  string `json:"input"`
			Xmd    string `json:"xmd"`
			Scalar string `json:"scalar"`
		} `json:"hs"`
	}
	load(t, "framing.json", &v)
	for _, c := range v.Frame {
		if got := ToHex(Frame(parts(t, c.Parts)...)); got != c.Framed {
			t.Errorf("frame: got %s, want %s", got, c.Framed)
		}
	}
	for _, c := range v.ExpandMessageXmd {
		if got := ToHex(ExpandMessageXMD(hx(t, c.Msg), []byte(c.DST), c.Length)); got != c.Output {
			t.Errorf("expand_message_xmd(%q, %q, %d): got %s, want %s", c.Msg, c.DST, c.Length, got, c.Output)
		}
	}
	for _, c := range v.Hs {
		ps := parts(t, c.Parts)
		if got := ToHex(Frame(append([]any{c.Label}, ps...)...)); got != c.Input {
			t.Errorf("Hs input: got %s", got)
		}
		if got := ToHex(ChallengeBytes(c.Label, ps...)); got != c.Xmd {
			t.Errorf("Hs xmd: got %s", got)
		}
		if got := scalarHex(Hs(c.Label, ps...)); got != c.Scalar {
			t.Errorf("Hs: got %s, want %s", got, c.Scalar)
		}
	}
	if len(v.Frame) == 0 || len(v.ExpandMessageXmd) == 0 || len(v.Hs) == 0 {
		t.Fatal("framing.json is missing cases")
	}
}

func TestContextAndTags(t *testing.T) {
	var v struct {
		Elections []electionVector `json:"elections"`
		VoterTags []struct {
			Channel    string `json:"channel"`
			ElectionID string `json:"electionId"`
			Kind       string `json:"kind"`
			MspID      string `json:"mspId"`
			IDBytes    string `json:"idBytes"`
			Pseudonym  string `json:"pseudonym"`
			Input      string `json:"input"`
			Tag        string `json:"tag"`
		} `json:"voterTags"`
	}
	load(t, "context.json", &v)
	for _, c := range v.Elections {
		e := &Election{Setup: c.Setup, Keys: c.Keys}
		if got := ToHex(Frame(append([]any{LabelContext}, ContextParts(e)...)...)); got != c.ContextInput {
			t.Errorf("%s: context input differs", c.Name)
		}
		if got := ToHex(Context(e)); got != c.Ctx {
			t.Errorf("%s: ctx %s, want %s", c.Name, got, c.Ctx)
		}
		if got := ToHex(FingerprintInput(e)); got != c.FingerprintInput {
			t.Errorf("%s: fingerprint input differs", c.Name)
		}
		if got := Fingerprint(e); got != c.Fingerprint {
			t.Errorf("%s: fingerprint %s, want %s", c.Name, got, c.Fingerprint)
		}
	}
	for _, c := range v.VoterTags {
		var tag []byte
		if c.Kind == "x509" {
			tag = VoterTagX509(c.Channel, c.ElectionID, c.MspID, hx(t, c.IDBytes))
		} else {
			tag = VoterTagIdemix(c.Channel, c.ElectionID, c.MspID, hx(t, c.Pseudonym))
		}
		if ToHex(tag) != c.Tag {
			t.Errorf("voter tag for %s in %s: got %s, want %s", c.MspID, c.ElectionID, ToHex(tag), c.Tag)
		}
	}
}

func TestCeremony(t *testing.T) {
	ps := elections(t)
	var v struct {
		Ceremonies []struct {
			Election string `json:"election"`
			Trustees []struct {
				Index  int `json:"index"`
				Round1 struct {
					JSON           string `json:"json"`
					ProofR         string `json:"proofR"`
					ProofZ         string `json:"proofZ"`
					ChallengeInput string `json:"challengeInput"`
					Challenge      string `json:"challenge"`
				} `json:"round1"`
				Round2 struct {
					JSON string `json:"json"`
				} `json:"round2"`
				Round3 struct {
					JSON string `json:"json"`
				} `json:"round3"`
			} `json:"trustees"`
			PublicKey       string   `json:"publicKey"`
			VerifyingShares []string `json:"verifyingShares"`
			Ctx             string   `json:"ctx"`
			Fingerprint     string   `json:"fingerprint"`
		} `json:"ceremonies"`
	}
	load(t, "ceremony.json", &v)
	for _, c := range v.Ceremonies {
		p := ps[c.Election]
		var r1 []*Round1
		for _, tr := range c.Trustees {
			r, err := CheckRound1(&p.Setup, tr.Index, tr.Round1.JSON)
			if err != nil {
				t.Fatalf("%s round 1 from %d: %v", c.Election, tr.Index, err)
			}
			if pointHex(r.R) != tr.Round1.ProofR || scalarHex(r.Z) != tr.Round1.ProofZ {
				t.Errorf("%s: proof of knowledge decodes differently", c.Election)
			}
			if got := scalarHex(Round1Challenge(tr.Index, r.Commitments[0], r.R)); got != tr.Round1.Challenge {
				t.Errorf("%s: round 1 challenge %s, want %s", c.Election, got, tr.Round1.Challenge)
			}
			in := bytes.Join([][]byte{[]byte(dkgPrefix), TrusteeID(tr.Index), r.Commitments[0].Bytes(), r.R.Bytes()}, nil)
			if ToHex(in) != tr.Round1.ChallengeInput {
				t.Errorf("%s: round 1 challenge input differs", c.Election)
			}
			if sum := sha512.Sum512(in); scalarHex(mustUniform(sum[:])) != tr.Round1.Challenge {
				t.Errorf("%s: SHA-512 of the challenge input isn't the challenge", c.Election)
			}
			if err := CheckRound2(&p.Setup, tr.Index, tr.Round2.JSON); err != nil {
				t.Errorf("%s round 2 from %d: %v", c.Election, tr.Index, err)
			}
			r1 = append(r1, r)
		}
		keys := ElectionKeys(&p.Setup, r1)
		if keys.PublicKey != c.PublicKey || !reflect.DeepEqual(keys.VerifyingShares, c.VerifyingShares) {
			t.Fatalf("%s: keys differ", c.Election)
		}
		if ToHex(p.Ctx) != c.Ctx || Fingerprint(p.Election) != c.Fingerprint {
			t.Errorf("%s: ctx or fingerprint differs", c.Election)
		}
		for _, tr := range c.Trustees {
			if err := CheckConfirmation(p, tr.Index, tr.Round3.JSON); err != nil {
				t.Errorf("%s confirmation from %d: %v", c.Election, tr.Index, err)
			}
		}
	}
}

type ballotVector struct {
	Election string `json:"election"`
	Voter    struct {
		Kind string `json:"kind"`
		Tag  string `json:"tag"`
	} `json:"voter"`
	Ballot struct {
		Ciphertexts []Ciphertext `json:"ciphertexts"`
	} `json:"ballot"`
	JSON     string     `json:"json"`
	Trace    ProofTrace `json:"trace"`
	Tracking string     `json:"tracking"`
}

type mapLedger struct{ ciphertexts, voted map[string]bool }

func (l mapLedger) HasCiphertext(a string) bool { return l.ciphertexts[a] }
func (l mapLedger) HasVoted(tag string) bool    { return l.voted[tag] }

func newLedger(cts, voted []string) mapLedger {
	l := mapLedger{map[string]bool{}, map[string]bool{}}
	for _, a := range cts {
		l.ciphertexts[a] = true
	}
	for _, v := range voted {
		l.voted[v] = true
	}
	return l
}

func TestBallots(t *testing.T) {
	ps := elections(t)
	var v struct {
		Ballots []ballotVector `json:"ballots"`
	}
	load(t, "ballots.json", &v)
	ledger := newLedger(nil, nil)
	for i, b := range v.Ballots {
		got, err := CheckBallot(ps[b.Election], hx(t, b.Voter.Tag), b.JSON, ledger, b.Voter.Kind == "idemix")
		if err != nil {
			t.Fatalf("ballot %d in %s refused: %v", i, b.Election, err)
		}
		if !reflect.DeepEqual(*got.Trace, b.Trace) {
			t.Errorf("ballot %d: commitments differ\n got %+v\nwant %+v", i, *got.Trace, b.Trace)
		}
		if got.Tracking != b.Tracking {
			t.Errorf("ballot %d: tracking %s, want %s", i, got.Tracking, b.Tracking)
		}
		for _, ct := range got.Ballot.Ciphertexts {
			ledger.ciphertexts[ct.A] = true
		}
		ledger.voted[b.Voter.Tag] = true
	}
	if len(v.Ballots) == 0 {
		t.Fatal("no ballots")
	}
}

func TestTracking(t *testing.T) {
	ps := elections(t)
	var v struct {
		Tracking []struct {
			Election string `json:"election"`
			VoterTag string `json:"voterTag"`
			JSON     string `json:"json"`
			Input    string `json:"input"`
			Tracking string `json:"tracking"`
		} `json:"tracking"`
	}
	load(t, "tracking.json", &v)
	for _, c := range v.Tracking {
		p := ps[c.Election]
		d, err := ParseBallot(&p.Setup, c.JSON)
		if err != nil {
			t.Fatal(err)
		}
		in := []any{LabelTracking, p.Ctx, hx(t, c.VoterTag)}
		for _, r := range d.raw {
			in = append(in, r)
		}
		if ToHex(Frame(in...)) != c.Input {
			t.Errorf("%s: tracking input differs", c.Election)
		}
		if got := TrackingCode(p, hx(t, c.VoterTag), d); got != c.Tracking {
			t.Errorf("%s: tracking %s, want %s", c.Election, got, c.Tracking)
		}
	}
}

func TestSharesAndTally(t *testing.T) {
	ps := elections(t)
	var sv struct {
		Totals []struct {
			Election string       `json:"election"`
			Totals   []Ciphertext `json:"totals"`
			Ballots  int          `json:"ballots"`
		} `json:"totals"`
		Shares []struct {
			Election string          `json:"election"`
			Index    int             `json:"index"`
			Share    DecryptionShare `json:"share"`
			JSON     string          `json:"json"`
		} `json:"shares"`
	}
	load(t, "shares.json", &sv)
	var bv struct {
		Ballots []ballotVector `json:"ballots"`
	}
	load(t, "ballots.json", &bv)
	totals := map[string][]Ciphertext{}
	for _, tot := range sv.Totals {
		var cts [][]Ciphertext
		for _, b := range bv.Ballots {
			if b.Election == tot.Election {
				cts = append(cts, b.Ballot.Ciphertexts)
			}
		}
		got, n, err := AddTotals(len(ps[tot.Election].Options), cts)
		if err != nil || n != tot.Ballots || !reflect.DeepEqual(got, tot.Totals) {
			t.Errorf("%s: totals differ (%v)", tot.Election, err)
		}
		totals[tot.Election] = tot.Totals
	}
	shares := map[string]map[int]DecryptionShare{}
	for _, s := range sv.Shares {
		got, err := CheckDecryptionShare(ps[s.Election], totals[s.Election], s.Index, s.JSON)
		if err != nil {
			t.Fatalf("%s share from %d: %v", s.Election, s.Index, err)
		}
		if !reflect.DeepEqual(*got, s.Share) {
			t.Errorf("%s share from %d parses differently", s.Election, s.Index)
		}
		if shares[s.Election] == nil {
			shares[s.Election] = map[int]DecryptionShare{}
		}
		shares[s.Election][s.Index] = s.Share
	}
	var tv struct {
		Tally []struct {
			Election string       `json:"election"`
			Ballots  int          `json:"ballots"`
			Totals   []Ciphertext `json:"totals"`
			Posted   []int        `json:"posted"`
			TallyResult
		} `json:"tally"`
	}
	load(t, "tally.json", &tv)
	for _, c := range tv.Tally {
		var posted []PostedShare
		for _, i := range c.Posted {
			posted = append(posted, PostedShare{Index: i, Share: shares[c.Election][i]})
		}
		got, err := RecoverTally(ps[c.Election], c.Totals, c.Ballots, posted)
		if err != nil {
			t.Fatalf("%s tally from %v: %v", c.Election, c.Posted, err)
		}
		if !reflect.DeepEqual(*got, c.TallyResult) {
			t.Errorf("%s tally from %v:\n got %+v\nwant %+v", c.Election, c.Posted, *got, c.TallyResult)
		}
	}
}

type negativeVector struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Election string `json:"election"`
	Error    string `json:"error"`
	// ballot
	VoterTag string `json:"voterTag"`
	Voter    string `json:"voter"`
	Ledger   struct {
		Ciphertexts []string `json:"ciphertexts"`
		Voted       []string `json:"voted"`
	} `json:"ledger"`
	JSON string `json:"json"`
	// ceremony and shares
	Index  int          `json:"index"`
	Totals []Ciphertext `json:"totals"`
	// tally
	Ballots int           `json:"ballots"`
	Posted  []PostedShare `json:"posted"`
}

func TestNegative(t *testing.T) {
	ps := elections(t)
	var v struct {
		Negative []negativeVector `json:"negative"`
	}
	load(t, "negative.json", &v)
	kinds := map[string]int{}
	for _, c := range v.Negative {
		p := ps[c.Election]
		var err error
		switch c.Kind {
		case "ballot":
			_, err = CheckBallot(p, hx(t, c.VoterTag), c.JSON, newLedger(c.Ledger.Ciphertexts, c.Ledger.Voted), c.Voter == "idemix")
		case "round1":
			_, err = CheckRound1(&p.Setup, c.Index, c.JSON)
		case "round2":
			err = CheckRound2(&p.Setup, c.Index, c.JSON)
		case "confirm":
			err = CheckConfirmation(p, c.Index, c.JSON)
		case "dshare":
			_, err = CheckDecryptionShare(p, c.Totals, c.Index, c.JSON)
		case "tally":
			_, err = RecoverTally(p, c.Totals, c.Ballots, c.Posted)
		default:
			t.Fatalf("unknown kind %q", c.Kind)
		}
		kinds[c.Kind]++
		var te *Error
		switch {
		case err == nil:
			t.Errorf("%s %q: accepted, want %q", c.Kind, c.Name, c.Error)
		case !asError(err, &te):
			t.Errorf("%s %q: %v is not a contract refusal", c.Kind, c.Name, err)
		case te.Msg != c.Error:
			t.Errorf("%s %q:\n got %q\nwant %q", c.Kind, c.Name, te.Msg, c.Error)
		}
	}
	for _, k := range []string{"ballot", "round1", "round2", "confirm", "dshare", "tally"} {
		if kinds[k] == 0 {
			t.Errorf("no negative vectors of kind %s", k)
		}
	}
}

func mustUniform(b []byte) *r255.Scalar {
	s, err := r255.NewScalar().SetUniformBytes(b)
	if err != nil {
		panic(err)
	}
	return s
}

func asError(err error, target **Error) bool {
	e, ok := err.(*Error)
	if ok {
		*target = e
	}
	return ok
}
