package contract

import (
	"encoding/json"
	"strings"
	"testing"
)

// Every row of the error table that the vectors don't reach, word for
// word, each from the call the table names. TestMain then checks that every
// reachable row was seen and that no refusal is missing from the table.

// newElection returns a valid electionJson with fields replaced.
func newElection(change map[string]any) string {
	e := map[string]any{
		"id": "lunch-2027", "title": "Lunch & dinner <2027>", "options": []string{"Soup", "Salad"},
		"closesAt": "2027-01-31T17:00:00.000Z", "trustees": []string{"Org1MSP", "Org2MSP"}, "threshold": 2,
		"voters": map[string]any{"kind": "x509", "msps": []string{"Org1MSP", "Org2MSP"}},
	}
	for k, v := range change {
		if v == nil {
			delete(e, k)
		} else {
			e[k] = v
		}
	}
	b, _ := json.Marshal(e)
	return string(b)
}

func TestCreateElection(t *testing.T) {
	n := newNetwork(t, "privatevote-lunch-2027")
	org1 := trustee(t, "Org1MSP")
	created := ok(t, n.submit(org1, "CreateElection", newElection(nil)))
	want := `{"v":1,"id":"lunch-2027","title":"Lunch & dinner <2027>","options":["Soup","Salad"],"closesAt":"2027-01-31T17:00:00.000Z",` +
		`"creatorMsp":"Org1MSP","trustees":[{"id":"0100000000000000000000000000000000000000000000000000000000000000","msp":"Org1MSP"},` +
		`{"id":"0200000000000000000000000000000000000000000000000000000000000000","msp":"Org2MSP"}],"threshold":2,` +
		`"voters":{"kind":"x509","msps":["Org1MSP","Org2MSP"]},"state":"keygen"}`
	if string(created.payload) != want {
		t.Errorf("record\n got %s\nwant %s", created.payload, want)
	}
	if got := ok(t, n.submit(member(t, "Org2MSP"), "GetElection", "lunch-2027")); string(got.payload) != want {
		t.Errorf("GetElection gave %s", got.payload)
	}
	// A threshold written as 2.0 or 2e0 is 2, as JSON.parse reads it.
	ok(t, n.submit(org1, "CreateElection", strings.Replace(newElection(map[string]any{"id": "lunch-b"}), `"threshold":2`, `"threshold":2e0`, 1)))

	cases := []struct {
		who  identity
		json string
		want string
	}{
		{org1, newElection(nil), "Election lunch-2027 already exists."},
		{trustee(t, "Org3MSP"), newElection(nil), "Org3MSP isn't one of the trustee organisations named in this election."},
		{member(t, "Org1MSP"), newElection(nil), "This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true."},
		{identity{"Org1MSP", certificate(t, "Org1MSP", "notrustee", map[string]string{"weft.trustee": "false"})}, newElection(nil),
			"This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true."},
		{idemixCreator("Org1MSP"), newElection(nil), "This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true."},
		{org1, newElection(map[string]any{"id": ""}), "Election IDs are 1 to 64 letters, digits, - or _."},
		{org1, newElection(map[string]any{"id": "lunch 2027"}), "Election IDs are 1 to 64 letters, digits, - or _."},
		{org1, newElection(map[string]any{"id": strings.Repeat("a", 65)}), "Election IDs are 1 to 64 letters, digits, - or _."},
		{org1, newElection(map[string]any{"id": "lunch\x00"}), "Election IDs are 1 to 64 letters, digits, - or _."},
		{org1, newElection(map[string]any{"id": "déjeuner"}), "Election IDs are 1 to 64 letters, digits, - or _."},
		{org1, newElection(map[string]any{"id": "x1", "options": []string{"Soup"}}), "An election has 2 to 20 options, all different."},
		{org1, newElection(map[string]any{"id": "x1", "options": []string{"Soup", "Soup"}}), "An election has 2 to 20 options, all different."},
		{org1, newElection(map[string]any{"id": "x1", "options": strings.Split("abcdefghijklmnopqrstu", "")}), "An election has 2 to 20 options, all different."},
		{org1, newElection(map[string]any{"id": "x1", "closesAt": "2027-01-31T17:00:00Z"}), "closesAt isn't a time in the form 2027-01-31T17:00:00.000Z."},
		{org1, newElection(map[string]any{"id": "x1", "closesAt": "2027-02-30T17:00:00.000Z"}), "closesAt isn't a time in the form 2027-01-31T17:00:00.000Z."},
		{org1, newElection(map[string]any{"id": "x1", "closesAt": "2027-01-31T17:00:00.000+00:00"}), "closesAt isn't a time in the form 2027-01-31T17:00:00.000Z."},
		{org1, newElection(map[string]any{"id": "x1", "trustees": []string{"Org1MSP"}, "threshold": 1}), "An election has at least two trustee organisations, all different."},
		{org1, newElection(map[string]any{"id": "x1", "trustees": []string{"Org1MSP", "Org1MSP"}}), "An election has at least two trustee organisations, all different."},
		{org1, newElection(map[string]any{"id": "x1", "threshold": 1}), "The threshold must be from 2 to the number of trustees."},
		{org1, newElection(map[string]any{"id": "x1", "threshold": 3}), "The threshold must be from 2 to the number of trustees."},
		{org1, newElection(map[string]any{"id": "x1", "threshold": 2.5}), "The threshold must be from 2 to the number of trustees."},
		{org1, newElection(map[string]any{"id": "x1", "voters": map[string]any{"kind": "idemix", "msp": "ChairVoters2027MSP", "issuerPublicKey": "AAAA", "issuerKeyHash": "00", "curve": "FP256BN_AMCL"}}),
			"Elections with voter credentials aren't supported by this version of the contract."},
		// The argument parses before anything else is checked, in the specification's order.
		{member(t, "Org9MSP"), "not json", "The election isn't JSON."},
		{org1, "[1]", "The election isn't a JSON object."},
		{org1, "null", "The election isn't a JSON object."},
		{org1, `{"zeta":1,"alpha":2,"id":"x"}`, "The election isn't in the version 1 format: it has an unknown field, alpha."},
		{org1, `{"id":"x"}`, "The election isn't in the version 1 format: title is missing."},
		{org1, `{"id":7,"title":"x"}`, "The election isn't in the version 1 format: id isn't a string."},
		{org1, newElection(map[string]any{"options": []any{"a", 2}}), "The election isn't in the version 1 format: options[1] isn't a string."},
		{org1, newElection(map[string]any{"threshold": "2"}), "The election isn't in the version 1 format: threshold isn't a number."},
		{org1, newElection(map[string]any{"voters": []string{}}), "The election isn't in the version 1 format: voters isn't an object."},
		{org1, newElection(map[string]any{"voters": map[string]any{"msps": []string{}}}), "The election isn't in the version 1 format: voters.kind is missing."},
		{org1, newElection(map[string]any{"voters": map[string]any{"kind": 1}}), "The election isn't in the version 1 format: voters.kind isn't a string."},
		{org1, newElection(map[string]any{"voters": map[string]any{"kind": "anyone"}}), `The election isn't in the version 1 format: voters.kind is neither "x509" nor "idemix".`},
		{org1, newElection(map[string]any{"voters": map[string]any{"kind": "x509", "msps": []string{}, "msp": "x"}}), "The election isn't in the version 1 format: it has an unknown field, voters.msp."},
		{org1, newElection(map[string]any{"voters": map[string]any{"kind": "x509"}}), "The election isn't in the version 1 format: voters.msps is missing."},
		{org1, newElection(map[string]any{"voters": map[string]any{"kind": "idemix", "msp": "M"}}), "The election isn't in the version 1 format: voters.issuerPublicKey is missing."},
	}
	for _, c := range cases {
		refused(t, n.endorse(c.who, "CreateElection", c.json), c.want)
	}
}

func TestCallsAndArguments(t *testing.T) {
	n := newNetwork(t, "privatevote-x")
	who := member(t, "Org1MSP")
	refused(t, n.endorse(who, "Vote", "x"), "The contract has no function Vote.")
	refused(t, n.endorse(who, "GetElection"), "GetElection takes 1 argument: electionId.")
	refused(t, n.endorse(who, "CastBallot", "x"), "CastBallot takes 2 arguments: electionId and ballotJson.")
	refused(t, n.endorse(who, "CastAnonymousBallot", "x", "y"), "CastAnonymousBallot takes 3 arguments: electionId, ballotJson and pseudonymJson.")
	for _, fn := range []string{"GetElection", "GetCeremony", "GetDecryptionShares", "OpenElection", "CloseElection", "PublishTally", "CancelElection"} {
		refused(t, n.endorse(who, fn, "nope"), "There's no election nope.")
	}
	for _, fn := range []string{"PostCommitments", "PostShares", "ConfirmShares", "ReportBadShare", "CastBallot", "PostDecryptionShare", "GetBallot"} {
		refused(t, n.endorse(who, fn, "nope", "{}"), "There's no election nope.")
	}
	refused(t, n.endorse(who, "CastAnonymousBallot", "nope", "{}", "{}"), "There's no election nope.")
	refused(t, n.endorse(who, "GetElection", "bad\x00id"), "There's no election bad\x00id.")
}

// budget runs budget-2027's ceremony (Org1MSP, Org2MSP and Org3MSP, 2 of 3) to the stage.
func budget(t *testing.T, stage int) (*vectors, *network) {
	v := loadVectors(t)
	return v, ceremony(t, v, "budget-2027", stage)
}

func TestCeremonyRefusals(t *testing.T) {
	v, n := budget(t, 0)
	c := v.ceremonies["budget-2027"]
	id := "budget-2027"
	org1, org2, org3 := trustee(t, "Org1MSP"), trustee(t, "Org2MSP"), trustee(t, "Org3MSP")
	r1 := func(i int) string { return c.Trustees[i].Round1.JSON }
	r2 := func(i int) string { return c.Trustees[i].Round2.JSON }
	r3 := func(i int) string { return c.Trustees[i].Round3.JSON }

	refused(t, n.endorse(trustee(t, "Org4MSP"), "PostCommitments", id, r1(0)), "Org4MSP isn't a trustee of this election.")
	refused(t, n.endorse(member(t, "Org1MSP"), "PostCommitments", id, r1(0)), "This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.")
	refused(t, n.endorse(org1, "PostShares", id, r2(0)), "Round 1 isn't finished: waiting for Org1MSP.")
	refused(t, n.endorse(org1, "OpenElection", id), "Round 1 isn't finished: waiting for Org1MSP.")
	ok(t, n.submit(org1, "PostCommitments", id, r1(0)))
	refused(t, n.endorse(org1, "PostCommitments", id, r1(0)), "Org1MSP has already posted round 1.")
	refused(t, n.endorse(org1, "PostShares", id, r2(0)), "Round 1 isn't finished: waiting for Org2MSP.")
	refused(t, n.endorse(org1, "ReportBadShare", id, c.Trustees[1].Round2.JSON), "Round 1 isn't finished: waiting for Org2MSP.")
	ok(t, n.submit(org2, "PostCommitments", id, r1(1)))
	ok(t, n.submit(org3, "PostCommitments", id, r1(2)))
	refused(t, n.endorse(org1, "ConfirmShares", id, r3(0)), "Round 2 isn't finished: waiting for Org1MSP.")
	ok(t, n.submit(org1, "PostShares", id, r2(0)))
	refused(t, n.endorse(org1, "PostShares", id, r2(0)), "Org1MSP has already posted round 2.")
	refused(t, n.endorse(org1, "ReportBadShare", id, "0200000000000000000000000000000000000000000000000000000000000000"), "Round 2 isn't finished: waiting for Org2MSP.")
	ok(t, n.submit(org2, "PostShares", id, r2(1)))
	ok(t, n.submit(org3, "PostShares", id, r2(2)))
	refused(t, n.endorse(org1, "OpenElection", id), "Round 3 isn't finished: waiting for Org1MSP.")
	ok(t, n.submit(org1, "ConfirmShares", id, r3(0)))
	refused(t, n.endorse(org1, "ConfirmShares", id, r3(0)), "Org1MSP has already posted round 3.")
	refused(t, n.endorse(org1, "OpenElection", id), "Round 3 isn't finished: waiting for Org2MSP.")

	// Reports: only another trustee's identifier, as the record lists it.
	refused(t, n.endorse(org1, "ReportBadShare", id, "0100000000000000000000000000000000000000000000000000000000000000"),
		"Trustee 0100000000000000000000000000000000000000000000000000000000000000 isn't another trustee of this election.")
	refused(t, n.endorse(org1, "ReportBadShare", id, "0400000000000000000000000000000000000000000000000000000000000000"),
		"Trustee 0400000000000000000000000000000000000000000000000000000000000000 isn't another trustee of this election.")
	refused(t, n.endorse(org1, "ReportBadShare", id, "2"), "Trustee 2 isn't another trustee of this election.")

	// Voting and counting can't start in keygen.
	refused(t, n.endorse(member(t, "Org1MSP"), "CastBallot", id, "{}"), "The election isn't open: it is in keygen.")
	refused(t, n.endorse(org1, "CloseElection", id), "The election isn't open: it is in keygen.")
	refused(t, n.endorse(org1, "PostDecryptionShare", id, "{}"), "The election is in keygen: decryption shares are posted while it is in decrypting.")
	refused(t, n.endorse(member(t, "Org1MSP"), "PublishTally", id), "The tally can't be published: the election is in keygen.")

	// Cancelling: a trustee identity of the creator's organisation.
	refused(t, n.endorse(org2, "CancelElection", id), "Org2MSP didn't create this election, so it can't cancel it.")
	refused(t, n.endorse(member(t, "Org1MSP"), "CancelElection", id), "This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.")

	// A report ends the ceremony.
	failed := n.clone()
	report := ok(t, failed.submit(org2, "ReportBadShare", id, "0300000000000000000000000000000000000000000000000000000000000000"))
	if record(t, report.payload).State != stateFailed {
		t.Error("ReportBadShare didn't fail the election")
	}
	eventIs(t, report, "ElectionFailed", `{"electionId":"budget-2027","reportedBy":"Org2MSP","fromTrustee":"Org3MSP"}`)
	terminal(t, failed, stateFailed)

	cancelled := n.clone()
	cancel := ok(t, cancelled.submit(org1, "CancelElection", id))
	if record(t, cancel.payload).State != stateCancelled {
		t.Error("CancelElection didn't cancel the election")
	}
	eventIs(t, cancel, "ElectionCancelled", `{"electionId":"budget-2027"}`)
	terminal(t, cancelled, stateCancelled)

	// Opening needs an X.509 identity, and every confirmation.
	ok(t, n.submit(org2, "ConfirmShares", id, r3(1)))
	ok(t, n.submit(org3, "ConfirmShares", id, r3(2)))
	refused(t, n.endorse(idemixCreator("ChairVoters2027MSP"), "OpenElection", id), "This identity can't open the election: it isn't an X.509 identity.")
	ok(t, n.submit(member(t, "Org3MSP"), "OpenElection", id))
	refused(t, n.endorse(member(t, "Org3MSP"), "OpenElection", id), "The key ceremony has ended: the election is in open.")
	refused(t, n.endorse(org1, "CancelElection", id), "The key ceremony has ended: the election is in open.")
	refused(t, n.endorse(org1, "PostCommitments", id, r1(0)), "The key ceremony has ended: the election is in open.")
	refused(t, n.endorse(org2, "ReportBadShare", id, "0100000000000000000000000000000000000000000000000000000000000000"), "The key ceremony has ended: the election is in open.")
	refused(t, n.endorse(org1, "PostDecryptionShare", id, v.shares["budget-2027"][0]), "The election is in open: decryption shares are posted while it is in decrypting.")
	refused(t, n.endorse(member(t, "Org1MSP"), "PublishTally", id), "The tally can't be published: the election is in open.")
}

// terminal checks that every write function refuses an election in a state
// that has no next state, with its row of the table.
func terminal(t *testing.T, n *network, state string) {
	t.Helper()
	id := "budget-2027"
	org1 := trustee(t, "Org1MSP")
	ended := "The key ceremony has ended: the election is in " + state + "."
	for _, fn := range []string{"PostCommitments", "PostShares", "ConfirmShares"} {
		refused(t, n.endorse(org1, fn, id, "{}"), ended)
	}
	refused(t, n.endorse(org1, "ReportBadShare", id, "x"), ended)
	refused(t, n.endorse(org1, "CancelElection", id), ended)
	refused(t, n.endorse(member(t, "Org1MSP"), "OpenElection", id), ended)
	if state == stateCounted {
		refused(t, n.endorse(member(t, "Org1MSP"), "CastBallot", id, "{}"), "Voting has closed.")
		refused(t, n.endorse(org1, "CloseElection", id), "Voting has already closed: the election is in counted.")
		refused(t, n.endorse(member(t, "Org1MSP"), "PublishTally", id), "The tally is already published.")
	} else {
		refused(t, n.endorse(member(t, "Org1MSP"), "CastBallot", id, "{}"), "The election isn't open: it is in "+state+".")
		refused(t, n.endorse(idemixCreator("ChairVoters2027MSP"), "CastAnonymousBallot", id, "{}", "{}"), "The election isn't open: it is in "+state+".")
		refused(t, n.endorse(org1, "CloseElection", id), "The election isn't open: it is in "+state+".")
		refused(t, n.endorse(member(t, "Org1MSP"), "PublishTally", id), "The tally can't be published: the election is in "+state+".")
	}
	refused(t, n.endorse(org1, "PostDecryptionShare", id, "{}"), "The election is in "+state+": decryption shares are posted while it is in decrypting.")
}

func TestVotingAndCountingRefusals(t *testing.T) {
	v, n := budget(t, 4)
	id := "budget-2027"
	var ada, grace ballotVector
	for _, b := range v.ballots {
		if b.Election == id && b.Voter.Name == "ada" {
			ada = b
		}
		if b.Election == id && b.Voter.Name == "grace" {
			grace = b
		}
	}
	// Voters: X.509 identities of the voter organisations.
	refused(t, n.endorse(member(t, "Org3MSP"), "CastBallot", id, ada.JSON),
		"This identity can't vote in this election: Org3MSP isn't one of its voter organisations.")
	refused(t, n.endorse(idemixCreator("Org1MSP"), "CastBallot", id, ada.JSON),
		"This identity can't vote in this election: Org1MSP isn't one of its voter organisations.")
	refused(t, n.endorse(idemixCreator("ChairVoters2027MSP"), "CastAnonymousBallot", id, ada.JSON, "{}"),
		"This identity can't vote in this election: ChairVoters2027MSP isn't one of its voter organisations.")
	ok(t, n.submit(ada.Voter.identity(t), "CastBallot", id, ada.JSON))
	refused(t, n.endorse(ada.Voter.identity(t), "CastBallot", id, grace.JSON), "Ciphertext 0 is not a 0 or a 1.")
	refused(t, n.endorse(member(t, "Org1MSP"), "GetBallot", id, strings.Repeat("0", 64)),
		"There's no ballot with tracking code "+strings.Repeat("0", 64)+" in election budget-2027.")

	// Closing: trustees only.
	refused(t, n.endorse(trustee(t, "Org4MSP"), "CloseElection", id), "Org4MSP isn't a trustee of this election.")
	refused(t, n.endorse(member(t, "Org2MSP"), "CloseElection", id), "This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.")
	refused(t, n.endorse(idemixCreator("Org2MSP"), "CloseElection", id), "This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.")
	ok(t, n.submit(trustee(t, "Org2MSP"), "CloseElection", id))
	ok(t, n.submit(trustee(t, "Org3MSP"), "CloseElection", id))
	refused(t, n.endorse(grace.Voter.identity(t), "CastBallot", id, grace.JSON), "Voting has closed.")
	refused(t, n.endorse(idemixCreator("ChairVoters2027MSP"), "CastAnonymousBallot", id, grace.JSON, "{}"), "Voting has closed.")
	refused(t, n.endorse(trustee(t, "Org1MSP"), "CloseElection", id), "Voting has already closed: the election is in decrypting.")
	refused(t, n.endorse(member(t, "Org1MSP"), "PublishTally", id), "The tally needs 2 decryption shares; 0 have been posted.")

	// Decryption shares: one per trustee, while decrypting. These shares
	// are for the vector's five ballots, not this election's one, so each
	// fails its proof.
	refused(t, n.endorse(trustee(t, "Org4MSP"), "PostDecryptionShare", id, "{}"), "Org4MSP isn't a trustee of this election.")
	refused(t, n.endorse(trustee(t, "Org1MSP"), "PostDecryptionShare", id, v.shares[id][0]), "Share 0 from Org1MSP does not match its key.")
}

func TestTallyRefusals(t *testing.T) {
	v, n := budget(t, 4)
	id := "budget-2027"
	castAll(t, v, n, id)
	closeByK(t, v, n, id)
	org1 := trustee(t, "Org1MSP")
	ok(t, n.submit(org1, "PostDecryptionShare", id, v.shares[id][0]))
	refused(t, n.endorse(org1, "PostDecryptionShare", id, v.shares[id][0]), "Org1MSP has already posted its decryption share.")
	refused(t, n.endorse(member(t, "Org1MSP"), "PublishTally", id), "The tally needs 2 decryption shares; 1 has been posted.")
	ok(t, n.submit(trustee(t, "Org3MSP"), "PostDecryptionShare", id, v.shares[id][2]))
	refused(t, n.endorse(idemixCreator("ChairVoters2027MSP"), "PublishTally", id), "This identity can't publish the tally: it isn't an X.509 identity.")
	ok(t, n.submit(member(t, "Org1MSP"), "PublishTally", id))
	terminal(t, n, stateCounted)
	refused(t, n.endorse(trustee(t, "Org2MSP"), "PostDecryptionShare", id, v.shares[id][1]), "The election is in counted: decryption shares are posted while it is in decrypting.")

	shares := ok(t, n.submit(member(t, "Org2MSP"), "GetDecryptionShares", id))
	var view sharesView
	if err := json.Unmarshal(shares.payload, &view); err != nil || len(view.Shares) != 2 || view.Shares[0].Msp != "Org1MSP" || view.Shares[1].Msp != "Org3MSP" {
		t.Errorf("GetDecryptionShares gave %s", shares.payload)
	}
	cer := ok(t, n.submit(member(t, "Org2MSP"), "GetCeremony", id))
	var cv ceremonyView
	if err := json.Unmarshal(cer.payload, &cv); err != nil || len(cv.Trustees) != 3 {
		t.Fatalf("GetCeremony gave %s", cer.payload)
	}
	for i, tr := range cv.Trustees {
		if string(tr.Round1) == "null" || string(tr.Round2) == "null" || string(tr.Confirmation) == "null" || tr.CloseRequested != (i < 2) {
			t.Errorf("GetCeremony's trustee %d: %+v", i, tr)
		}
	}
}
