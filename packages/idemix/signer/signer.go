// Package signer is Weft's idemix signer: what a Fabric wallet needs to
// hold a voter credential and sign with it, on IBM's idemix library, the
// one Fabric's idemix MSP uses (docs/adr/0008).
//
// It uses IBM idemix's dlog scheme through its bridge package, which is the
// code Fabric's MSP runs underneath its BCCSP, and not the BCCSP itself,
// which also links the BBS+ scheme Fabric doesn't use. Each step does what
// Fabric's idemix MSP and Fabric CA's client do, with one difference: every
// identity gets a new pseudonym (Nym) and a new proof, so two transactions
// from one credential can't be linked through their creators. Fabric's MSP
// makes one Nym per process.
//
// Nothing here draws randomness except through the curve's Rand, which is
// crypto/rand, and nothing here keeps a secret beyond Identity.Dispose.
package signer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"

	"github.com/IBM/idemix/bccsp/schemes/dlog/bridge"
	idemix "github.com/IBM/idemix/bccsp/schemes/dlog/crypto"
	"github.com/IBM/idemix/bccsp/schemes/dlog/crypto/translator/amcl"
	"github.com/IBM/idemix/bccsp/types"
	math "github.com/IBM/mathlib"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"google.golang.org/protobuf/proto"

	"github.com/weftwallet/weft/contracts/private-ballot/pseudonym"
)

// Curve is the one curve Weft supports, Fabric CA's default.
const Curve = "FP256BN_AMCL"

// The attribute names and positions of every Fabric CA credential, which
// Fabric's idemix MSP requires of the issuer key.
var AttributeNames = []string{"OU", "Role", "EnrollmentID", "RevocationHandle"}

const (
	eidIndex = 2
	rhIndex  = 3
)

// Role values in a credential's Role attribute, as Fabric CA writes them and
// Fabric's MSP reads them: a bit mask, MEMBER 1 and ADMIN 2.
const (
	RoleMember = 1
	RoleAdmin  = 2
)

// IssuerKey is an issuer public key, loaded and checked.
type IssuerKey struct {
	curve *math.Curve
	tr    *amcl.Fp256bn
	pk    *bridge.IssuerPublicKey
	raw   []byte
	// scope is what the per-election pseudonym's proof needs of the key.
	scope *pseudonym.Key
}

func scheme() (*math.Curve, *amcl.Fp256bn, *idemix.Idemix) {
	c := math.Curves[math.FP256BN_AMCL]
	tr := &amcl.Fp256bn{C: c}
	return c, tr, &idemix.Idemix{Curve: c, Translator: tr}
}

// LoadIssuerKey decodes an IssuerPublicKey as Fabric CA writes it and
// serves it from /cainfo, and checks it as Fabric's idemix MSP does: its
// points, its proof of knowledge and its four attribute names.
func LoadIssuerKey(raw []byte) (*IssuerKey, error) {
	c, tr, ix := scheme()
	issuer := &bridge.Issuer{Translator: tr, Idemix: ix}
	pk, err := issuer.NewPublicKeyFromBytes(raw, AttributeNames)
	if err != nil {
		return nil, fmt.Errorf("the issuer key isn't an idemix issuer public key for %s: %w", Curve, err)
	}
	ipk, ok := pk.(*bridge.IssuerPublicKey)
	if !ok {
		return nil, errors.New("the issuer key has an unexpected type")
	}
	hsk, err := tr.G1FromProto(ipk.PK.GetHSk())
	if err != nil {
		return nil, fmt.Errorf("the issuer key's HSk: %w", err)
	}
	hrand, err := tr.G1FromProto(ipk.PK.GetHRand())
	if err != nil {
		return nil, fmt.Errorf("the issuer key's HRand: %w", err)
	}
	if hsk.IsInfinity() || hrand.IsInfinity() {
		return nil, errors.New("the issuer key's HSk or HRand is the identity")
	}
	scope := &pseudonym.Key{HSk: hsk, HRand: hrand, Hash: sha256.Sum256(raw), PK: ipk.PK}
	return &IssuerKey{curve: c, tr: tr, pk: ipk, raw: bytes.Clone(raw), scope: scope}, nil
}

// Hash is issuerKeyHash: SHA-256 of the key's bytes as Fabric CA serves
// them, in lowercase hex. It isn't the key's own Hash field.
func (k *IssuerKey) Hash() string {
	sum := sha256.Sum256(k.raw)
	return hex.EncodeToString(sum[:])
}

func (k *IssuerKey) idemix() *idemix.Idemix {
	return &idemix.Idemix{Curve: k.curve, Translator: k.tr}
}

// CredentialRequest draws a new secret key and builds the credential request
// for Fabric CA's /api/v1/idemix/credential, bound to the CA's nonce. It
// returns the secret key's 32 bytes and the request as the CredRequest
// message, which the caller sends as JSON, as fabric-ca-client does.
func (k *IssuerKey) CredentialRequest(nonce []byte) (sk []byte, request *idemix.CredRequest, err error) {
	defer recovered(&err)
	if len(nonce) != k.curve.ScalarByteSize {
		return nil, nil, fmt.Errorf("the CA's nonce is %d bytes, not %d", len(nonce), k.curve.ScalarByteSize)
	}
	key := k.curve.NewRandomZr(mustRand(k.curve))
	request, err = k.idemix().NewCredRequest(key, nonce, k.pk.PK, mustRand(k.curve), k.tr)
	if err != nil {
		return nil, nil, err
	}
	sk = key.Bytes()
	wipeZr(key)
	return sk, request, nil
}

// Credential is a voter credential's secret part and the attributes Fabric
// CA issued it with, as fabric-ca-client keeps them in SignerConfig.
type Credential struct {
	SecretKey        []byte // 32 bytes
	Credential       []byte // the Credential message
	CRI              []byte // the CredentialRevocationInformation message
	OU               string
	Role             int
	EnrollmentID     string
	RevocationHandle string
}

// Wipe zeroes the credential's byte slices.
func (c *Credential) Wipe() {
	for _, b := range [][]byte{c.SecretKey, c.Credential, c.CRI} {
		clear(b)
	}
}

func (k *IssuerKey) secretKey(c *Credential) (*math.Zr, error) {
	if len(c.SecretKey) != k.curve.ScalarByteSize {
		return nil, fmt.Errorf("the secret key is %d bytes, not %d", len(c.SecretKey), k.curve.ScalarByteSize)
	}
	sk := k.curve.NewZrFromBytes(c.SecretKey)
	if sk.IsZero() || sk.BigInt().Cmp(k.curve.GroupOrder.BigInt()) >= 0 {
		wipeZr(sk)
		return nil, errors.New("the secret key isn't a scalar from 1 to below the group order")
	}
	return sk, nil
}

func roleAttribute(role int) int {
	if role&RoleAdmin != 0 {
		return RoleAdmin
	}
	return RoleMember
}

// CheckCredential checks the credential against the issuer key and the
// attributes it names, as Fabric's idemix MSP does at setup: the OU, the
// role and the enrolment ID, with the revocation handle hidden.
func (k *IssuerKey) CheckCredential(c *Credential) (err error) {
	defer recovered(&err)
	sk, err := k.secretKey(c)
	if err != nil {
		return err
	}
	defer wipeZr(sk)
	return k.checkCredential(sk, c)
}

func (k *IssuerKey) checkCredential(sk *math.Zr, c *Credential) error {
	cred := &bridge.Credential{Translator: k.tr, Idemix: k.idemix()}
	err := cred.Verify(sk, k.pk, c.Credential, []types.IdemixAttribute{
		{Type: types.IdemixBytesAttribute, Value: []byte(c.OU)},
		{Type: types.IdemixIntAttribute, Value: roleAttribute(c.Role)},
		{Type: types.IdemixBytesAttribute, Value: []byte(c.EnrollmentID)},
		{Type: types.IdemixHiddenAttribute},
	})
	if err != nil {
		return fmt.Errorf("the credential doesn't check out against the issuer key: %w", err)
	}
	return nil
}

// Identity is a one-off idemix identity: a new Nym and a proof that it
// belongs to a credential from the issuer key. Use one per transaction and
// dispose of it after the commit status.
type Identity struct {
	key  *IssuerKey
	sk   *math.Zr
	nym  *math.G1
	rNym *math.Zr
	// MspID and IDBytes are the creator Fabric reads: IDBytes is the
	// SerializedIdemixIdentity, what fabric-gateway calls credentials.
	MspID   string
	IDBytes []byte
	// Nym is the identity's pseudonym as its 32-byte X then 32-byte Y, the
	// nym_x and nym_y of IDBytes.
	Nym []byte
}

// NewIdentity checks the credential, makes a new Nym and proves that it
// belongs to the credential, disclosing the OU and role, as Fabric's MSP
// does for its one identity.
func (k *IssuerKey) NewIdentity(c *Credential, mspID string) (id *Identity, err error) {
	defer recovered(&err)
	sk, err := k.secretKey(c)
	if err != nil {
		return nil, err
	}
	keep := false
	defer func() {
		if !keep {
			wipeZr(sk)
		}
	}()
	if err := k.checkCredential(sk, c); err != nil {
		return nil, err
	}
	nym, rNym, err := k.idemix().MakeNym(sk, k.pk.PK, mustRand(k.curve), k.tr)
	if err != nil {
		return nil, fmt.Errorf("making a pseudonym: %w", err)
	}
	signer := &bridge.SignatureScheme{Translator: k.tr, Idemix: k.idemix()}
	proof, _, err := signer.Sign(c.Credential, sk, nym, rNym, k.pk, []types.IdemixAttribute{
		{Type: types.IdemixBytesAttribute},
		{Type: types.IdemixIntAttribute},
		{Type: types.IdemixHiddenAttribute},
		{Type: types.IdemixHiddenAttribute},
	}, nil, rhIndex, eidIndex, c.CRI, types.Standard, nil)
	if err != nil {
		wipeZr(rNym)
		return nil, fmt.Errorf("proving the pseudonym: %w", err)
	}
	role := &msp.MSPRole{MspIdentifier: mspID, Role: msp.MSPRole_MEMBER}
	if roleAttribute(c.Role) == RoleAdmin {
		role.Role = msp.MSPRole_ADMIN
	}
	ou := &msp.OrganizationUnit{MspIdentifier: mspID, OrganizationalUnitIdentifier: c.OU, CertifiersIdentifier: k.pk.PK.Hash}
	ouBytes, err := proto.Marshal(ou)
	if err != nil {
		return nil, err
	}
	roleBytes, err := proto.Marshal(role)
	if err != nil {
		return nil, err
	}
	point := k.tr.G1ToProto(nym)
	idBytes, err := proto.Marshal(&msp.SerializedIdemixIdentity{NymX: point.X, NymY: point.Y, Ou: ouBytes, Role: roleBytes, Proof: proof})
	if err != nil {
		return nil, err
	}
	keep = true
	return &Identity{
		key: k, sk: sk, nym: nym, rNym: rNym, MspID: mspID, IDBytes: idBytes,
		Nym: append(bytes.Clone(point.X), point.Y...),
	}, nil
}

// Creator is the transaction creator: a SerializedIdentity with the MSP ID
// and IDBytes.
func (id *Identity) Creator() ([]byte, error) {
	return proto.Marshal(&msp.SerializedIdentity{Mspid: id.MspID, IdBytes: id.IDBytes})
}

// Sign makes the Nym signature Fabric's idemix MSP verifies over message:
// the bytes Weft already signs with ECDSA for an X.509 identity (the
// proposal, the transaction, the commit status request), never
// fabric-gateway's wrapper bytes.
func (id *Identity) Sign(message []byte) (sig []byte, err error) {
	defer recovered(&err)
	if id.sk == nil {
		return nil, errors.New("the identity has been disposed of")
	}
	ns := &bridge.NymSignatureScheme{Translator: id.key.tr, Idemix: id.key.idemix()}
	return ns.Sign(id.sk, id.nym, id.rNym, id.key.pk, message)
}

// Pseudonym returns the credential's per-election pseudonym P = sk·B for
// the election's B, as its 64 bytes (private-tally-spec.md, The
// per-election pseudonym). It is the same for every identity of the
// credential. Weft makes the voter tag from it before it makes the ballot.
func (id *Identity) Pseudonym(channel, electionID string) (p []byte, err error) {
	defer recovered(&err)
	if id.sk == nil {
		return nil, errors.New("the identity has been disposed of")
	}
	return pseudonym.EncodePoint(pseudonym.Pseudonym(id.sk, channel, electionID)), nil
}

// PseudonymProof makes the proof that the election's pseudonym and this
// identity's Nym hold the same sk, bound to the issuer key's hash, the
// channel, the election and the ballot's 32-byte tracking code. It returns
// pseudonymJson's fields.
func (id *Identity) PseudonymProof(channel, electionID string, tracking []byte) (out pseudonym.JSON, err error) {
	defer recovered(&err)
	if id.sk == nil {
		return pseudonym.JSON{}, errors.New("the identity has been disposed of")
	}
	if len(tracking) != 32 {
		return pseudonym.JSON{}, fmt.Errorf("the tracking code is %d bytes, not 32", len(tracking))
	}
	st := &pseudonym.Statement{Key: id.key.scope, Channel: channel, ElectionID: electionID, Tracking: tracking, Nym: id.nym}
	proof, err := pseudonym.Prove(st, id.sk, id.rNym, mustRand(id.key.curve))
	if err != nil {
		return pseudonym.JSON{}, err
	}
	return proof.JSON(), nil
}

// Dispose zeroes the identity's copies of the secret key and the Nym's
// randomness, and drops them. Go may have copied them elsewhere while
// computing; only ending the process frees every copy, which is why Weft
// runs this module in a worker it terminates (docs/adr/0008).
func (id *Identity) Dispose() {
	wipeZr(id.sk)
	wipeZr(id.rNym)
	id.sk, id.rNym, id.nym = nil, nil, nil
}

func mustRand(c *math.Curve) io.Reader {
	rng, err := c.Rand()
	if err != nil {
		panic(err)
	}
	return rng
}

// recovered turns a panic in the library into an error, as IBM idemix's
// own bridge does.
func recovered(err *error) {
	if r := recover(); r != nil {
		*err = fmt.Errorf("idemix: %v", r)
	}
}
