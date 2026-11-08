// Package testtool is a scratch idemix issuer, as Fabric CA issues
// credentials, and a verifier that is IBM idemix's own MSP, set up as a
// Fabric peer sets up a channel's idemix organisation. The Go tests and
// the Node tests (through cmd/testtool) use it. Nothing in the module
// imports it.
package testtool

import (
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/IBM/idemix/bccsp/schemes/dlog/bridge"
	idemix "github.com/IBM/idemix/bccsp/schemes/dlog/crypto"
	"github.com/IBM/idemix/bccsp/schemes/dlog/crypto/translator/amcl"
	"github.com/IBM/idemix/bccsp/types"
	imsp "github.com/IBM/idemix/msp"
	im "github.com/IBM/idemix/msp/config"
	math "github.com/IBM/mathlib"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"google.golang.org/protobuf/proto"
)

var attributeNames = []string{"OU", "Role", "EnrollmentID", "RevocationHandle"}

func scheme() (*math.Curve, *amcl.Fp256bn, *idemix.Idemix) {
	c := math.Curves[math.FP256BN_AMCL]
	tr := &amcl.Fp256bn{C: c}
	return c, tr, &idemix.Idemix{Curve: c, Translator: tr}
}

// Issuer is a scratch issuer: an idemix issuer key and a long-term
// revocation key, as fabric-ca-server init writes them.
type Issuer struct {
	key        *idemix.IssuerKey
	revocation *ecdsa.PrivateKey
	// PublicKey is the IssuerPublicKey file's bytes, and RevocationPublicKey
	// the IssuerRevocationPublicKey file's, a PEM public key.
	PublicKey           []byte
	RevocationPublicKey []byte
	nextHandle          int64
}

// NewIssuer makes a new issuer, as fabric-ca-server init does.
func NewIssuer() (*Issuer, error) {
	c, tr, ix := scheme()
	key, err := ix.NewIssuerKey(attributeNames, mustRand(c), tr)
	if err != nil {
		return nil, err
	}
	ipk, err := proto.Marshal(key.Ipk)
	if err != nil {
		return nil, err
	}
	rev, err := ix.GenerateLongTermRevocationKey()
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKIXPublicKey(&rev.PublicKey)
	if err != nil {
		return nil, err
	}
	return &Issuer{
		key: key, revocation: rev, PublicKey: ipk,
		RevocationPublicKey: pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}),
		nextHandle:          1,
	}, nil
}

// Issued is what Fabric CA's second answer carries.
type Issued struct {
	Credential       []byte
	CRI              []byte
	RevocationHandle int64
}

// Issue checks a credential request against the nonce and issues a
// credential with the four attributes, as Fabric CA does: the OU and the
// enrolment ID hashed to scalars, the role as an integer, and the next
// revocation handle. The CRI says no revocation, as Fabric CA's always does.
func (is *Issuer) Issue(request []byte, nonce []byte, ou string, role int, enrollmentID string) (*Issued, error) {
	c, tr, ix := scheme()
	req := &bridge.CredRequest{Translator: tr, Idemix: ix}
	pk := &bridge.IssuerPublicKey{PK: is.key.Ipk}
	if err := req.Verify(request, pk, nonce); err != nil {
		return nil, fmt.Errorf("credential request: %w", err)
	}
	handle := is.nextHandle
	is.nextHandle++
	cr := &bridge.Credential{Translator: tr, Idemix: ix}
	cred, err := cr.Sign(&bridge.IssuerSecretKey{SK: is.key}, request, []types.IdemixAttribute{
		{Type: types.IdemixBytesAttribute, Value: []byte(ou)},
		{Type: types.IdemixIntAttribute, Value: role},
		{Type: types.IdemixBytesAttribute, Value: []byte(enrollmentID)},
		{Type: types.IdemixIntAttribute, Value: handle},
	})
	if err != nil {
		return nil, err
	}
	cri, err := ix.CreateCRI(is.revocation, nil, 0, idemix.ALG_NO_REVOCATION, mustRand(c), tr)
	if err != nil {
		return nil, err
	}
	criBytes, err := proto.Marshal(cri)
	if err != nil {
		return nil, err
	}
	return &Issued{Credential: cred, CRI: criBytes, RevocationHandle: handle}, nil
}

// Nonce draws a nonce as Fabric CA's first answer does.
func Nonce() []byte {
	c, _, _ := scheme()
	return c.NewRandomZr(mustRand(c)).Bytes()
}

// MSP is IBM idemix's MSP for a channel's idemix organisation, set up from
// the issuer and revocation public keys with no signer, as a peer sets it
// up from the channel configuration.
type MSP struct{ m imsp.MSP }

// NewMSP sets up the verifier for mspID.
func NewMSP(mspID string, issuerPublicKey, revocationPublicKey []byte) (*MSP, error) {
	conf, err := proto.Marshal(&im.IdemixMSPConfig{Name: mspID, Ipk: issuerPublicKey, RevocationPk: revocationPublicKey})
	if err != nil {
		return nil, err
	}
	m, err := imsp.NewIdemixMsp(imsp.MSPv1_4_3)
	if err != nil {
		return nil, err
	}
	if err := m.Setup(&msp.MSPConfig{Type: int32(imsp.IDEMIX), Config: conf}); err != nil {
		return nil, err
	}
	return &MSP{m}, nil
}

// Verified is what the MSP read from a creator it validated.
type Verified struct {
	MspID string
	OU    string
	Role  string
}

// Verify does what a peer does with a transaction's creator and its
// signature: deserialises the creator, validates the identity's proof
// against the issuer key, and verifies the signature over message.
func (v *MSP) Verify(creator, message, signature []byte) (*Verified, error) {
	id, err := v.m.DeserializeIdentity(creator)
	if err != nil {
		return nil, fmt.Errorf("deserialise: %w", err)
	}
	if err := id.Validate(); err != nil {
		return nil, fmt.Errorf("validate: %w", err)
	}
	if err := id.Verify(message, signature); err != nil {
		return nil, fmt.Errorf("verify: %w", err)
	}
	out := &Verified{MspID: id.GetMSPIdentifier()}
	for _, ou := range id.GetOrganizationalUnits() {
		out.OU = ou.OrganizationalUnitIdentifier
	}
	sid := &msp.SerializedIdentity{}
	if err := proto.Unmarshal(creator, sid); err == nil {
		serialized := &msp.SerializedIdemixIdentity{}
		if err := proto.Unmarshal(sid.IdBytes, serialized); err == nil {
			role := &msp.MSPRole{}
			if err := proto.Unmarshal(serialized.Role, role); err == nil {
				out.Role = role.Role.String()
			}
		}
	}
	return out, nil
}

func mustRand(c *math.Curve) interface{ Read([]byte) (int, error) } {
	rng, err := c.Rand()
	if err != nil {
		panic(err)
	}
	return rng
}

// Save writes the issuer to dir, as fabric-ca-server keeps its keys: the
// public files under their Fabric CA names and the secret ones beside them.
func (is *Issuer) Save(dir string) error {
	key, err := proto.Marshal(is.key)
	if err != nil {
		return err
	}
	rev, err := x509.MarshalECPrivateKey(is.revocation)
	if err != nil {
		return err
	}
	files := map[string][]byte{
		"IssuerPublicKey":            is.PublicKey,
		"IssuerRevocationPublicKey":  is.RevocationPublicKey,
		"IssuerSecretKey":            key,
		"IssuerRevocationPrivateKey": pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: rev}),
	}
	for name, b := range files {
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o600); err != nil {
			return err
		}
	}
	return nil
}

// LoadIssuer reads an issuer that Save wrote.
func LoadIssuer(dir string) (*Issuer, error) {
	read := func(name string) []byte {
		b, _ := os.ReadFile(filepath.Join(dir, name))
		return b
	}
	key := &idemix.IssuerKey{}
	if err := proto.Unmarshal(read("IssuerSecretKey"), key); err != nil {
		return nil, err
	}
	block, _ := pem.Decode(read("IssuerRevocationPrivateKey"))
	if block == nil {
		return nil, fmt.Errorf("no revocation key in %s", dir)
	}
	rev, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	// Revocation handles only need to differ between the credentials of one
	// test, so a loaded issuer counts on from the time.
	return &Issuer{key: key, revocation: rev, PublicKey: read("IssuerPublicKey"), RevocationPublicKey: read("IssuerRevocationPublicKey"), nextHandle: time.Now().UnixNano() % 1_000_000}, nil
}
