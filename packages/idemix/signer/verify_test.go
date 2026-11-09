package signer_test

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"google.golang.org/protobuf/proto"

	"github.com/weftwallet/weft/contracts/private-ballot/pseudonym"
	"github.com/weftwallet/weft/packages/idemix/signer"
)

// An explorer's checks of an anonymous ballot, from its creator and its
// pseudonym proof alone: they accept what the module makes and refuse a
// changed proof, a changed OU or role, a Nym from another identity and
// another issuer key.
func TestVerifyIdentity(t *testing.T) {
	is, key, _ := setup(t)
	cred := enrol(t, is, key, "voters", signer.RoleMember, "voter1")
	id, err := key.NewIdentity(cred, mspID)
	if err != nil {
		t.Fatal(err)
	}
	defer id.Dispose()
	got, err := key.VerifyIdentity(id.IDBytes)
	if err != nil {
		t.Fatalf("refused the module's own identity: %v", err)
	}
	if !bytes.Equal(got.Nym, id.Nym) || got.OU != "voters" || got.Role != "member" {
		t.Fatalf("read %+v", got)
	}

	sid := &msp.SerializedIdemixIdentity{}
	if err := proto.Unmarshal(id.IDBytes, sid); err != nil {
		t.Fatal(err)
	}
	remarshal := func(change func(s *msp.SerializedIdemixIdentity)) []byte {
		c := proto.Clone(sid).(*msp.SerializedIdemixIdentity)
		change(c)
		b, err := proto.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	other, err := key.NewIdentity(cred, mspID)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Dispose()
	otherOU, _ := proto.Marshal(&msp.OrganizationUnit{MspIdentifier: mspID, OrganizationalUnitIdentifier: "officers"})
	adminRole, _ := proto.Marshal(&msp.MSPRole{MspIdentifier: mspID, Role: msp.MSPRole_ADMIN})
	for name, idBytes := range map[string][]byte{
		"a changed proof":             remarshal(func(s *msp.SerializedIdemixIdentity) { s.Proof = flip(s.Proof, len(s.Proof)/2) }),
		"another identity's Nym":      remarshal(func(s *msp.SerializedIdemixIdentity) { s.NymX, s.NymY = other.Nym[:32], other.Nym[32:] }),
		"another organisational unit": remarshal(func(s *msp.SerializedIdemixIdentity) { s.Ou = otherOU }),
		"the role admin":              remarshal(func(s *msp.SerializedIdemixIdentity) { s.Role = adminRole }),
	} {
		if _, err := key.VerifyIdentity(idBytes); err != signer.ErrIdentityNotValid {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := key.VerifyIdentity([]byte("-----BEGIN CERTIFICATE-----")); err == nil {
		t.Error("a certificate was read as an idemix identity")
	}

	is2, key2, _ := setup(t)
	_ = is2
	if _, err := key2.VerifyIdentity(id.IDBytes); err != signer.ErrIdentityNotValid {
		t.Errorf("another issuer key: %v", err)
	}

	admin := enrol(t, is, key, "voters", signer.RoleAdmin, "registrar")
	aid, err := key.NewIdentity(admin, mspID)
	if err != nil {
		t.Fatal(err)
	}
	defer aid.Dispose()
	if got, err := key.VerifyIdentity(aid.IDBytes); err != nil || got.Role != "admin" {
		t.Fatalf("an admin credential: %+v, %v", got, err)
	}
}

func TestVerifyPseudonym(t *testing.T) {
	is, key, _ := setup(t)
	cred := enrol(t, is, key, "voters", signer.RoleMember, "voter1")
	id, err := key.NewIdentity(cred, mspID)
	if err != nil {
		t.Fatal(err)
	}
	defer id.Dispose()
	other, err := key.NewIdentity(cred, mspID)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Dispose()
	tracking := bytes.Repeat([]byte{9}, 32)
	proof, err := id.PseudonymProof("privatevote-chair-2027", "chair-2027", tracking)
	if err != nil {
		t.Fatal(err)
	}
	text, _ := json.Marshal(proof)
	if err := key.VerifyPseudonym(id.Nym, "privatevote-chair-2027", "chair-2027", tracking, string(text)); err != nil {
		t.Fatalf("refused its own proof: %v", err)
	}
	cases := map[string]error{}
	cases["another Nym"] = key.VerifyPseudonym(other.Nym, "privatevote-chair-2027", "chair-2027", tracking, string(text))
	cases["another election"] = key.VerifyPseudonym(id.Nym, "privatevote-chair-2027", "chair-2028", tracking, string(text))
	cases["another channel"] = key.VerifyPseudonym(id.Nym, "privatevote-chair-2028", "chair-2027", tracking, string(text))
	cases["another tracking code"] = key.VerifyPseudonym(id.Nym, "privatevote-chair-2027", "chair-2027", bytes.Repeat([]byte{8}, 32), string(text))
	for name, err := range cases {
		if err != pseudonym.ErrNotValid {
			t.Errorf("%s: %v", name, err)
		}
	}
	bad := proof
	bad.C = hex.EncodeToString(bytes.Repeat([]byte{0xff}, 32))
	text, _ = json.Marshal(bad)
	if err := key.VerifyPseudonym(id.Nym, "privatevote-chair-2027", "chair-2027", tracking, string(text)); err == nil || err.Error() != "The pseudonym proof's c isn't a canonical scalar." {
		t.Errorf("a scalar above the order: %v", err)
	}
	if err := key.VerifyPseudonym(id.Nym, "privatevote-chair-2027", "chair-2027", tracking, "[]"); err == nil {
		t.Error("an array was accepted as a proof")
	}
}
