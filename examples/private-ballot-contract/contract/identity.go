package contract

import (
	"encoding/pem"
	"fmt"

	"github.com/hyperledger/fabric-chaincode-go/v2/pkg/cid"
	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-protos-go-apiv2/common"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"github.com/hyperledger/fabric-protos-go-apiv2/peer"
	"google.golang.org/protobuf/proto"
)

// TrusteeAttribute is the Fabric CA attribute a trustee identity's
// certificate carries, with the value "true".
const TrusteeAttribute = "weft.trustee"

// caller is the transaction's creator, from SignatureHeader.creator.
type caller struct {
	stub    shim.ChaincodeStubInterface
	msp     string
	idBytes []byte
}

func creator(stub shim.ChaincodeStubInterface) (*caller, error) {
	b, err := stub.GetCreator()
	if err != nil {
		return nil, fmt.Errorf("contract: no creator: %w", err)
	}
	sid := &msp.SerializedIdentity{}
	if err := proto.Unmarshal(b, sid); err != nil {
		return nil, fmt.Errorf("contract: the creator isn't a SerializedIdentity: %w", err)
	}
	return &caller{stub: stub, msp: sid.GetMspid(), idBytes: sid.GetIdBytes()}, nil
}

// x509 reports whether the creator is an X.509 identity: its id_bytes are a
// PEM certificate, as Fabric carries them. An idemix creator's id_bytes are a
// SerializedIdemixIdentity. The peer has already checked the certificate.
func (c *caller) x509() bool {
	block, _ := pem.Decode(c.idBytes)
	return block != nil && block.Type == "CERTIFICATE"
}

// trusteeIdentity reports whether the creator carries weft.trustee=true.
// It uses cid, which reads Fabric CA attributes from an X.509 certificate
// and the OU and role from an idemix identity, so an idemix creator gets an
// answer (no) instead of an error.
func (c *caller) trusteeIdentity() bool {
	if !c.x509() {
		return false
	}
	id, err := cid.New(c.stub)
	if err != nil {
		return false
	}
	v, found, err := id.GetAttributeValue(TrusteeAttribute)
	return err == nil && found && v == "true"
}

// asTrustee checks that the creator is a trustee of the election, an
// organisation in its trustee list, and a trustee identity, and returns its
// index in the list.
func (c *caller) asTrustee(r *Record) (int, error) {
	i := r.trusteeIndex(c.msp)
	if i < 0 {
		return -1, errNotTrustee(c.msp)
	}
	if !c.trusteeIdentity() {
		return -1, errNoTrusteeAttribute()
	}
	return i, nil
}

// chaincodeName returns the contract's own name, which the election context
// binds. The shim doesn't give it directly, so it comes from the signed
// proposal: Proposal.header, ChannelHeader.extension, a
// ChaincodeHeaderExtension with the chaincode ID the client invoked and the
// peer routed by.
func chaincodeName(stub shim.ChaincodeStubInterface) (string, error) {
	sp, err := stub.GetSignedProposal()
	if err != nil || sp == nil {
		return "", fmt.Errorf("contract: no signed proposal: %v", err)
	}
	prop := &peer.Proposal{}
	if err := proto.Unmarshal(sp.GetProposalBytes(), prop); err != nil {
		return "", fmt.Errorf("contract: the proposal doesn't decode: %w", err)
	}
	hdr := &common.Header{}
	if err := proto.Unmarshal(prop.GetHeader(), hdr); err != nil {
		return "", fmt.Errorf("contract: the proposal header doesn't decode: %w", err)
	}
	ch := &common.ChannelHeader{}
	if err := proto.Unmarshal(hdr.GetChannelHeader(), ch); err != nil {
		return "", fmt.Errorf("contract: the channel header doesn't decode: %w", err)
	}
	ext := &peer.ChaincodeHeaderExtension{}
	if err := proto.Unmarshal(ch.GetExtension(), ext); err != nil {
		return "", fmt.Errorf("contract: the chaincode header extension doesn't decode: %w", err)
	}
	name := ext.GetChaincodeId().GetName()
	if name == "" {
		return "", fmt.Errorf("contract: the proposal names no chaincode")
	}
	return name, nil
}
