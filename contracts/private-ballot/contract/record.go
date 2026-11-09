package contract

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"

	"github.com/weftwallet/weft/contracts/private-ballot/internal/tally"
	"github.com/weftwallet/weft/contracts/private-ballot/pseudonym"
)

// The election states (contract-api.md, Election states).
const (
	stateKeygen     = "keygen"
	stateOpen       = "open"
	stateDecrypting = "decrypting"
	stateCounted    = "counted"
	stateFailed     = "failed"
	stateCancelled  = "cancelled"
)

// The object types of the composite keys (contract-api.md, State keys).
const (
	keyElection   = "election"
	keyCeremony1  = "ceremony1"
	keyCeremony2  = "ceremony2"
	keyConfirm    = "confirm"
	keyBallot     = "ballot"
	keyTracking   = "tracking"
	keyCiphertext = "ciphertext"
	keyVoted      = "voted"
	keyClose      = "close"
	keyDShare     = "dshare"
)

// Trustee is an entry of the record's trustee list: its identifier, the
// scalar i as lowercase hex, and its MSP ID.
type Trustee struct {
	ID  string `json:"id"`
	Msp string `json:"msp"`
}

// Voters says who votes: X.509 identities of the organisations in Msps
// (kind "x509"), or voter credentials (kind "idemix") of the idemix
// organisation Msp whose organisational unit is Affiliation and whose role
// is member, from the pinned issuer key. Each kind marshals its own fields,
// in the order contract-api.md lists them.
type Voters struct {
	Kind            string   `json:"kind"`
	Msps            []string `json:"msps"`
	Msp             string   `json:"msp"`
	Affiliation     string   `json:"affiliation"`
	Role            string   `json:"role"`
	IssuerPublicKey string   `json:"issuerPublicKey"`
	IssuerKeyHash   string   `json:"issuerKeyHash"`
	Curve           string   `json:"curve"`
}

type x509Voters struct {
	Kind string   `json:"kind"`
	Msps []string `json:"msps"`
}

type idemixVoters struct {
	Kind            string `json:"kind"`
	Msp             string `json:"msp"`
	Affiliation     string `json:"affiliation"`
	Role            string `json:"role"`
	IssuerPublicKey string `json:"issuerPublicKey"`
	IssuerKeyHash   string `json:"issuerKeyHash"`
	Curve           string `json:"curve"`
}

// MarshalJSON writes the kind's fields only, every one of them.
func (v Voters) MarshalJSON() ([]byte, error) {
	if v.Kind == votersIdemix {
		return marshal(idemixVoters{v.Kind, v.Msp, v.Affiliation, v.Role, v.IssuerPublicKey, v.IssuerKeyHash, v.Curve})
	}
	return marshal(x509Voters{v.Kind, v.Msps})
}

// The kinds of voters.
const (
	votersX509   = "x509"
	votersIdemix = "idemix"
)

// Count is one option's count, kept in option order.
type Count struct {
	Option string
	N      int
}

// Counts marshals as { "<option>": n, ... } in option order.
type Counts []Count

func (c Counts) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, x := range c {
		if i > 0 {
			b.WriteByte(',')
		}
		k, err := marshal(x.Option)
		if err != nil {
			return nil, err
		}
		b.Write(k)
		fmt.Fprintf(&b, ":%d", x.N)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func (c *Counts) UnmarshalJSON(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return fmt.Errorf("contract: counts aren't an object")
	}
	*c = nil
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return err
		}
		var n int
		if err := dec.Decode(&n); err != nil {
			return err
		}
		*c = append(*c, Count{Option: t.(string), N: n})
	}
	return nil
}

// Tally is what PublishTally writes.
type Tally struct {
	Counts Counts `json:"counts"`
	Total  int    `json:"total"`
}

// Record is the election record (contract-api.md, The election record),
// with its fields in the documented order.
type Record struct {
	V               int                `json:"v"`
	ID              string             `json:"id"`
	Title           string             `json:"title"`
	Options         []string           `json:"options"`
	ClosesAt        string             `json:"closesAt"`
	CreatorMsp      string             `json:"creatorMsp"`
	Trustees        []Trustee          `json:"trustees"`
	Threshold       int                `json:"threshold"`
	Voters          Voters             `json:"voters"`
	State           string             `json:"state"`
	PublicKey       string             `json:"publicKey,omitempty"`
	VerifyingShares []string           `json:"verifyingShares,omitempty"`
	Context         string             `json:"context,omitempty"`
	Fingerprint     string             `json:"fingerprint,omitempty"`
	Ballots         *int               `json:"ballots,omitempty"`
	Totals          []tally.Ciphertext `json:"totals,omitempty"`
	ClosedBy        []string           `json:"closedBy,omitempty"`
	Tally           *Tally             `json:"tally,omitempty"`
	ReportedBy      string             `json:"reportedBy,omitempty"`
}

// msps returns the trustees' MSP IDs in the order of the trustee list.
func (r *Record) msps() []string {
	out := make([]string, len(r.Trustees))
	for i, t := range r.Trustees {
		out[i] = t.Msp
	}
	return out
}

// trusteeIndex returns the 0-based index of the trustee with this MSP ID, or -1.
func (r *Record) trusteeIndex(msp string) int {
	for i, t := range r.Trustees {
		if t.Msp == msp {
			return i
		}
	}
	return -1
}

// setup is what the verifiers need of the election before it opens.
func (r *Record) setup(channel, chaincode string) tally.Setup {
	return tally.Setup{
		Channel:    channel,
		Chaincode:  chaincode,
		ElectionID: r.ID,
		Options:    r.Options,
		Threshold:  r.Threshold,
		Trustees:   r.msps(),
	}
}

// prepared is the open election as the verifiers need it, with the context
// fixed when it opened.
func (r *Record) prepared(channel string) (*tally.Prepared, error) {
	ctx, ok := tally.FromHex(r.Context, 32)
	if !ok {
		return nil, fmt.Errorf("contract: election %s has no context", r.ID)
	}
	e := &tally.Election{Setup: r.setup(channel, ""), Keys: tally.Keys{PublicKey: r.PublicKey, VerifyingShares: r.VerifyingShares}}
	return tally.PrepareWithContext(e, ctx)
}

// issuerKey decodes the pinned issuer key of an election with voter
// credentials, which CreateElection checked.
func (r *Record) issuerKey() (*pseudonym.Key, error) {
	raw, err := base64.StdEncoding.DecodeString(r.Voters.IssuerPublicKey)
	if err != nil {
		return nil, fmt.Errorf("contract: election %s's issuer key isn't base64: %w", r.ID, err)
	}
	key, err := pseudonym.LoadIssuerKey(raw)
	if err != nil {
		return nil, fmt.Errorf("contract: election %s's issuer key doesn't load: %w", r.ID, err)
	}
	return key, nil
}

// marshal is encoding/json without HTML escaping and without the trailing
// newline. Struct fields marshal in declaration order, so the bytes are the
// same on every endorser.
func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

type ledger struct{ stub shim.ChaincodeStubInterface }

func (l ledger) key(objectType string, attributes ...string) (string, error) {
	return l.stub.CreateCompositeKey(objectType, attributes)
}

// get returns the value at a composite key, or nil if there is none. A key
// that can't be made (an attribute with U+0000 in it) has no value.
func (l ledger) get(objectType string, attributes ...string) ([]byte, error) {
	k, err := l.key(objectType, attributes...)
	if err != nil {
		return nil, nil
	}
	return l.stub.GetState(k)
}

func (l ledger) put(value []byte, objectType string, attributes ...string) error {
	k, err := l.key(objectType, attributes...)
	if err != nil {
		return err
	}
	return l.stub.PutState(k, value)
}

func (l ledger) putJSON(v any, objectType string, attributes ...string) error {
	b, err := marshal(v)
	if err != nil {
		return err
	}
	return l.put(b, objectType, attributes...)
}

// election reads the election record, refusing an unknown ID.
func (l ledger) election(id string) (*Record, error) {
	b, err := l.get(keyElection, id)
	if err != nil {
		return nil, err
	}
	if b == nil {
		return nil, errNoElection(id)
	}
	r := &Record{}
	if err := json.Unmarshal(b, r); err != nil {
		return nil, fmt.Errorf("contract: election %s doesn't decode: %w", id, err)
	}
	return r, nil
}

func (l ledger) saveElection(r *Record) ([]byte, error) {
	b, err := marshal(r)
	if err != nil {
		return nil, err
	}
	return b, l.put(b, keyElection, r.ID)
}

// event sets the transaction's one event, its payload JSON with electionId first.
func (l ledger) event(name string, payload any) error {
	b, err := marshal(payload)
	if err != nil {
		return err
	}
	return l.stub.SetEvent(name, b)
}
