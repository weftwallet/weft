package pseudonym

import (
	"errors"
	"fmt"

	idemix "github.com/IBM/idemix/bccsp/schemes/dlog/crypto"
	"github.com/IBM/idemix/bccsp/schemes/dlog/crypto/translator/amcl"
	"github.com/IBM/idemix/bccsp/types"
	math "github.com/IBM/mathlib"
	"google.golang.org/protobuf/proto"
)

// The positions of the enrolment ID and the revocation handle among
// Fabric's four attributes (AttributeNames), and the role values of a
// credential's Role attribute, a bit mask as Fabric CA writes it.
const (
	eidIndex   = 2
	rhIndex    = 3
	RoleMember = 1
	RoleAdmin  = 2
)

// ErrIdentityNotValid is every failure of an idemix creator's proof.
var ErrIdentityNotValid = errors.New("the one-off identity's proof isn't valid for the issuer key")

// VerifyIdentity checks the proof field of an idemix creator's
// SerializedIdemixIdentity against the key, as Fabric's idemix MSP checks
// a creator against its issuer key when a peer validates a transaction:
// the proof is an IBM idemix signature, with no message, that the Nym
// belongs to a credential from this key whose OU and role are the ones
// given, with the enrolment ID and the revocation handle hidden, at epoch
// 0, without a revocation key and with the basic verification type. The
// credential's signature is under the key's W, HAttrs, HSk, HRand and
// BarG1 and its hash, so a key that copies only HSk and HRand doesn't make
// it verify. It doesn't check the creator's signature over a transaction,
// which the peer does.
//
// The contract runs it on every anonymous ballot with the election's
// pinned key, and Weft's idemix module runs it for explorers.
func (k *Key) VerifyIdentity(proof []byte, nym *math.G1, ou string, role int) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%w: %v", ErrIdentityNotValid, r)
		}
	}()
	if k.PK == nil || nym == nil || len(proof) == 0 {
		return ErrIdentityNotValid
	}
	if role != RoleMember && role != RoleAdmin {
		return ErrIdentityNotValid
	}
	sig := &idemix.Signature{}
	if err := proto.Unmarshal(proof, sig); err != nil {
		return ErrIdentityNotValid
	}
	tr := &amcl.Fp256bn{C: curve}
	attributes := []*math.Zr{curve.HashToZr([]byte(ou)), curve.NewZrFromInt(int64(role)), nil, nil}
	if err := sig.Ver([]byte{1, 1, 0, 0}, k.PK, nil, nym, attributes, rhIndex, eidIndex, nil, 0, curve, tr, types.Basic, nil); err != nil {
		return fmt.Errorf("%w: %v", ErrIdentityNotValid, err)
	}
	return nil
}
