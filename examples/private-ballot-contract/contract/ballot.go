package contract

import (
	"encoding/json"
	"fmt"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"

	"github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract/internal/tally"
)

type bitProof struct {
	C0 string `json:"c0"`
	C1 string `json:"c1"`
	Z0 string `json:"z0"`
	Z1 string `json:"z1"`
}

type sumProof struct {
	C string `json:"c"`
	Z string `json:"z"`
}

// ballotDoc is a ballot as the contract stores it, with its fields in the
// order the specification lists them.
type ballotDoc struct {
	V           json.Number        `json:"v"` // 1, however the argument wrote it
	ElectionID  string             `json:"electionId"`
	Ciphertexts []tally.Ciphertext `json:"ciphertexts"`
	BitProofs   []bitProof         `json:"bitProofs"`
	SumProof    sumProof           `json:"sumProof"`
}

// storedBallot is the value at ballot <id> <txId>.
type storedBallot struct {
	Tracking string    `json:"tracking"`
	Ballot   ballotDoc `json:"ballot"`
}

// lookups answers the verifiers' ledger questions for one election, and
// keeps the first error the ledger returns.
type lookups struct {
	l   ledger
	id  string
	err error
}

func (k *lookups) has(objectType, value string) bool {
	b, err := k.l.get(objectType, k.id, value)
	if err != nil && k.err == nil {
		k.err = err
	}
	return b != nil
}

func (k *lookups) HasCiphertext(a string) bool { return k.has(keyCiphertext, a) }
func (k *lookups) HasVoted(tag string) bool    { return k.has(keyVoted, tag) }

// votingState refuses a ballot in any state but open.
func votingState(r *Record) error {
	switch r.State {
	case stateOpen:
		return nil
	case stateDecrypting, stateCounted:
		return errVotingClosed()
	default:
		return errNotOpen(r.State)
	}
}

// votesIn reports whether the creator is an X.509 identity of one of the
// election's voter organisations.
func votesIn(r *Record, c *caller) bool {
	if r.Voters.Kind != "x509" || !c.x509() {
		return false
	}
	for _, m := range r.Voters.Msps {
		if m == c.msp {
			return true
		}
	}
	return false
}

type castResult struct {
	ElectionID string `json:"electionId"`
	TxID       string `json:"txId"`
	Tracking   string `json:"tracking"`
}

type castEvent struct {
	ElectionID string `json:"electionId"`
	Tracking   string `json:"tracking"`
}

// CastBallot(electionId, ballotJson): an X.509 voter of one of the
// election's voter organisations, while it is open, with the checks in the
// specification's order and the voter tag from the creator.
func castBallot(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	l := ledger{stub}
	r, err := l.election(args[0])
	if err != nil {
		return nil, err
	}
	if err := votingState(r); err != nil {
		return nil, err
	}
	c, err := creator(stub)
	if err != nil {
		return nil, err
	}
	if !votesIn(r, c) {
		return nil, errNotVoter(c.msp)
	}
	channel := stub.GetChannelID()
	p, err := r.prepared(channel)
	if err != nil {
		return nil, err
	}
	tag := tally.VoterTagX509(channel, r.ID, c.msp, c.idBytes)
	look := &lookups{l: l, id: r.ID}
	checked, err := tally.CheckBallot(p, tag, args[1], look, false)
	if look.err != nil {
		return nil, look.err
	}
	if err != nil {
		return nil, err
	}
	doc := ballotDoc{}
	if _, err := canonical(args[1], &doc); err != nil {
		return nil, err
	}
	doc.V = "1"
	txID := stub.GetTxID()
	if err := l.putJSON(storedBallot{checked.Tracking, doc}, keyBallot, r.ID, txID); err != nil {
		return nil, err
	}
	tx := []byte(txID)
	if err := l.put(tx, keyTracking, r.ID, checked.Tracking); err != nil {
		return nil, err
	}
	for _, ct := range checked.Ballot.Ciphertexts {
		if err := l.put(tx, keyCiphertext, r.ID, ct.A); err != nil {
			return nil, err
		}
	}
	// Fabric deletes a key written with an empty value, so each marker
	// holds the transaction ID.
	if err := l.put(tx, keyVoted, r.ID, tally.ToHex(tag)); err != nil {
		return nil, err
	}
	out, err := marshal(castResult{r.ID, txID, checked.Tracking})
	if err != nil {
		return nil, err
	}
	return out, l.event("BallotCast", castEvent{r.ID, checked.Tracking})
}

// CastAnonymousBallot(electionId, ballotJson, pseudonymJson): for elections
// with voter credentials, which this version of the contract can't create,
// so every call is refused after the election's state.
func castAnonymousBallot(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	l := ledger{stub}
	r, err := l.election(args[0])
	if err != nil {
		return nil, err
	}
	if err := votingState(r); err != nil {
		return nil, err
	}
	c, err := creator(stub)
	if err != nil {
		return nil, err
	}
	if r.Voters.Kind == "x509" {
		return nil, errNotVoter(c.msp)
	}
	return nil, errIdemixUnsupported()
}

type ballotView struct {
	TxID     string    `json:"txId"`
	Tracking string    `json:"tracking"`
	Ballot   ballotDoc `json:"ballot"`
}

// GetBallot(electionId, tracking): a ballot by its tracking code.
func getBallot(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	l := ledger{stub}
	r, err := l.election(args[0])
	if err != nil {
		return nil, err
	}
	tx, err := l.get(keyTracking, r.ID, args[1])
	if err != nil {
		return nil, err
	}
	if tx == nil {
		return nil, errNoBallot(args[1], r.ID)
	}
	b, err := l.get(keyBallot, r.ID, string(tx))
	if err != nil {
		return nil, err
	}
	if b == nil {
		return nil, fmt.Errorf("contract: tracking code %s points to transaction %s, which has no ballot", args[1], tx)
	}
	var s storedBallot
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, fmt.Errorf("contract: the ballot in %s doesn't decode: %w", tx, err)
	}
	return marshal(ballotView{string(tx), s.Tracking, s.Ballot})
}
