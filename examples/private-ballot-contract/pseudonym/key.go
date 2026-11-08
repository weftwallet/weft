package pseudonym

import (
	"crypto/sha256"
	"errors"
	"fmt"

	idemix "github.com/IBM/idemix/bccsp/schemes/dlog/crypto"
	"github.com/IBM/idemix/bccsp/schemes/dlog/crypto/translator/amcl"
	math "github.com/IBM/mathlib"
	"google.golang.org/protobuf/proto"
)

// AttributeNames are the attribute names of every Fabric CA issuer key, in
// order, which Fabric's idemix MSP requires.
var AttributeNames = []string{"OU", "Role", "EnrollmentID", "RevocationHandle"}

// Key is what the proof needs of an issuer public key: its points HSk and
// HRand, and issuerKeyHash, SHA-256 of the key's bytes as Fabric CA writes
// the IssuerPublicKey file and serves it from /cainfo.
type Key struct {
	HSk   *math.G1
	HRand *math.G1
	Hash  [32]byte
}

// LoadIssuerKey decodes an IssuerPublicKey file and checks it as IBM
// idemix's own import does for Fabric's MSP: it decodes as the
// IssuerPublicKey message, its points are on FP256BN, its proof of
// knowledge verifies, and its attribute names are Fabric's four, in order.
// It also refuses an HSk or HRand that is the identity, which IBM idemix
// never makes. It returns the key's HSk, HRand and issuerKeyHash.
func LoadIssuerKey(raw []byte) (key *Key, err error) {
	defer func() {
		if r := recover(); r != nil {
			key, err = nil, fmt.Errorf("pseudonym: the issuer key doesn't decode: %v", r)
		}
	}()
	ipk := &idemix.IssuerPublicKey{}
	if err := proto.Unmarshal(raw, ipk); err != nil {
		return nil, fmt.Errorf("pseudonym: the issuer key isn't an IssuerPublicKey message: %w", err)
	}
	tr := &amcl.Fp256bn{C: curve}
	if err := ipk.Check(curve, tr); err != nil {
		return nil, fmt.Errorf("pseudonym: the issuer key fails IBM idemix's check: %w", err)
	}
	names := ipk.GetAttributeNames()
	if len(names) != len(AttributeNames) {
		return nil, fmt.Errorf("pseudonym: the issuer key has %d attribute names, not Fabric's %d", len(names), len(AttributeNames))
	}
	for i, n := range AttributeNames {
		if names[i] != n {
			return nil, fmt.Errorf("pseudonym: the issuer key's attribute %d is %q, not %q", i, names[i], n)
		}
	}
	hsk, err := point(ipk.GetHSk())
	if err != nil {
		return nil, fmt.Errorf("pseudonym: the issuer key's HSk: %w", err)
	}
	hrand, err := point(ipk.GetHRand())
	if err != nil {
		return nil, fmt.Errorf("pseudonym: the issuer key's HRand: %w", err)
	}
	return &Key{HSk: hsk, HRand: hrand, Hash: sha256.Sum256(raw)}, nil
}

func point(e *amcl.ECP) (*math.G1, error) {
	if e == nil {
		return nil, errors.New("missing")
	}
	if len(e.X) != 32 || len(e.Y) != 32 {
		return nil, errors.New("not 32-byte coordinates")
	}
	g, ok := DecodePoint(append(append([]byte{}, e.X...), e.Y...))
	if !ok {
		return nil, errors.New("not a point of G1 other than the identity")
	}
	return g, nil
}

// HashHex is issuerKeyHash in lowercase hex, as the election record holds it.
func (k *Key) HashHex() string { return toHex(k.Hash[:]) }
