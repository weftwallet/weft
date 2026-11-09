package contract

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	"github.com/weftwallet/weft/contracts/private-ballot/internal/tally"
)

// The test vectors from packages/tally/vectors/v1, driven through the
// contract's functions on the in-memory peer: each election's ceremony, its
// ballots, the close, the decryption shares and every tally, and every
// negative vector refused with its message.

type electionVector struct {
	Name            string   `json:"name"`
	Channel         string   `json:"channel"`
	Chaincode       string   `json:"chaincode"`
	ElectionID      string   `json:"electionId"`
	Options         []string `json:"options"`
	Threshold       int      `json:"threshold"`
	Trustees        []string `json:"trustees"`
	PublicKey       string   `json:"publicKey"`
	VerifyingShares []string `json:"verifyingShares"`
	Ctx             string   `json:"ctx"`
	Fingerprint     string   `json:"fingerprint"`
}

type voterVector struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	MspID   string `json:"mspId"`
	IDBytes string `json:"idBytes"`
	Tag     string `json:"tag"`
}

type ballotVector struct {
	Election string      `json:"election"`
	Voter    voterVector `json:"voter"`
	Ballot   struct {
		Ciphertexts []tally.Ciphertext `json:"ciphertexts"`
	} `json:"ballot"`
	JSON     string `json:"json"`
	Tracking string `json:"tracking"`
}

type ceremonyVector struct {
	Election string `json:"election"`
	Trustees []struct {
		Index  int    `json:"index"`
		Msp    string `json:"msp"`
		Round1 struct {
			JSON string `json:"json"`
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
}

type shareVector struct {
	Election string `json:"election"`
	Index    int    `json:"index"`
	JSON     string `json:"json"`
}

type tallyVector struct {
	Election string             `json:"election"`
	Ballots  int                `json:"ballots"`
	Totals   []tally.Ciphertext `json:"totals"`
	Posted   []int              `json:"posted"`
	Counts   []int              `json:"counts"`
	Total    int                `json:"total"`
}

type negativeVector struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Election string `json:"election"`
	Error    string `json:"error"`
	MspID    string `json:"mspId"`
	IDBytes  string `json:"idBytes"`
	VoterTag string `json:"voterTag"`
	Voter    string `json:"voter"`
	Ledger   struct {
		Ciphertexts []string `json:"ciphertexts"`
		Voted       []string `json:"voted"`
	} `json:"ledger"`
	JSON    string              `json:"json"`
	Index   int                 `json:"index"`
	Totals  []tally.Ciphertext  `json:"totals"`
	Ballots int                 `json:"ballots"`
	Posted  []tally.PostedShare `json:"posted"`
}

type vectors struct {
	elections  map[string]electionVector
	ceremonies map[string]ceremonyVector
	ballots    []ballotVector
	totals     map[string][]tally.Ciphertext
	ballotsN   map[string]int
	shares     map[string]map[int]string
	tallies    []tallyVector
	negative   []negativeVector
	// voters by election and voter tag, for the negative ballots
	voters map[string]map[string]voterVector
}

func loadVectors(t *testing.T) *vectors {
	t.Helper()
	v := &vectors{
		elections: map[string]electionVector{}, ceremonies: map[string]ceremonyVector{},
		totals: map[string][]tally.Ciphertext{}, ballotsN: map[string]int{},
		shares: map[string]map[int]string{}, voters: map[string]map[string]voterVector{},
	}
	var ctx struct {
		Elections []electionVector `json:"elections"`
		VoterTags []struct {
			voterVector
			ElectionID string `json:"electionId"`
		} `json:"voterTags"`
	}
	load(t, "context.json", &ctx)
	for _, e := range ctx.Elections {
		v.elections[e.Name] = e
	}
	addVoter := func(election string, vv voterVector) {
		if v.voters[election] == nil {
			v.voters[election] = map[string]voterVector{}
		}
		v.voters[election][vv.Tag] = vv
	}
	for _, vt := range ctx.VoterTags {
		addVoter(vt.ElectionID, vt.voterVector)
	}
	var cer struct {
		Ceremonies []ceremonyVector `json:"ceremonies"`
	}
	load(t, "ceremony.json", &cer)
	for _, c := range cer.Ceremonies {
		v.ceremonies[c.Election] = c
	}
	var bal struct {
		Ballots []ballotVector `json:"ballots"`
	}
	load(t, "ballots.json", &bal)
	v.ballots = bal.Ballots
	for _, b := range bal.Ballots {
		addVoter(b.Election, b.Voter)
	}
	var sh struct {
		Totals []struct {
			Election string             `json:"election"`
			Totals   []tally.Ciphertext `json:"totals"`
			Ballots  int                `json:"ballots"`
		} `json:"totals"`
		Shares []shareVector `json:"shares"`
	}
	load(t, "shares.json", &sh)
	for _, x := range sh.Totals {
		v.totals[x.Election], v.ballotsN[x.Election] = x.Totals, x.Ballots
	}
	for _, s := range sh.Shares {
		if v.shares[s.Election] == nil {
			v.shares[s.Election] = map[int]string{}
		}
		v.shares[s.Election][s.Index] = s.JSON
	}
	var ta struct {
		Tally []tallyVector `json:"tally"`
	}
	load(t, "tally.json", &ta)
	v.tallies = ta.Tally
	var neg struct {
		Negative []negativeVector `json:"negative"`
	}
	load(t, "negative.json", &neg)
	v.negative = neg.Negative
	return v
}

func (vv voterVector) identity(t *testing.T) identity {
	return identity{vv.MspID, unhex(t, vv.IDBytes)}
}

// electionJSON is CreateElection's argument for a vector election, with the
// voter organisations of its X.509 ballots.
func electionJSON(e electionVector, voterMsps []string) string {
	return electionJSONWith(e, map[string]any{"kind": "x509", "msps": voterMsps})
}

// electionJSONWith is the election of a vector with other voters. The
// election context doesn't bind the voters, so the vector's ceremony opens
// it with the vector's keys.
func electionJSONWith(e electionVector, voters map[string]any) string {
	b, _ := json.Marshal(map[string]any{
		"id": e.ElectionID, "title": "Vector " + e.ElectionID, "options": e.Options,
		"closesAt": "2027-01-31T17:00:00.000Z", "trustees": e.Trustees, "threshold": e.Threshold,
		"voters": voters,
	})
	return string(b)
}

func (v *vectors) voterMsps(election string) []string {
	var out []string
	for _, b := range v.ballots {
		if b.Election != election || b.Voter.Kind != "x509" {
			continue
		}
		dup := false
		for _, m := range out {
			dup = dup || m == b.Voter.MspID
		}
		if !dup {
			out = append(out, b.Voter.MspID)
		}
	}
	return out
}

func ok(t *testing.T, e *endorsement) *endorsement {
	t.Helper()
	if e.err != "" {
		t.Fatalf("%s refused: %s", e.function, e.err)
	}
	return e
}

func refused(t *testing.T, e *endorsement, want string) {
	t.Helper()
	if e.err != want {
		t.Errorf("%s:\n got %q\nwant %q", e.function, e.err, want)
	}
}

func record(t *testing.T, b []byte) *Record {
	t.Helper()
	r := &Record{}
	if err := json.Unmarshal(b, r); err != nil {
		t.Fatalf("record %s: %v", b, err)
	}
	return r
}

func eventIs(t *testing.T, e *endorsement, name string, payload string) {
	t.Helper()
	if e.event == nil || e.event.EventName != name {
		t.Errorf("%s: event %v, want %s", e.function, e.event, name)
		return
	}
	if payload != "" && string(e.event.Payload) != payload {
		t.Errorf("%s: event %s payload\n got %s\nwant %s", e.function, name, e.event.Payload, payload)
	}
}

// ceremony runs an election's key ceremony from its vector up to the stage
// given (1, 2 or 3 rounds posted, or 4 for opened) on a new network.
func ceremony(t *testing.T, v *vectors, name string, stage int) *network {
	t.Helper()
	return ceremonyWith(t, v, name, stage, map[string]any{"kind": "x509", "msps": v.voterMsps(name)})
}

// ceremonyWith is ceremony for the vector's election with other voters.
func ceremonyWith(t *testing.T, v *vectors, name string, stage int, voters map[string]any) *network {
	t.Helper()
	e := v.elections[name]
	c := v.ceremonies[name]
	n := newNetwork(t, e.Channel)
	n.chaincode = e.Chaincode
	created := ok(t, n.submit(trustee(t, e.Trustees[0]), "CreateElection", electionJSONWith(e, voters)))
	eventIs(t, created, "ElectionCreated", fmt.Sprintf(`{"electionId":%q}`, e.ElectionID))
	rounds := []struct {
		fn   string
		json func(i int) string
	}{
		{"PostCommitments", func(i int) string { return c.Trustees[i].Round1.JSON }},
		{"PostShares", func(i int) string { return c.Trustees[i].Round2.JSON }},
		{"ConfirmShares", func(i int) string { return c.Trustees[i].Round3.JSON }},
	}
	for round, r := range rounds[:min(stage, 3)] {
		for i, tr := range c.Trustees {
			if tr.Index != i || tr.Msp != e.Trustees[i] {
				t.Fatalf("%s: trustee %d of the ceremony isn't %s", name, i, e.Trustees[i])
			}
			step := ok(t, n.submit(trustee(t, tr.Msp), r.fn, e.ElectionID, r.json(i)))
			eventIs(t, step, "CeremonyStep", fmt.Sprintf(`{"electionId":%q,"round":%d,"trustee":%q}`, e.ElectionID, round+1, tr.Msp))
		}
	}
	if stage >= 4 {
		opened := ok(t, n.submit(member(t, "Org1MSP"), "OpenElection", e.ElectionID))
		r := record(t, opened.payload)
		if r.State != stateOpen || r.PublicKey != c.PublicKey || !reflect.DeepEqual(r.VerifyingShares, c.VerifyingShares) {
			t.Fatalf("%s: the opened record's keys differ from the vector's", name)
		}
		if r.Context != e.Ctx || r.Fingerprint != e.Fingerprint {
			t.Fatalf("%s: context %s and fingerprint %s, want %s and %s", name, r.Context, r.Fingerprint, e.Ctx, e.Fingerprint)
		}
		eventIs(t, opened, "ElectionOpened", fmt.Sprintf(`{"electionId":%q,"fingerprint":%q}`, e.ElectionID, e.Fingerprint))
	}
	return n
}

// injectBallot writes a voter credential's ballot as CastAnonymousBallot
// writes one, without its pseudonym proof: the tally vectors' voter
// credential has a fixed P and no proof, and the referendum vector has one
// such ballot in an election with X.509 voters. anonymous_test.go casts
// voter credentials' ballots through CastAnonymousBallot.
func injectBallot(t *testing.T, n *network, id string, b ballotVector, txID string) {
	var doc ballotDoc
	if err := json.Unmarshal([]byte(b.JSON), &doc); err != nil {
		t.Fatal(err)
	}
	stored, _ := marshal(storedBallot{b.Tracking, doc, nil})
	n.put(t, stored, keyBallot, id, txID)
	n.put(t, []byte(txID), keyTracking, id, b.Tracking)
	for _, ct := range doc.Ciphertexts {
		n.put(t, []byte(txID), keyCiphertext, id, ct.A)
	}
	n.put(t, []byte(txID), keyVoted, id, b.Voter.Tag)
}

// castAll casts every ballot of the election's vector and checks each result.
func castAll(t *testing.T, v *vectors, n *network, name string) {
	t.Helper()
	id := v.elections[name].ElectionID
	for i, b := range v.ballots {
		if b.Election != name {
			continue
		}
		if b.Voter.Kind != "x509" {
			injectBallot(t, n, id, b, fmt.Sprintf("injected%d", i))
			continue
		}
		cast := ok(t, n.submit(b.Voter.identity(t), "CastBallot", id, b.JSON))
		want := fmt.Sprintf(`{"electionId":%q,"txId":%q,"tracking":%q}`, id, cast.txID, b.Tracking)
		if string(cast.payload) != want {
			t.Errorf("%s ballot %d: result %s, want %s", name, i, cast.payload, want)
		}
		eventIs(t, cast, "BallotCast", fmt.Sprintf(`{"electionId":%q,"tracking":%q}`, id, b.Tracking))
		got := ok(t, n.submit(member(t, "Org2MSP"), "GetBallot", id, b.Tracking))
		var view struct {
			TxID     string `json:"txId"`
			Tracking string `json:"tracking"`
			Ballot   struct {
				Ciphertexts []tally.Ciphertext `json:"ciphertexts"`
			} `json:"ballot"`
		}
		if err := json.Unmarshal(got.payload, &view); err != nil || view.TxID != cast.txID || !reflect.DeepEqual(view.Ballot.Ciphertexts, b.Ballot.Ciphertexts) {
			t.Errorf("%s ballot %d: GetBallot gave %s", name, i, got.payload)
		}
	}
}

// closeByK closes the election with its first k trustees, in order.
func closeByK(t *testing.T, v *vectors, n *network, name string) *Record {
	t.Helper()
	e := v.elections[name]
	var last *endorsement
	for i := 0; i < e.Threshold; i++ {
		last = ok(t, n.submit(trustee(t, e.Trustees[i]), "CloseElection", e.ElectionID))
		r := record(t, last.payload)
		if i < e.Threshold-1 {
			if r.State != stateOpen {
				t.Fatalf("%s closed after %d requests of %d", name, i+1, e.Threshold)
			}
			eventIs(t, last, "CloseRequested", fmt.Sprintf(`{"electionId":%q,"trustee":%q}`, e.ElectionID, e.Trustees[i]))
		}
	}
	r := record(t, last.payload)
	closedBy, _ := json.Marshal(e.Trustees[:e.Threshold])
	eventIs(t, last, "ElectionClosed", fmt.Sprintf(`{"electionId":%q,"ballots":%d,"closedBy":%s}`, e.ElectionID, v.ballotsN[name], closedBy))
	return r
}

func TestVectorsThroughTheContract(t *testing.T) {
	v := loadVectors(t)
	for _, name := range []string{"budget-2027", "council-2027", "referendum-2027"} {
		t.Run(name, func(t *testing.T) {
			e := v.elections[name]
			n := ceremony(t, v, name, 4)
			castAll(t, v, n, name)
			r := closeByK(t, v, n, name)
			if r.State != stateDecrypting || r.Ballots == nil || *r.Ballots != v.ballotsN[name] || !reflect.DeepEqual(r.Totals, v.totals[name]) {
				t.Fatalf("%s: closed record %+v, want %d ballots and the vector's totals", name, r, v.ballotsN[name])
			}
			tallies := 0
			for _, tv := range v.tallies {
				if tv.Election != name {
					continue
				}
				tallies++
				m := n.clone()
				for _, i := range tv.Posted {
					posted := ok(t, m.submit(trustee(t, e.Trustees[i]), "PostDecryptionShare", e.ElectionID, v.shares[name][i]))
					eventIs(t, posted, "DecryptionSharePosted", fmt.Sprintf(`{"electionId":%q,"trustee":%q}`, e.ElectionID, e.Trustees[i]))
				}
				published := ok(t, m.submit(member(t, "Org2MSP"), "PublishTally", e.ElectionID))
				r := record(t, published.payload)
				var counts []int
				for j, c := range r.Tally.Counts {
					if c.Option != e.Options[j] {
						t.Errorf("%s: count %d is for %q, not %q", name, j, c.Option, e.Options[j])
					}
					counts = append(counts, c.N)
				}
				if r.State != stateCounted || !reflect.DeepEqual(counts, tv.Counts) || r.Tally.Total != tv.Total {
					t.Errorf("%s from %v: counts %v of %d, want %v of %d", name, tv.Posted, counts, r.Tally.Total, tv.Counts, tv.Total)
				}
				countsJSON, _ := marshal(r.Tally.Counts)
				eventIs(t, published, "TallyPublished", fmt.Sprintf(`{"electionId":%q,"counts":%s,"total":%d}`, e.ElectionID, countsJSON, tv.Total))
			}
			if tallies == 0 {
				t.Fatalf("no tally vectors for %s", name)
			}
		})
	}
}

// setRecord changes the stored election record directly, to put an
// election into the state a negative vector needs.
func setRecord(t *testing.T, n *network, id string, change func(r *Record)) {
	r := record(t, n.get(t, keyElection, id))
	change(r)
	b, _ := marshal(r)
	n.put(t, b, keyElection, id)
}

func TestNegativeVectorsThroughTheContract(t *testing.T) {
	v := loadVectors(t)
	base := map[string]map[int]*network{}
	stage := func(name string, s int) *network {
		if base[name] == nil {
			base[name] = map[int]*network{}
		}
		if base[name][s] == nil {
			base[name][s] = ceremony(t, v, name, s)
		}
		return base[name][s].clone()
	}
	kinds := map[string]int{}
	for _, c := range v.negative {
		e := v.elections[c.Election]
		var got *endorsement
		switch c.Kind {
		case "ballot":
			if c.Voter != "x509" {
				// The tally vectors' voter credential has a fixed P and no
				// pseudonym proof, so internal/tally runs this vector, and
				// anonymous_test.go casts voter credentials' ballots.
				continue
			}
			n := stage(c.Election, 4)
			for _, a := range c.Ledger.Ciphertexts {
				n.put(t, []byte("earlier"), keyCiphertext, e.ElectionID, a)
			}
			for _, tag := range c.Ledger.Voted {
				n.put(t, []byte("earlier"), keyVoted, e.ElectionID, tag)
			}
			voter, found := v.voters[e.ElectionID][c.VoterTag]
			if !found {
				t.Fatalf("%q: no voter has tag %s", c.Name, c.VoterTag)
			}
			got = n.endorse(voter.identity(t), "CastBallot", e.ElectionID, c.JSON)
		case "voter":
			// An X.509 creator the contract refuses before it reads the ballot.
			got = stage(c.Election, 4).endorse(identity{c.MspID, unhex(t, c.IDBytes)}, "CastBallot", e.ElectionID, c.JSON)
		case "round1":
			got = stage(c.Election, 0).endorse(trustee(t, e.Trustees[c.Index]), "PostCommitments", e.ElectionID, c.JSON)
		case "round2":
			got = stage(c.Election, 1).endorse(trustee(t, e.Trustees[c.Index]), "PostShares", e.ElectionID, c.JSON)
		case "confirm":
			got = stage(c.Election, 2).endorse(trustee(t, e.Trustees[c.Index]), "ConfirmShares", e.ElectionID, c.JSON)
		case "dshare":
			n := stage(c.Election, 4)
			setRecord(t, n, e.ElectionID, func(r *Record) {
				ballots := 0
				r.State, r.Totals, r.Ballots, r.ClosedBy = stateDecrypting, c.Totals, &ballots, e.Trustees[:e.Threshold]
			})
			got = n.endorse(trustee(t, e.Trustees[c.Index]), "PostDecryptionShare", e.ElectionID, c.JSON)
		case "tally":
			n := stage(c.Election, 4)
			ballots := c.Ballots
			setRecord(t, n, e.ElectionID, func(r *Record) {
				r.State, r.Totals, r.Ballots, r.ClosedBy = stateDecrypting, c.Totals, &ballots, e.Trustees[:e.Threshold]
			})
			for _, p := range c.Posted {
				b, _ := marshal(p.Share)
				n.put(t, b, keyDShare, e.ElectionID, e.Trustees[p.Index])
			}
			got = n.endorse(member(t, "Org1MSP"), "PublishTally", e.ElectionID)
		default:
			t.Fatalf("unknown kind %q", c.Kind)
		}
		kinds[c.Kind]++
		if got.err != c.Error {
			t.Errorf("%s %q:\n got %q\nwant %q", c.Kind, c.Name, got.err, c.Error)
		}
	}
	for _, k := range []string{"voter", "ballot", "round1", "round2", "confirm", "dshare", "tally"} {
		if kinds[k] == 0 {
			t.Errorf("no negative vectors of kind %s ran", k)
		}
	}
}
