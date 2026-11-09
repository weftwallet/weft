package signer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/IBM/idemix/bccsp/schemes/dlog/crypto/translator/amcl"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"google.golang.org/protobuf/proto"

	"github.com/weftwallet/weft/contracts/private-ballot/pseudonym"
)

// What an explorer needs to check an anonymous ballot from what is on the
// ledger alone: the creator's one-off identity against the election's
// issuer key, as a peer's idemix MSP validates it, and the pseudonym proof
// against that identity's Nym, as the contract verifies it. Neither needs a
// secret, and neither keeps anything.

// VerifiedIdentity is what an idemix creator discloses once its proof
// checks out: its Nym as 32-byte X then Y, its organisational unit and its
// role as Fabric's MSPRole names it ("member" or "admin").
type VerifiedIdentity struct {
	Nym  []byte
	OU   string
	Role string
}

// ErrIdentityNotValid is every failure of an idemix creator's proof.
var ErrIdentityNotValid = errors.New("The one-off identity's proof isn't valid for the election's issuer key.")

// VerifyIdentity checks an idemix creator, the SerializedIdemixIdentity a
// transaction carries as id_bytes, as Fabric's idemix MSP does when a peer
// validates it: it decodes the Nym, the OU and the role, and verifies the
// proof that the Nym belongs to a credential from this issuer key with
// that OU and role, with the enrolment ID and the revocation handle hidden.
// The proof is checked by the contract's own pseudonym.Key.VerifyIdentity,
// which CastAnonymousBallot runs against the pinned key, so an explorer
// and the contract check each creator with the same code. It doesn't check
// the creator's signature over a transaction.
func (k *IssuerKey) VerifyIdentity(idBytes []byte) (out *VerifiedIdentity, err error) {
	defer func() {
		if r := recover(); r != nil {
			out, err = nil, ErrIdentityNotValid
		}
	}()
	sid := &msp.SerializedIdemixIdentity{}
	if err := proto.Unmarshal(idBytes, sid); err != nil {
		return nil, errors.New("The creator isn't an idemix identity.")
	}
	if len(sid.NymX) != 32 || len(sid.NymY) != 32 || len(sid.Proof) == 0 {
		return nil, errors.New("The creator isn't an idemix identity.")
	}
	ou := &msp.OrganizationUnit{}
	if err := proto.Unmarshal(sid.Ou, ou); err != nil {
		return nil, errors.New("The creator's organisational unit doesn't decode.")
	}
	role := &msp.MSPRole{}
	if err := proto.Unmarshal(sid.Role, role); err != nil {
		return nil, errors.New("The creator's role doesn't decode.")
	}
	nym, err := k.tr.G1FromProto(&amcl.ECP{X: sid.NymX, Y: sid.NymY})
	if err != nil || nym.IsInfinity() {
		return nil, errors.New("The creator's Nym isn't a point of G1.")
	}
	roleValue := RoleMember
	switch role.Role {
	case msp.MSPRole_MEMBER:
	case msp.MSPRole_ADMIN:
		roleValue = RoleAdmin
	default:
		return nil, fmt.Errorf("The creator's role, %s, isn't one a credential can have.", role.Role)
	}
	if err := k.scope.VerifyIdentity(sid.Proof, nym, ou.OrganizationalUnitIdentifier, roleValue); err != nil {
		return nil, ErrIdentityNotValid
	}
	names := map[msp.MSPRole_MSPRoleType]string{msp.MSPRole_MEMBER: "member", msp.MSPRole_ADMIN: "admin"}
	return &VerifiedIdentity{
		Nym:  append(bytes.Clone(sid.NymX), sid.NymY...),
		OU:   ou.OrganizationalUnitIdentifier,
		Role: names[role.Role],
	}, nil
}

// VerifyPseudonym checks a ballot's pseudonym proof, CastAnonymousBallot's
// pseudonymJson, against the creator's Nym (64 bytes), the issuer key, the
// channel, the election and the ballot's 32-byte tracking code, with the
// contract's own pseudonym package. Its errors are the contract's
// messages.
func (k *IssuerKey) VerifyPseudonym(nym []byte, channel, electionID string, tracking []byte, pseudonymJSON string) (err error) {
	defer recovered(&err)
	if len(tracking) != 32 {
		return fmt.Errorf("the tracking code is %d bytes, not 32", len(tracking))
	}
	point, ok := pseudonym.DecodePoint(nym)
	if !ok {
		return errors.New("The creator's Nym isn't a point of G1.")
	}
	var fields pseudonym.JSON
	if err := json.Unmarshal([]byte(pseudonymJSON), &fields); err != nil {
		return errors.New("The pseudonym proof isn't a JSON object with pseudonym, c, ssk and sr.")
	}
	proof, err := pseudonym.Decode(fields)
	if err != nil {
		return err
	}
	return pseudonym.Verify(&pseudonym.Statement{Key: k.scope, Channel: channel, ElectionID: electionID, Tracking: tracking, Nym: point}, proof)
}
