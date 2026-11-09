package contract

import (
	"encoding/json"
	"fmt"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"

	"github.com/weftwallet/weft/contracts/private-ballot/internal/tally"
)

// The posts as the contract stores them: the checked argument, written
// again with its fields in the format's order.
type round1Post struct {
	Commitments []string `json:"commitments"`
	Proof       string   `json:"proof"`
	CeremonyKey string   `json:"ceremonyKey"`
}

type shareBox struct {
	To    string `json:"to"`
	Nonce string `json:"nonce"`
	Box   string `json:"box"`
}

type round2Post struct {
	Shares []shareBox `json:"shares"`
}

type confirmationPost struct {
	C string `json:"c"`
	Z string `json:"z"`
}

// canonical re-reads an argument that has already passed the strict parser,
// so it has exactly the format's fields with the right types, and writes it
// with its fields in the format's order. A repeated name keeps its last
// value, as in the strict parser.
func canonical(text string, v any) ([]byte, error) {
	if err := json.Unmarshal([]byte(text), v); err != nil {
		return nil, fmt.Errorf("contract: a checked argument doesn't decode: %w", err)
	}
	return marshal(v)
}

type stepEvent struct {
	ElectionID string `json:"electionId"`
	Round      int    `json:"round"`
	Trustee    string `json:"trustee"`
}

// ceremonyCall reads the election and checks the caller and the state, for
// the ceremony's rounds and ReportBadShare.
func ceremonyCall(stub shim.ChaincodeStubInterface, id string) (ledger, *Record, *caller, int, error) {
	l := ledger{stub}
	r, err := l.election(id)
	if err != nil {
		return l, nil, nil, -1, err
	}
	c, err := creator(stub)
	if err != nil {
		return l, nil, nil, -1, err
	}
	i, err := c.asTrustee(r)
	if err != nil {
		return l, nil, nil, -1, err
	}
	if r.State != stateKeygen {
		return l, nil, nil, -1, errCeremonyEnded(r.State)
	}
	return l, r, c, i, nil
}

// postRound checks that the rounds before this one are finished and that
// this trustee hasn't posted it, runs check, and stores what it returns.
func postRound(stub shim.ChaincodeStubInterface, args []string, round int, check func(l ledger, r *Record, i int) ([]byte, error)) ([]byte, error) {
	l, r, c, i, err := ceremonyCall(stub, args[0])
	if err != nil {
		return nil, err
	}
	if err := roundsFinished(l, r, round-1); err != nil {
		return nil, err
	}
	posted, err := l.get(roundKeys[round-1], r.ID, c.msp)
	if err != nil {
		return nil, err
	}
	if posted != nil {
		return nil, errAlreadyPosted(c.msp, round)
	}
	value, err := check(l, r, i)
	if err != nil {
		return nil, err
	}
	if err := l.put(value, roundKeys[round-1], r.ID, c.msp); err != nil {
		return nil, err
	}
	out, err := marshal(r)
	if err != nil {
		return nil, err
	}
	return out, l.event("CeremonyStep", stepEvent{r.ID, round, c.msp})
}

// PostCommitments(electionId, round1Json): round 1.
func postCommitments(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	return postRound(stub, args, 1, func(_ ledger, r *Record, i int) ([]byte, error) {
		s := r.setup(stub.GetChannelID(), "")
		if _, err := tally.CheckRound1(&s, i, args[1]); err != nil {
			return nil, err
		}
		return canonical(args[1], &round1Post{})
	})
}

// PostShares(electionId, round2Json): round 2, once every trustee has posted round 1.
func postShares(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	return postRound(stub, args, 2, func(_ ledger, r *Record, i int) ([]byte, error) {
		s := r.setup(stub.GetChannelID(), "")
		if err := tally.CheckRound2(&s, i, args[1]); err != nil {
			return nil, err
		}
		return canonical(args[1], &round2Post{})
	})
}

// ConfirmShares(electionId, proofJson): round 3, once every trustee has
// posted round 2, checked against the verifying share computed from the
// round 1 commitments.
func confirmShares(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	return postRound(stub, args, 3, func(l ledger, r *Record, i int) ([]byte, error) {
		e, err := electionKeys(stub, l, r)
		if err != nil {
			return nil, err
		}
		p, err := tally.Prepare(e)
		if err != nil {
			return nil, err
		}
		if err := tally.CheckConfirmation(p, i, args[1]); err != nil {
			return nil, err
		}
		return canonical(args[1], &confirmationPost{})
	})
}

type failedEvent struct {
	ElectionID  string `json:"electionId"`
	ReportedBy  string `json:"reportedBy"`
	FromTrustee string `json:"fromTrustee"`
}

// ReportBadShare(electionId, fromTrustee): a trustee's share failed its
// check, so the election moves to failed, with the reporting organisation
// in the record. fromTrustee is the sender's identifier, as in the record's
// trustee list. A trustee that has confirmed has accepted its shares, so it
// can't report one.
func reportBadShare(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	l, r, c, i, err := ceremonyCall(stub, args[0])
	if err != nil {
		return nil, err
	}
	if err := roundsFinished(l, r, 2); err != nil {
		return nil, err
	}
	confirmed, err := l.get(keyConfirm, r.ID, c.msp)
	if err != nil {
		return nil, err
	}
	if confirmed != nil {
		return nil, errAlreadyConfirmed(c.msp)
	}
	from := -1
	for j, t := range r.Trustees {
		if t.ID == args[1] && j != i {
			from = j
		}
	}
	if from < 0 {
		return nil, errNotAnotherTrustee(args[1])
	}
	r.State, r.ReportedBy = stateFailed, c.msp
	out, err := l.saveElection(r)
	if err != nil {
		return nil, err
	}
	return out, l.event("ElectionFailed", failedEvent{r.ID, c.msp, r.Trustees[from].Msp})
}
