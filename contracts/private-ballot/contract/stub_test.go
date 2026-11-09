package contract

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	"github.com/hyperledger/fabric-protos-go-apiv2/ledger/queryresult"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// A small in-memory peer for the contract's tests. Each call is endorsed
// against the committed state, as a Fabric endorser simulates it: reads see
// no writes of their own transaction, and the read set (key versions and
// range results) is kept so that committing checks it as the validator does,
// with MVCC_READ_CONFLICT and PHANTOM_READ_CONFLICT.

type version struct{ block, tx int }

type entry struct {
	value []byte
	ver   version
}

// network is one channel's committed state, and now is the timestamp the
// client writes in each transaction it endorses.
type network struct {
	t         *testing.T
	channel   string
	chaincode string
	state     map[string]entry
	block     int
	txs       int
	now       time.Time
}

// testNow is the clients' time in the tests, before every closesAt they use.
var testNow = time.Date(2026, 11, 7, 12, 0, 0, 123456789, time.UTC)

func newNetwork(t *testing.T, channel string) *network {
	return &network{t: t, channel: channel, chaincode: "private-ballot", state: map[string]entry{}, block: 1, now: testNow}
}

// write is one key in a write set, in the order the contract wrote it.
type write struct {
	key   string
	value []byte
}

type rangeRead struct {
	start, end string
	keys       []string
	versions   []version
}

// endorsement is a simulated transaction: its result and its read-write set.
type endorsement struct {
	txID      string
	function  string
	payload   []byte
	err       string
	reads     map[string]version
	readOrder []string
	ranges    []rangeRead
	writes    []write
	event     *peer.ChaincodeEvent
}

// identity is a creator: an MSP ID and the bytes of its SerializedIdentity.
type identity struct {
	msp     string
	idBytes []byte
}

func (id identity) serialized() []byte {
	b, err := proto.Marshal(&msp.SerializedIdentity{Mspid: id.msp, IdBytes: id.idBytes})
	if err != nil {
		panic(err)
	}
	return b
}

// endorse runs the function as an endorser would, without committing.
func (n *network) endorse(who identity, function string, args ...string) *endorsement {
	n.txs++
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s tx %d", n.channel, n.txs)))
	s := &fakeStub{
		net:  n,
		who:  who,
		args: append([]string{function}, args...),
		e:    &endorsement{txID: fmt.Sprintf("%x", sum), function: function, reads: map[string]version{}},
	}
	resp := New().Invoke(s)
	if resp.Status >= shim.ERRORTHRESHOLD {
		s.e.err = resp.Message
		saw(resp.Message)
		// A failed endorsement has no transaction to commit.
		s.e.writes, s.e.event = nil, nil
	} else {
		s.e.payload = resp.Payload
	}
	return s.e
}

// commit validates the endorsement against the state now, as the
// validator does, and applies its writes if it is valid.
func (n *network) commit(e *endorsement) string {
	if e.err != "" {
		n.t.Fatalf("commit of a refused %s: %s", e.function, e.err)
	}
	for _, k := range e.readOrder {
		if n.state[k].ver != e.reads[k] {
			return "MVCC_READ_CONFLICT"
		}
	}
	for _, r := range e.ranges {
		keys, versions := n.scan(r.start, r.end)
		if fmt.Sprint(keys, versions) != fmt.Sprint(r.keys, r.versions) {
			return "PHANTOM_READ_CONFLICT"
		}
	}
	n.block++
	for _, w := range e.writes {
		if len(w.value) == 0 {
			delete(n.state, w.key)
		} else {
			n.state[w.key] = entry{w.value, version{n.block, 0}}
		}
	}
	return "VALID"
}

// submit endorses and commits, and returns the result or the refusal.
func (n *network) submit(who identity, function string, args ...string) *endorsement {
	e := n.endorse(who, function, args...)
	if e.err == "" {
		if code := n.commit(e); code != "VALID" {
			n.t.Fatalf("%s: %s", function, code)
		}
	}
	return e
}

func (n *network) scan(start, end string) ([]string, []version) {
	var keys []string
	for k := range n.state {
		if k >= start && k < end {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	versions := make([]version, len(keys))
	for i, k := range keys {
		versions[i] = n.state[k].ver
	}
	return keys, versions
}

// clone copies the committed state, for running one election several ways.
func (n *network) clone() *network {
	c := *n
	c.state = map[string]entry{}
	for k, v := range n.state {
		c.state[k] = v
	}
	return &c
}

// put writes a key straight into the committed state.
func (n *network) put(t *testing.T, value []byte, objectType string, attributes ...string) {
	k, err := shim.CreateCompositeKey(objectType, attributes)
	if err != nil {
		t.Fatal(err)
	}
	n.block++
	n.state[k] = entry{value, version{n.block, 0}}
}

func (n *network) get(t *testing.T, objectType string, attributes ...string) []byte {
	k, err := shim.CreateCompositeKey(objectType, attributes)
	if err != nil {
		t.Fatal(err)
	}
	return n.state[k].value
}

// fakeStub implements the part of shim.ChaincodeStubInterface the contract
// uses. Any other method panics through the nil embedded interface, which
// keeps the contract honest about what it calls.
type fakeStub struct {
	shim.ChaincodeStubInterface
	net  *network
	who  identity
	args []string
	e    *endorsement
}

func (s *fakeStub) GetArgs() [][]byte {
	out := make([][]byte, len(s.args))
	for i, a := range s.args {
		out[i] = []byte(a)
	}
	return out
}

func (s *fakeStub) GetStringArgs() []string { return s.args }

func (s *fakeStub) GetFunctionAndParameters() (string, []string) {
	return s.args[0], s.args[1:]
}

func (s *fakeStub) GetTxID() string      { return s.e.txID }
func (s *fakeStub) GetChannelID() string { return s.net.channel }

func (s *fakeStub) GetCreator() ([]byte, error) { return s.who.serialized(), nil }

// GetTxTimestamp is the client's clock, which only CreateElection may read.
func (s *fakeStub) GetTxTimestamp() (*timestamppb.Timestamp, error) {
	if s.e.function != "CreateElection" {
		s.net.t.Errorf("%s read the transaction's timestamp", s.e.function)
		return nil, fmt.Errorf("no clock for %s in this test", s.e.function)
	}
	return timestamppb.New(s.net.now), nil
}

func (s *fakeStub) GetSignedProposal() (*peer.SignedProposal, error) {
	ext, _ := proto.Marshal(&peer.ChaincodeHeaderExtension{ChaincodeId: &peer.ChaincodeID{Name: s.net.chaincode}})
	ch, _ := proto.Marshal(&common.ChannelHeader{Type: int32(common.HeaderType_ENDORSER_TRANSACTION), ChannelId: s.net.channel, TxId: s.e.txID, Extension: ext})
	sh, _ := proto.Marshal(&common.SignatureHeader{Creator: s.who.serialized(), Nonce: []byte("nonce")})
	hdr, _ := proto.Marshal(&common.Header{ChannelHeader: ch, SignatureHeader: sh})
	prop, _ := proto.Marshal(&peer.Proposal{Header: hdr})
	return &peer.SignedProposal{ProposalBytes: prop, Signature: []byte("signature")}, nil
}

func (s *fakeStub) CreateCompositeKey(objectType string, attributes []string) (string, error) {
	return shim.CreateCompositeKey(objectType, attributes)
}

func (s *fakeStub) GetState(key string) ([]byte, error) {
	cur, ok := s.net.state[key]
	if _, seen := s.e.reads[key]; !seen {
		s.e.readOrder = append(s.e.readOrder, key)
	}
	s.e.reads[key] = cur.ver
	if !ok {
		return nil, nil
	}
	return append([]byte{}, cur.value...), nil
}

func (s *fakeStub) PutState(key string, value []byte) error {
	if key == "" {
		return fmt.Errorf("key must not be an empty string")
	}
	for i, w := range s.e.writes {
		if w.key == key {
			s.e.writes[i].value = append([]byte{}, value...)
			return nil
		}
	}
	s.e.writes = append(s.e.writes, write{key, append([]byte{}, value...)})
	return nil
}

func (s *fakeStub) SetEvent(name string, payload []byte) error {
	if name == "" {
		return fmt.Errorf("event name can not be empty string")
	}
	// Fabric keeps one event per transaction: the last one set.
	s.e.event = &peer.ChaincodeEvent{EventName: name, Payload: append([]byte{}, payload...)}
	return nil
}

func (s *fakeStub) GetStateByPartialCompositeKey(objectType string, attributes []string) (shim.StateQueryIteratorInterface, error) {
	start, err := shim.CreateCompositeKey(objectType, attributes)
	if err != nil {
		return nil, err
	}
	end := start + string(rune(0x10FFFF))
	keys, versions := s.net.scan(start, end)
	s.e.ranges = append(s.e.ranges, rangeRead{start, end, keys, versions})
	it := &iterator{}
	for _, k := range keys {
		it.kvs = append(it.kvs, &queryresult.KV{Namespace: s.net.chaincode, Key: k, Value: append([]byte{}, s.net.state[k].value...)})
	}
	return it, nil
}

type iterator struct {
	kvs    []*queryresult.KV
	closed bool
}

func (it *iterator) HasNext() bool { return !it.closed && len(it.kvs) > 0 }
func (it *iterator) Next() (*queryresult.KV, error) {
	if !it.HasNext() {
		return nil, fmt.Errorf("no more results")
	}
	kv := it.kvs[0]
	it.kvs = it.kvs[1:]
	return kv, nil
}
func (it *iterator) Close() error { it.closed = true; return nil }

// sameWrites reports whether two endorsements wrote the same keys, values
// and event, byte for byte, in the same order.
func sameWrites(a, b *endorsement) bool {
	if a.err != b.err || !bytes.Equal(a.payload, b.payload) || len(a.writes) != len(b.writes) {
		return false
	}
	for i := range a.writes {
		if a.writes[i].key != b.writes[i].key || !bytes.Equal(a.writes[i].value, b.writes[i].value) {
			return false
		}
	}
	if (a.event == nil) != (b.event == nil) {
		return false
	}
	return a.event == nil || (a.event.EventName == b.event.EventName && bytes.Equal(a.event.Payload, b.event.Payload))
}
