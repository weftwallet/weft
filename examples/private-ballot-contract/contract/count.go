package contract

import (
	"encoding/json"
	"fmt"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"

	"github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract/internal/tally"
)

type closeRequestedEvent struct {
	ElectionID string `json:"electionId"`
	Trustee    string `json:"trustee"`
}

type closedEvent struct {
	ElectionID string   `json:"electionId"`
	Ballots    int      `json:"ballots"`
	ClosedBy   []string `json:"closedBy"`
}

// acceptedBallots reads every accepted ballot of the election by range, in
// key order, so the close's read set covers the whole range.
func acceptedBallots(stub shim.ChaincodeStubInterface, id string) ([][]tally.Ciphertext, error) {
	it, err := stub.GetStateByPartialCompositeKey(keyBallot, []string{id})
	if err != nil {
		return nil, err
	}
	defer it.Close()
	var out [][]tally.Ciphertext
	for it.HasNext() {
		kv, err := it.Next()
		if err != nil {
			return nil, err
		}
		var s storedBallot
		if err := json.Unmarshal(kv.GetValue(), &s); err != nil {
			return nil, fmt.Errorf("contract: a stored ballot of %s doesn't decode: %w", id, err)
		}
		out = append(out, s.Ballot.Ciphertexts)
	}
	return out, nil
}

// CloseElection(electionId): a trustee asks to close voting. The request
// that brings the number of trustees who have asked to k closes the
// election, adds up the accepted ballots per option and moves it to
// decrypting.
func closeElection(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	l := ledger{stub}
	r, err := l.election(args[0])
	if err != nil {
		return nil, err
	}
	c, err := creator(stub)
	if err != nil {
		return nil, err
	}
	if _, err := c.asTrustee(r); err != nil {
		return nil, err
	}
	switch r.State {
	case stateOpen:
	case stateDecrypting, stateCounted:
		return nil, errAlreadyClosed(r.State)
	default:
		return nil, errNotOpen(r.State)
	}
	// A transaction doesn't read its own writes, so the caller's request
	// counts whether it is on the ledger already or written now.
	var asked []string
	for _, t := range r.Trustees {
		b, err := l.get(keyClose, r.ID, t.Msp)
		if err != nil {
			return nil, err
		}
		if b != nil || t.Msp == c.msp {
			asked = append(asked, t.Msp)
		}
		if b == nil && t.Msp == c.msp {
			if err := l.put([]byte(stub.GetTxID()), keyClose, r.ID, t.Msp); err != nil {
				return nil, err
			}
		}
	}
	if len(asked) < r.Threshold {
		out, err := marshal(r)
		if err != nil {
			return nil, err
		}
		return out, l.event("CloseRequested", closeRequestedEvent{r.ID, c.msp})
	}
	ballots, err := acceptedBallots(stub, r.ID)
	if err != nil {
		return nil, err
	}
	totals, n, err := tally.AddTotals(len(r.Options), ballots)
	if err != nil {
		return nil, err
	}
	r.Ballots, r.Totals, r.ClosedBy, r.State = &n, totals, asked, stateDecrypting
	out, err := l.saveElection(r)
	if err != nil {
		return nil, err
	}
	return out, l.event("ElectionClosed", closedEvent{r.ID, n, asked})
}

type sharePostedEvent struct {
	ElectionID string `json:"electionId"`
	Trustee    string `json:"trustee"`
}

// PostDecryptionShare(electionId, shareJson): a trustee's share of each
// total, with its proofs, while the election is decrypting.
func postDecryptionShare(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	l := ledger{stub}
	r, err := l.election(args[0])
	if err != nil {
		return nil, err
	}
	c, err := creator(stub)
	if err != nil {
		return nil, err
	}
	i, err := c.asTrustee(r)
	if err != nil {
		return nil, err
	}
	if r.State != stateDecrypting {
		return nil, errNotDecrypting(r.State)
	}
	posted, err := l.get(keyDShare, r.ID, c.msp)
	if err != nil {
		return nil, err
	}
	if posted != nil {
		return nil, errSharePosted(c.msp)
	}
	p, err := r.prepared(stub.GetChannelID())
	if err != nil {
		return nil, err
	}
	share, err := tally.CheckDecryptionShare(p, r.Totals, i, args[1])
	if err != nil {
		return nil, err
	}
	if err := l.putJSON(share, keyDShare, r.ID, c.msp); err != nil {
		return nil, err
	}
	out, err := marshal(r)
	if err != nil {
		return nil, err
	}
	return out, l.event("DecryptionSharePosted", sharePostedEvent{r.ID, c.msp})
}

// postedShares reads every trustee's decryption share, in trustee order.
func postedShares(l ledger, r *Record) ([]tally.PostedShare, error) {
	var out []tally.PostedShare
	for i, t := range r.Trustees {
		b, err := l.get(keyDShare, r.ID, t.Msp)
		if err != nil {
			return nil, err
		}
		if b == nil {
			continue
		}
		var s tally.DecryptionShare
		if err := json.Unmarshal(b, &s); err != nil {
			return nil, fmt.Errorf("contract: the decryption share of %s doesn't decode: %w", t.Msp, err)
		}
		out = append(out, tally.PostedShare{Index: i, Share: s})
	}
	return out, nil
}

type publishedEvent struct {
	ElectionID string `json:"electionId"`
	Counts     Counts `json:"counts"`
	Total      int    `json:"total"`
}

// PublishTally(electionId): anyone with an X.509 identity, once k trustees
// have posted shares. It combines the k with the lowest identifiers.
func publishTally(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	l := ledger{stub}
	r, err := l.election(args[0])
	if err != nil {
		return nil, err
	}
	c, err := creator(stub)
	if err != nil {
		return nil, err
	}
	if !c.x509() {
		return nil, errNotX509("publish the tally")
	}
	switch r.State {
	case stateDecrypting:
	case stateCounted:
		return nil, errTallyPublished()
	default:
		return nil, errCantPublish(r.State)
	}
	posted, err := postedShares(l, r)
	if err != nil {
		return nil, err
	}
	p, err := r.prepared(stub.GetChannelID())
	if err != nil {
		return nil, err
	}
	if r.Ballots == nil {
		return nil, fmt.Errorf("contract: election %s is decrypting with no ballot count", r.ID)
	}
	res, err := tally.RecoverTally(p, r.Totals, *r.Ballots, posted)
	if err != nil {
		return nil, err
	}
	t := &Tally{Total: res.Total}
	for j, o := range r.Options {
		t.Counts = append(t.Counts, Count{o, res.Counts[j]})
	}
	r.Tally, r.State = t, stateCounted
	out, err := l.saveElection(r)
	if err != nil {
		return nil, err
	}
	return out, l.event("TallyPublished", publishedEvent{r.ID, t.Counts, t.Total})
}

type trusteeShares struct {
	ID     string             `json:"id"`
	Msp    string             `json:"msp"`
	Shares []tally.ShareEntry `json:"shares"`
}

type sharesView struct {
	ElectionID string          `json:"electionId"`
	Shares     []trusteeShares `json:"shares"`
}

// GetDecryptionShares(electionId): every posted share, in trustee order.
func getDecryptionShares(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	l := ledger{stub}
	r, err := l.election(args[0])
	if err != nil {
		return nil, err
	}
	posted, err := postedShares(l, r)
	if err != nil {
		return nil, err
	}
	v := sharesView{ElectionID: r.ID, Shares: []trusteeShares{}}
	for _, s := range posted {
		t := r.Trustees[s.Index]
		v.Shares = append(v.Shares, trusteeShares{t.ID, t.Msp, s.Share.Shares})
	}
	return marshal(v)
}
