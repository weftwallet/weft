package contract

import (
	"encoding/json"
	"fmt"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"

	"github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract/internal/tally"
	"github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract/pseudonym"
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

// storedBallot is the value at ballot <id> <txId>, with the pseudonym
// proof of a ballot cast with a voter credential.
type storedBallot struct {
	Tracking  string          `json:"tracking"`
	Ballot    ballotDoc       `json:"ballot"`
	Pseudonym *pseudonym.JSON `json:"pseudonym,omitempty"`
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

// x509Voter checks CastBallot's caller, after the election's state: the
// election has X.509 voters, the creator's MSP ID is one of its voter
// organisations, the creator is an X.509 identity, and its certificate
// parses and has an enrolment ID, which it returns.
func x509Voter(r *Record, c *caller) (string, error) {
	if r.Voters.Kind != votersX509 {
		return "", errUseAnonymous()
	}
	named := false
	for _, m := range r.Voters.Msps {
		named = named || m == c.msp
	}
	if !named {
		return "", errNotVoter(c.msp)
	}
	if !c.x509() {
		return "", errNotX509("vote in this election")
	}
	return tally.EnrolmentID(c.idBytes)
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
// specification's order and the voter tag from the creator's MSP ID and
// enrolment ID. The tag doesn't depend on how the certificate's PEM is
// written or on which of the CA's certificates for that ID signed, so a
// voter who sends the certificate again in another spelling, or enrols
// again, has voted already.
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
	enrolmentID, err := x509Voter(r, c)
	if err != nil {
		return nil, err
	}
	channel := stub.GetChannelID()
	p, err := r.prepared(channel)
	if err != nil {
		return nil, err
	}
	tag := tally.VoterTagX509(channel, r.ID, c.msp, enrolmentID)
	look := &lookups{l: l, id: r.ID}
	checked, err := tally.CheckBallot(p, tag, args[1], look, false)
	if look.err != nil {
		return nil, look.err
	}
	if err != nil {
		return nil, err
	}
	return storeBallot(stub, l, r, args[1], checked, tag, nil)
}

// storeBallot writes an accepted ballot, its tracking code, its
// ciphertexts' first components and the voter's marker, and returns
// CastBallot's result with the event BallotCast.
func storeBallot(stub shim.ChaincodeStubInterface, l ledger, r *Record, ballotJSON string, checked *tally.CheckedBallot, tag []byte, proof *pseudonym.JSON) ([]byte, error) {
	doc := ballotDoc{}
	if _, err := canonical(ballotJSON, &doc); err != nil {
		return nil, err
	}
	doc.V = "1"
	txID := stub.GetTxID()
	if err := l.putJSON(storedBallot{checked.Tracking, doc, proof}, keyBallot, r.ID, txID); err != nil {
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

// CastAnonymousBallot(electionId, ballotJson, pseudonymJson): a voter
// credential of the election's voter organisation, with its affiliation and
// the role member, while the election is open, with the checks in the
// specification's order (private-tally-spec.md, What the contract checks):
//
//  1. the election is open;
//  2. it has voter credentials;
//  3. the creator's MSP ID is the election's voter MSP;
//  4. the creator is an idemix identity whose Nym is a point of G1;
//  5. its organisational unit is the election's affiliation, and its role
//     is member;
//  6. its proof verifies against the pinned issuer key with that
//     affiliation and role, as the peer's idemix MSP checks it against the
//     channel's key;
//  7. the ballot parses and decodes;
//  8. the pseudonym proof parses and decodes;
//  9. the voter tag from P, and the tracking code;
//  10. the pseudonym proof, against the creator's Nym, the pinned issuer key
//     and the tracking code;
//  11. to 14. the bit proofs, the sum proof, repeated ciphertexts, and the
//     credential's earlier ballot, by the voter tag.
func castAnonymousBallot(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	l := ledger{stub}
	r, err := l.election(args[0])
	if err != nil {
		return nil, err
	}
	if err := votingState(r); err != nil {
		return nil, err
	}
	if r.Voters.Kind != votersIdemix {
		return nil, errUseCastBallot()
	}
	c, err := creator(stub)
	if err != nil {
		return nil, err
	}
	if c.msp != r.Voters.Msp {
		return nil, errNotVoter(c.msp)
	}
	sid, nym, ok := c.idemixNym()
	if !ok {
		return nil, errNotCredential()
	}
	ou, role := c.idemixAttributes()
	if ou != r.Voters.Affiliation {
		return nil, errAffiliation(r.Voters.Affiliation)
	}
	if role != roleMember {
		return nil, errRole()
	}
	key, err := r.issuerKey()
	if err != nil {
		return nil, err
	}
	if err := credentialProof(key, sid, nym, ou); err != nil {
		return nil, err
	}
	channel := stub.GetChannelID()
	p, err := r.prepared(channel)
	if err != nil {
		return nil, err
	}
	d, err := tally.ParseBallot(&p.Setup, args[1])
	if err != nil {
		return nil, err
	}
	fields, err := tally.ParsePseudonym(args[2])
	if err != nil {
		return nil, err
	}
	proof, err := pseudonym.Decode(pseudonym.JSON{Pseudonym: fields.Pseudonym, C: fields.C, SSk: fields.SSk, SR: fields.SR})
	if err != nil {
		return nil, err
	}
	tag := tally.VoterTagIdemix(channel, r.ID, c.msp, proof.PBytes())
	tracking, _ := tally.FromHex(tally.TrackingCode(p, tag, d), 32)
	st := &pseudonym.Statement{Key: key, Channel: channel, ElectionID: r.ID, Tracking: tracking, Nym: nym}
	if err := pseudonym.Verify(st, proof); err != nil {
		return nil, err
	}
	look := &lookups{l: l, id: r.ID}
	checked, err := tally.CheckDecoded(p, tag, d, look, true)
	if look.err != nil {
		return nil, look.err
	}
	if err != nil {
		return nil, err
	}
	stored := proof.JSON()
	return storeBallot(stub, l, r, args[1], checked, tag, &stored)
}

type ballotView struct {
	TxID      string          `json:"txId"`
	Tracking  string          `json:"tracking"`
	Ballot    ballotDoc       `json:"ballot"`
	Pseudonym *pseudonym.JSON `json:"pseudonym,omitempty"`
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
	return marshal(ballotView{string(tx), s.Tracking, s.Ballot, s.Pseudonym})
}
