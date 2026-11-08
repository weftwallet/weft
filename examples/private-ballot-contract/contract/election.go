package contract

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"

	"github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract/internal/tally"
	"github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract/pseudonym"
)

var electionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

var closesAtPattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$`)

// closesAtLayout is the form of closesAt, as JavaScript's toISOString writes it.
const closesAtLayout = "2006-01-02T15:04:05.000Z"

// maxTitle is the longest title, in Unicode code points, which Go and
// JavaScript count the same way.
const maxTitle = 200

// parseClosesAt checks the form and that the date exists, and returns the
// time. time.Parse reads no clock.
func parseClosesAt(s string) (time.Time, bool) {
	if !closesAtPattern.MatchString(s) {
		return time.Time{}, false
	}
	t, err := time.Parse(closesAtLayout, s)
	return t, err == nil && t.Format(closesAtLayout) == s
}

// createdAt is the transaction's timestamp, which the client writes in the
// proposal header and every endorser reads the same. It is the only time
// the contract reads, and only CreateElection reads it, to refuse a
// closesAt that has already passed: a client that lies about the time
// there misleads only its own election's planned closing time, which the
// contract never acts on. Ballots and closing read no time.
func createdAt(stub shim.ChaincodeStubInterface) (time.Time, error) {
	ts, err := stub.GetTxTimestamp()
	if err != nil || ts == nil {
		return time.Time{}, fmt.Errorf("contract: no transaction timestamp: %v", err)
	}
	return ts.AsTime().UTC(), nil
}

func allDifferent(xs []string) bool {
	for i := range xs {
		for j := i + 1; j < len(xs); j++ {
			if xs[i] == xs[j] {
				return false
			}
		}
	}
	return true
}

// checkVoters checks electionJson's voters, the last of CreateElection's
// checks. For voter credentials, in this order: the curve, the
// affiliation, the role, the issuer key, which must be base64 of an IBM
// idemix IssuerPublicKey that passes IBM idemix's check with Fabric's four
// attribute names, and issuerKeyHash, which must be SHA-256 of the key's
// bytes as 64 lowercase hex characters. For X.509 voters, the voter
// organisations.
func checkVoters(v *tally.VotersRequest) (Voters, error) {
	if v.Kind == votersX509 {
		if len(v.Msps) < 1 || !allDifferent(v.Msps) {
			return Voters{}, errVoters()
		}
		return Voters{Kind: votersX509, Msps: append([]string{}, v.Msps...)}, nil
	}
	if v.Curve != curveFP256BN {
		return Voters{}, errCurve(v.Curve)
	}
	if v.Affiliation == "" {
		return Voters{}, errAffiliationEmpty()
	}
	if v.Role != roleMember {
		return Voters{}, errRoleNotMember()
	}
	raw, err := base64.StdEncoding.DecodeString(v.IssuerPublicKey)
	if err != nil || base64.StdEncoding.EncodeToString(raw) != v.IssuerPublicKey {
		return Voters{}, errIssuerKey()
	}
	key, err := pseudonym.LoadIssuerKey(raw)
	if err != nil {
		return Voters{}, errIssuerKey()
	}
	if v.IssuerKeyHash != key.HashHex() {
		return Voters{}, errIssuerKeyHash()
	}
	return Voters{
		Kind: votersIdemix, Msp: v.Msp, Affiliation: v.Affiliation, Role: v.Role,
		IssuerPublicKey: v.IssuerPublicKey, IssuerKeyHash: v.IssuerKeyHash, Curve: v.Curve,
	}, nil
}

// The one curve and the one role voter credentials vote with.
const (
	curveFP256BN = "FP256BN_AMCL"
	roleMember   = "member"
)

type electionEvent struct {
	ElectionID string `json:"electionId"`
}

// CreateElection(electionJson), in the order contract-api.md lists the
// checks, after the argument has parsed: the caller, the ID, the title, the
// options, closesAt, the trustees, the threshold, and the voters: the voter
// organisations, or for voter credentials the curve, the affiliation, the
// role, the issuer key and issuerKeyHash.
func createElection(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	req, err := tally.ParseElectionRequest(args[0])
	if err != nil {
		return nil, err
	}
	c, err := creator(stub)
	if err != nil {
		return nil, err
	}
	named := false
	for _, t := range req.Trustees {
		named = named || t == c.msp
	}
	if !named {
		return nil, errNotNamedTrustee(c.msp)
	}
	if !c.trusteeIdentity() {
		return nil, errNoTrusteeAttribute()
	}
	if !electionIDPattern.MatchString(req.ID) {
		return nil, errElectionID()
	}
	l := ledger{stub}
	existing, err := l.get(keyElection, req.ID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, errExists(req.ID)
	}
	if n := utf8.RuneCountInString(req.Title); n < 1 || n > maxTitle {
		return nil, errTitle()
	}
	if len(req.Options) < 2 || len(req.Options) > 20 || !allDifferent(req.Options) {
		return nil, errOptions()
	}
	closesAt, ok := parseClosesAt(req.ClosesAt)
	if !ok {
		return nil, errClosesAt()
	}
	now, err := createdAt(stub)
	if err != nil {
		return nil, err
	}
	if !closesAt.After(now) {
		return nil, errClosesAtPassed(now.Format(closesAtLayout))
	}
	if len(req.Trustees) < 2 || !allDifferent(req.Trustees) {
		return nil, errTrustees()
	}
	k := int(req.Threshold)
	if float64(k) != req.Threshold || k < 2 || k > len(req.Trustees) {
		return nil, errThreshold()
	}
	voters, err := checkVoters(&req.Voters)
	if err != nil {
		return nil, err
	}
	r := &Record{
		V:          1,
		ID:         req.ID,
		Title:      req.Title,
		Options:    req.Options,
		ClosesAt:   req.ClosesAt,
		CreatorMsp: c.msp,
		Threshold:  k,
		Voters:     voters,
		State:      stateKeygen,
	}
	for i, msp := range req.Trustees {
		r.Trustees = append(r.Trustees, Trustee{ID: tally.ToHex(tally.TrusteeID(i)), Msp: msp})
	}
	out, err := l.saveElection(r)
	if err != nil {
		return nil, err
	}
	return out, l.event("ElectionCreated", electionEvent{r.ID})
}

// CancelElection(electionId): a trustee identity of the creator's
// organisation, while the election is in keygen.
func cancelElection(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	l := ledger{stub}
	r, err := l.election(args[0])
	if err != nil {
		return nil, err
	}
	c, err := creator(stub)
	if err != nil {
		return nil, err
	}
	if c.msp != r.CreatorMsp {
		return nil, errNotCreator(c.msp)
	}
	if !c.trusteeIdentity() {
		return nil, errNoTrusteeAttribute()
	}
	if r.State != stateKeygen {
		return nil, errCeremonyEnded(r.State)
	}
	r.State = stateCancelled
	out, err := l.saveElection(r)
	if err != nil {
		return nil, err
	}
	return out, l.event("ElectionCancelled", electionEvent{r.ID})
}

// roundKeys are the state keys of the ceremony's three rounds.
var roundKeys = [3]string{keyCeremony1, keyCeremony2, keyConfirm}

// waitingFor returns the first trustee, in the order of the trustee list,
// that hasn't posted the round, or "" when every trustee has.
func waitingFor(l ledger, r *Record, round int) (string, error) {
	for _, t := range r.Trustees {
		b, err := l.get(roundKeys[round-1], r.ID, t.Msp)
		if err != nil {
			return "", err
		}
		if b == nil {
			return t.Msp, nil
		}
	}
	return "", nil
}

// roundsFinished refuses with the first round, from 1 to last, that a
// trustee hasn't posted.
func roundsFinished(l ledger, r *Record, last int) error {
	for round := 1; round <= last; round++ {
		msp, err := waitingFor(l, r, round)
		if err != nil {
			return err
		}
		if msp != "" {
			return errRoundNotFinished(round, msp)
		}
	}
	return nil
}

// round1Posts reads and decodes every trustee's round 1, in trustee order.
// Each was checked when it was posted, and is checked again here.
func round1Posts(l ledger, r *Record, s *tally.Setup) ([]*tally.Round1, error) {
	var out []*tally.Round1
	for i, t := range r.Trustees {
		b, err := l.get(keyCeremony1, r.ID, t.Msp)
		if err != nil {
			return nil, err
		}
		if b == nil {
			return nil, errRoundNotFinished(1, t.Msp)
		}
		r1, err := tally.CheckRound1(s, i, string(b))
		if err != nil {
			return nil, fmt.Errorf("contract: the stored round 1 from %s doesn't check: %w", t.Msp, err)
		}
		out = append(out, r1)
	}
	return out, nil
}

// electionKeys computes the key, the verifying shares, ctx and the
// fingerprint from the round 1 commitments, with the channel and the
// contract's own name.
func electionKeys(stub shim.ChaincodeStubInterface, l ledger, r *Record) (*tally.Election, error) {
	name, err := chaincodeName(stub)
	if err != nil {
		return nil, err
	}
	s := r.setup(stub.GetChannelID(), name)
	r1, err := round1Posts(l, r, &s)
	if err != nil {
		return nil, err
	}
	return &tally.Election{Setup: s, Keys: tally.ElectionKeys(&s, r1)}, nil
}

type openedEvent struct {
	ElectionID  string `json:"electionId"`
	Fingerprint string `json:"fingerprint"`
}

// OpenElection(electionId): anyone with an X.509 identity, once every
// trustee has confirmed.
func openElection(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
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
		return nil, errNotX509("open the election")
	}
	if r.State != stateKeygen {
		return nil, errCeremonyEnded(r.State)
	}
	if err := roundsFinished(l, r, 3); err != nil {
		return nil, err
	}
	e, err := electionKeys(stub, l, r)
	if err != nil {
		return nil, err
	}
	r.PublicKey = e.PublicKey
	r.VerifyingShares = e.VerifyingShares
	r.Context = tally.ToHex(tally.Context(e))
	r.Fingerprint = tally.Fingerprint(e)
	r.State = stateOpen
	out, err := l.saveElection(r)
	if err != nil {
		return nil, err
	}
	return out, l.event("ElectionOpened", openedEvent{r.ID, r.Fingerprint})
}

// GetElection(electionId): the election record.
func getElection(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	b, err := ledger{stub}.get(keyElection, args[0])
	if err != nil {
		return nil, err
	}
	if b == nil {
		return nil, errNoElection(args[0])
	}
	return b, nil
}

type ceremonyTrustee struct {
	ID             string          `json:"id"`
	Msp            string          `json:"msp"`
	Round1         json.RawMessage `json:"round1"`
	Round2         json.RawMessage `json:"round2"`
	Confirmation   json.RawMessage `json:"confirmation"`
	CloseRequested bool            `json:"closeRequested"`
}

type ceremonyView struct {
	ElectionID string            `json:"electionId"`
	Trustees   []ceremonyTrustee `json:"trustees"`
}

func rawOrNull(b []byte) json.RawMessage {
	if b == nil {
		return json.RawMessage("null")
	}
	return json.RawMessage(b)
}

// GetCeremony(electionId): every trustee's posts, in trustee order, with
// null for a round it hasn't posted, and whether it has asked to close.
func getCeremony(stub shim.ChaincodeStubInterface, args []string) ([]byte, error) {
	l := ledger{stub}
	r, err := l.election(args[0])
	if err != nil {
		return nil, err
	}
	v := ceremonyView{ElectionID: r.ID, Trustees: []ceremonyTrustee{}}
	for _, t := range r.Trustees {
		var posts [3][]byte
		for i, k := range roundKeys {
			if posts[i], err = l.get(k, r.ID, t.Msp); err != nil {
				return nil, err
			}
		}
		closed, err := l.get(keyClose, r.ID, t.Msp)
		if err != nil {
			return nil, err
		}
		v.Trustees = append(v.Trustees, ceremonyTrustee{
			ID: t.ID, Msp: t.Msp,
			Round1: rawOrNull(posts[0]), Round2: rawOrNull(posts[1]), Confirmation: rawOrNull(posts[2]),
			CloseRequested: closed != nil,
		})
	}
	return marshal(v)
}
