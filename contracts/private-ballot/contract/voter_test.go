package contract

import (
	"strings"
	"testing"

	"github.com/weftwallet/weft/contracts/private-ballot/internal/tally"
)

// One vote per enrolment ID (review packet Q1): the X.509 voter tag is made
// from the creator's MSP ID and the enrolment ID in its certificate, so the
// same certificate in another PEM spelling, and another certificate Fabric
// CA issued for the same ID, are the same voter.

// fabricCAVoter1 returns the vectors' id_bytes for Fabric CA's certificates
// for voter1: every spelling of the first enrolment's certificate, then a
// second enrolment and a re-enrolment, by name.
func fabricCAVoter1(t *testing.T) (names []string, idBytes [][]byte) {
	t.Helper()
	var ctx struct {
		EnrolmentIDs []struct {
			Name        string `json:"name"`
			IDBytes     string `json:"idBytes"`
			EnrolmentID string `json:"enrolmentId"`
		} `json:"enrolmentIds"`
	}
	load(t, "context.json", &ctx)
	for _, c := range ctx.EnrolmentIDs {
		if strings.HasPrefix(c.Name, "Fabric CA") {
			if c.EnrolmentID != "voter1" {
				t.Fatalf("%s: enrolment ID %q", c.Name, c.EnrolmentID)
			}
			names, idBytes = append(names, c.Name), append(idBytes, unhex(t, c.IDBytes))
		}
	}
	// The five spellings of checks/pem-voter-tag/main.go are among them.
	for _, want := range []string{"as written", "without the trailing newline", "with two trailing newlines", "with text before the block", "with text after the block"} {
		found := false
		for _, n := range names {
			found = found || strings.HasSuffix(n, "the first enrolment, "+want)
		}
		if !found {
			t.Fatalf("no vector for the spelling %q", want)
		}
	}
	return names, idBytes
}

func TestOneTagForEverySpellingAndEnrolment(t *testing.T) {
	names, idBytes := fabricCAVoter1(t)
	want := tally.ToHex(tally.VoterTagX509("privatevote-budget-2027", "budget-2027", "Org1MSP", "voter1"))
	raw := map[string]bool{}
	for i, b := range idBytes {
		raw[string(b)] = true
		id, err := tally.EnrolmentID(b)
		if err != nil {
			t.Fatalf("%s: %v", names[i], err)
		}
		if got := tally.ToHex(tally.VoterTagX509("privatevote-budget-2027", "budget-2027", "Org1MSP", id)); got != want {
			t.Errorf("%s: tag %s, want %s", names[i], got, want)
		}
	}
	if len(raw) != len(idBytes) {
		t.Fatalf("the vectors repeat id_bytes")
	}
}

func TestASecondBallotFromAnotherSpellingIsRefused(t *testing.T) {
	v := loadVectors(t)
	names, idBytes := fabricCAVoter1(t)
	e := v.elections["budget-2027"]
	n := ceremony(t, v, "budget-2027", 4)
	_, p := prepare(t, n, e.ElectionID)
	tag := tally.VoterTagX509(n.channel, e.ElectionID, "Org1MSP", "voter1")
	first := ok(t, n.submit(identity{"Org1MSP", idBytes[0]}, "CastBallot", e.ElectionID, makeBallot(t, p, e.ElectionID, tag, []int{0, 1, 0}, nil)))
	if got := n.get(t, keyVoted, e.ElectionID, tally.ToHex(tag)); string(got) != first.txID {
		t.Fatalf("the marker for voter1's tag holds %q, want %s", got, first.txID)
	}
	for i, b := range idBytes[1:] {
		// Each ballot is new and valid for voter1's tag, so only the marker refuses it.
		got := n.endorse(identity{"Org1MSP", b}, "CastBallot", e.ElectionID, makeBallot(t, p, e.ElectionID, tag, []int{1, 0, 0}, nil))
		refused(t, got, "This identity has already voted in this election.")
		if t.Failed() {
			t.Fatalf("%s wasn't refused", names[i+1])
		}
	}
	// Another enrolment ID of the same organisation still votes.
	ada := tally.VoterTagX509(n.channel, e.ElectionID, "Org1MSP", "ada")
	for _, b := range v.ballots {
		if b.Election == e.ElectionID && b.Voter.Name == "ada" {
			ok(t, n.submit(b.Voter.identity(t), "CastBallot", e.ElectionID, makeBallot(t, p, e.ElectionID, ada, []int{0, 0, 1}, nil)))
			return
		}
	}
	t.Fatal("no vector ballot from ada")
}

// TestTheCertificateNotItsBytes: a ballot proved for the tag of the
// certificate's raw id_bytes, which version 1 of the tag hashed, is bound
// to another tag and fails its proofs.
func TestTheCertificateNotItsBytes(t *testing.T) {
	v := loadVectors(t)
	_, idBytes := fabricCAVoter1(t)
	e := v.elections["budget-2027"]
	n := ceremony(t, v, "budget-2027", 4)
	_, p := prepare(t, n, e.ElectionID)
	wrong := tally.VoterTagX509(n.channel, e.ElectionID, "Org1MSP", string(idBytes[0]))
	refused(t, n.endorse(identity{"Org1MSP", idBytes[0]}, "CastBallot", e.ElectionID, makeBallot(t, p, e.ElectionID, wrong, []int{0, 1, 0}, nil)), "Ciphertext 0 is not a 0 or a 1.")
}
