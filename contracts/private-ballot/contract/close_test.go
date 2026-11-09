package contract

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Closing by k trustees, the closing transaction as the cut-off under
// Fabric's validation, and determinism.

func TestCloseNeedsKTrustees(t *testing.T) {
	v := loadVectors(t)
	// council-2027: Org2MSP, Org1MSP, Org4MSP and Org3MSP, 3 of 4.
	n := ceremony(t, v, "council-2027", 4)
	id := "council-2027"
	castAll(t, v, n, id)
	first := ok(t, n.submit(trustee(t, "Org4MSP"), "CloseElection", id))
	eventIs(t, first, "CloseRequested", `{"electionId":"council-2027","trustee":"Org4MSP"}`)
	// Asking again is refused: it writes nothing and emits no event.
	again := n.endorse(trustee(t, "Org4MSP"), "CloseElection", id)
	refused(t, again, "Org4MSP has already asked to close voting.")
	if len(again.writes) != 0 || again.event != nil {
		t.Errorf("a second request from the same trustee wrote %d keys and event %v", len(again.writes), again.event)
	}
	second := ok(t, n.submit(trustee(t, "Org2MSP"), "CloseElection", id))
	if record(t, second.payload).State != stateOpen {
		t.Fatal("2 of 3 trustees closed the election")
	}
	// A late ballot still counts.
	third := ok(t, n.submit(trustee(t, "Org3MSP"), "CloseElection", id))
	r := record(t, third.payload)
	if r.State != stateDecrypting || *r.Ballots != 4 {
		t.Fatalf("the third request left the election in %s with %v ballots", r.State, r.Ballots)
	}
	// closedBy is in the order of the trustee list, not the order of asking.
	eventIs(t, third, "ElectionClosed", `{"electionId":"council-2027","ballots":4,"closedBy":["Org2MSP","Org4MSP","Org3MSP"]}`)
	if strings.Join(r.ClosedBy, ",") != "Org2MSP,Org4MSP,Org3MSP" {
		t.Errorf("closedBy %v", r.ClosedBy)
	}
}

func TestEmptyElectionCounts(t *testing.T) {
	v := loadVectors(t)
	n := ceremony(t, v, "referendum-2027", 4)
	id := "referendum-2027"
	ok(t, n.submit(trustee(t, "Org1MSP"), "CloseElection", id))
	r := record(t, ok(t, n.submit(trustee(t, "Org2MSP"), "CloseElection", id)).payload)
	zero := strings.Repeat("0", 64)
	if *r.Ballots != 0 || r.Totals[0].A != zero || r.Totals[1].B != zero {
		t.Fatalf("an empty election's totals: %+v", r.Totals)
	}
}

func TestTheCloseIsTheCutOff(t *testing.T) {
	v, n := budget(t, 4)
	id := "budget-2027"
	var bs []ballotVector
	for _, b := range v.ballots {
		if b.Election == id {
			bs = append(bs, b)
		}
	}
	ok(t, n.submit(bs[0].Voter.identity(t), "CastBallot", id, bs[0].JSON))
	ok(t, n.submit(trustee(t, "Org1MSP"), "CloseElection", id))

	// Endorsed before the close, committed after it: the close rewrote the
	// election record the ballot read.
	early := ok(t, n.endorse(bs[1].Voter.identity(t), "CastBallot", id, bs[1].JSON))
	ok(t, n.submit(trustee(t, "Org2MSP"), "CloseElection", id))
	if code := n.commit(early); code != "MVCC_READ_CONFLICT" {
		t.Errorf("a ballot committed after the close: %s", code)
	}
	refused(t, n.endorse(bs[1].Voter.identity(t), "CastBallot", id, bs[1].JSON), "Voting has closed.")

	// A ballot committed while the close was being endorsed: the close's
	// range read of the ballots changed.
	_, m := budget(t, 4)
	ok(t, m.submit(trustee(t, "Org1MSP"), "CloseElection", id))
	closing := ok(t, m.endorse(trustee(t, "Org2MSP"), "CloseElection", id))
	ok(t, m.submit(bs[2].Voter.identity(t), "CastBallot", id, bs[2].JSON))
	if code := m.commit(closing); code != "PHANTOM_READ_CONFLICT" {
		t.Errorf("a close endorsed before a ballot committed: %s", code)
	}
	// Called again, it closes with the ballot counted.
	r := record(t, ok(t, m.submit(trustee(t, "Org2MSP"), "CloseElection", id)).payload)
	if r.State != stateDecrypting || *r.Ballots != 1 {
		t.Errorf("after the retry: %s with %v ballots", r.State, r.Ballots)
	}

	// Two requests endorsed together each see only their own. The second
	// to commit fails validation, and calling again completes the close.
	_, k := budget(t, 4)
	a := ok(t, k.endorse(trustee(t, "Org1MSP"), "CloseElection", id))
	b := ok(t, k.endorse(trustee(t, "Org3MSP"), "CloseElection", id))
	if k.commit(a) != "VALID" {
		t.Fatal("the first request didn't commit")
	}
	if code := k.commit(b); code != "MVCC_READ_CONFLICT" {
		t.Errorf("the second concurrent request: %s", code)
	}
	if record(t, ok(t, k.submit(trustee(t, "Org3MSP"), "CloseElection", id)).payload).State != stateDecrypting {
		t.Error("the retried request didn't close the election")
	}

	// Two ballots from one voter endorsed together: the second to commit
	// read the voted marker the first wrote.
	_, w := budget(t, 4)
	x := ok(t, w.endorse(bs[3].Voter.identity(t), "CastBallot", id, bs[3].JSON))
	y := ok(t, w.endorse(bs[3].Voter.identity(t), "CastBallot", id, bs[3].JSON))
	if w.commit(x) != "VALID" || w.commit(y) != "MVCC_READ_CONFLICT" {
		t.Error("two concurrent ballots from one voter both committed")
	}
}

// Two endorsers given the same transactions write the same bytes.
func TestEndorsersAgree(t *testing.T) {
	run := func() []*endorsement {
		v := loadVectors(t)
		n := ceremony(t, v, "budget-2027", 0)
		var out []*endorsement
		e := v.elections["budget-2027"]
		c := v.ceremonies["budget-2027"]
		do := func(who identity, fn string, args ...string) {
			out = append(out, ok(t, n.submit(who, fn, args...)))
		}
		rounds := []struct {
			fn   string
			post func(i int) string
		}{
			{"PostCommitments", func(i int) string { return c.Trustees[i].Round1.JSON }},
			{"PostShares", func(i int) string { return c.Trustees[i].Round2.JSON }},
			{"ConfirmShares", func(i int) string { return c.Trustees[i].Round3.JSON }},
		}
		for _, r := range rounds {
			for i, msp := range e.Trustees {
				do(trustee(t, msp), r.fn, e.ElectionID, r.post(i))
			}
		}
		do(member(t, "Org1MSP"), "OpenElection", e.ElectionID)
		for _, b := range v.ballots {
			if b.Election == "budget-2027" {
				do(b.Voter.identity(t), "CastBallot", e.ElectionID, b.JSON)
			}
		}
		do(trustee(t, "Org1MSP"), "CloseElection", e.ElectionID)
		do(trustee(t, "Org2MSP"), "CloseElection", e.ElectionID)
		do(trustee(t, "Org2MSP"), "PostDecryptionShare", e.ElectionID, v.shares["budget-2027"][1])
		do(trustee(t, "Org3MSP"), "PostDecryptionShare", e.ElectionID, v.shares["budget-2027"][2])
		do(member(t, "Org2MSP"), "PublishTally", e.ElectionID)
		return out
	}
	a, b := run(), run()
	if len(a) != len(b) || len(a) < 15 {
		t.Fatalf("%d and %d transactions", len(a), len(b))
	}
	for i := range a {
		if !sameWrites(a[i], b[i]) {
			t.Errorf("transaction %d, %s, wrote different bytes on two endorsers", i, a[i].function)
		}
	}
}

// No source file of the contract reads a clock or draws randomness, and
// the transaction's timestamp is read in one place, createdAt in
// election.go, which only CreateElection calls.
func TestNoClockOrRandomness(t *testing.T) {
	forbidden := regexp.MustCompile(`time\.Now|time\.Since|time\.Until|"math/rand|"crypto/rand|"math/rand/v2`)
	timestamp := regexp.MustCompile(`GetTxTimestamp|createdAt\(`)
	var reads []string
	var files []string
	for _, dir := range []string{".", filepath.Join("..", "internal", "tally"), ".."} {
		matches, _ := filepath.Glob(filepath.Join(dir, "*.go"))
		for _, m := range matches {
			if !strings.HasSuffix(m, "_test.go") {
				files = append(files, m)
			}
		}
	}
	if len(files) < 10 {
		t.Fatalf("found only %d source files", len(files))
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if loc := forbidden.FindIndex(b); loc != nil {
			t.Errorf("%s uses %s", f, b[loc[0]:loc[1]])
		}
		for _, m := range timestamp.FindAll(b, -1) {
			reads = append(reads, filepath.Base(f)+" "+string(m))
		}
	}
	// The definition, its one call to GetTxTimestamp, and CreateElection's one call.
	if strings.Join(reads, ", ") != "election.go createdAt(, election.go GetTxTimestamp, election.go createdAt(" {
		t.Errorf("the transaction's timestamp is read in %v, not only by CreateElection", reads)
	}
}
