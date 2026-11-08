package contract

import (
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"google.golang.org/protobuf/proto"

	"github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract/internal/tally"
	"github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract/pseudonym"
)

// The contract checks each anonymous creator's proof against the election's
// pinned issuer key (review packet Q2), as the peer's idemix MSP checks it
// against the channel's key, which the contract can't read.

const proofNotValid = "This credential can't vote in this election: its proof isn't valid for the election's issuer key."

// withIdemix returns the identity with its SerializedIdemixIdentity changed.
func withIdemix(t *testing.T, who identity, change func(*msp.SerializedIdemixIdentity)) identity {
	t.Helper()
	sid := &msp.SerializedIdemixIdentity{}
	if err := proto.Unmarshal(who.idBytes, sid); err != nil {
		t.Fatal(err)
	}
	change(sid)
	b, err := proto.Marshal(sid)
	if err != nil {
		t.Fatal(err)
	}
	return identity{who.msp, b}
}

// TestACredentialFromAReplacementKeyIsRefused is the attack in Q2: the
// channel's administrators replace the voter MSP's issuer key with one that
// copies the pinned key's HSk and HRand, and issue themselves credentials.
// The peer, reading the replaced configuration, accepts their creators, and
// their pseudonym proofs verify under the pinned key. Only the contract's
// own check of the creator's proof refuses them.
func TestACredentialFromAReplacementKeyIsRefused(t *testing.T) {
	a, _, _ := issuers(t)
	_, n, id := chair(t, a)
	L := len(record(t, n.get(t, keyElection, id)).Options)
	forged := forgedIssuer(t, a)
	if forged.key.Hash == a.key.Hash || !forged.key.HSk.Equals(a.key.HSk) || !forged.key.HRand.Equals(a.key.HRand) {
		t.Fatal("the forged key should differ from the pinned one but share its HSk and HRand")
	}
	minted := newCredential(forged, "voters", msp.MSPRole_MEMBER)
	_, p := prepare(t, n, id)
	from := minted.identity(t)
	P := pseudonym.EncodePoint(pseudonym.Pseudonym(minted.sk, n.channel, id))
	tag := tally.VoterTagIdemix(n.channel, id, votersMSP, P)
	ballot := makeBallot(t, p, id, tag, oneHot(L, 0), nil)
	d, err := tally.ParseBallot(&p.Setup, ballot)
	if err != nil {
		t.Fatal(err)
	}
	tracking := tally.TrackingCode(p, tag, d)
	// The pseudonym proof is made for the pinned key, whose hash the contract binds.
	proof := minted.proofFor(t, n, id, from, a.key, tracking)

	sid := &msp.SerializedIdemixIdentity{}
	if err := proto.Unmarshal(from.who.idBytes, sid); err != nil {
		t.Fatal(err)
	}
	// What a peer with the replaced configuration checks: the creator's proof under the forged key.
	if err := forged.key.VerifyIdentity(sid.Proof, from.nym, "voters", pseudonym.RoleMember); err != nil {
		t.Fatalf("the minted creator should verify under the forged key: %v", err)
	}
	// What the contract checked before this fix: the pseudonym proof under the pinned key.
	var j pseudonym.JSON
	if err := json.Unmarshal([]byte(proof), &j); err != nil {
		t.Fatal(err)
	}
	decoded, err := pseudonym.Decode(j)
	if err != nil {
		t.Fatal(err)
	}
	tb, _ := hex.DecodeString(tracking)
	if err := pseudonym.Verify(&pseudonym.Statement{Key: a.key, Channel: n.channel, ElectionID: id, Tracking: tb, Nym: from.nym}, decoded); err != nil {
		t.Fatalf("the minted ballot's pseudonym proof should verify under the pinned key: %v", err)
	}
	// The credential's signature is under the forged key's W, so the pinned key refuses it.
	if err := a.key.VerifyIdentity(sid.Proof, from.nym, "voters", pseudonym.RoleMember); err == nil {
		t.Fatal("the minted creator verifies under the pinned key")
	}
	refused(t, n.endorse(from.who, "CastAnonymousBallot", id, ballot, proof), proofNotValid)
	// Each new credential and identity under the forged key is refused the same way.
	for i := 0; i < 3; i++ {
		another := newCredential(forged, "voters", msp.MSPRole_MEMBER)
		v := another.vote(t, n, id, oneHot(L, i%L), nil)
		refused(t, n.endorse(v.from.who, "CastAnonymousBallot", id, v.ballot, another.proofFor(t, n, id, v.from, a.key, v.tracking)), proofNotValid)
	}
	if n.get(t, keyVoted, id, hexOf(tag)) != nil {
		t.Fatal("the minted credential's tag is marked as voted")
	}
	// A credential from the pinned key still votes.
	honest := newCredential(a, "voters", msp.MSPRole_MEMBER).vote(t, n, id, oneHot(L, 1), nil)
	ok(t, honest.cast(n, id))
}

func TestCredentialProofRefusals(t *testing.T) {
	a, b, _ := issuers(t)
	_, n, id := chair(t, a)
	L := len(record(t, n.get(t, keyElection, id)).Options)
	voter := newCredential(a, "voters", msp.MSPRole_MEMBER)
	v := voter.vote(t, n, id, oneHot(L, 0), nil)
	other := voter.identity(t)
	sidOf := func(who identity) *msp.SerializedIdemixIdentity {
		sid := &msp.SerializedIdemixIdentity{}
		if err := proto.Unmarshal(who.idBytes, sid); err != nil {
			t.Fatal(err)
		}
		return sid
	}
	// A credential of the pinned key's OU "org1", whose creator says it is "voters".
	org1 := newCredential(a, "org1", msp.MSPRole_MEMBER).identity(t)
	// An admin credential, whose creator says it is a member.
	admin := newCredential(a, "voters", msp.MSPRole_ADMIN).identity(t)
	votersOU, _ := proto.Marshal(&msp.OrganizationUnit{MspIdentifier: votersMSP, OrganizationalUnitIdentifier: "voters", CertifiersIdentifier: a.ipk.Hash})
	memberRole, _ := proto.Marshal(&msp.MSPRole{MspIdentifier: votersMSP, Role: msp.MSPRole_MEMBER})
	for name, who := range map[string]identity{
		"a credential from another issuer key":   newCredential(b, "voters", msp.MSPRole_MEMBER).identity(t).who,
		"no proof":                               withIdemix(t, v.from.who, func(s *msp.SerializedIdemixIdentity) { s.Proof = nil }),
		"a proof that isn't a signature":         withIdemix(t, v.from.who, func(s *msp.SerializedIdemixIdentity) { s.Proof = []byte("proof") }),
		"another identity's proof":               withIdemix(t, v.from.who, func(s *msp.SerializedIdemixIdentity) { s.Proof = sidOf(other.who).Proof }),
		"a credential of another affiliation":    withIdemix(t, org1.who, func(s *msp.SerializedIdemixIdentity) { s.Ou = votersOU }),
		"an admin credential stated as a member": withIdemix(t, admin.who, func(s *msp.SerializedIdemixIdentity) { s.Role = memberRole }),
	} {
		got := n.endorse(who, "CastAnonymousBallot", id, v.ballot, v.pseudonym)
		if got.err != proofNotValid {
			t.Errorf("%s: %q", name, got.err)
		}
	}
	// The check comes before any argument is parsed.
	refused(t, n.endorse(withIdemix(t, v.from.who, func(s *msp.SerializedIdemixIdentity) { s.Proof = nil }), "CastAnonymousBallot", id, "not json", "not json"), proofNotValid)
	// And the identity with its own proof is accepted.
	ok(t, v.cast(n, id))
}

// go test -run XXX -bench CredentialProof ./contract
//
// The check this file tests, which every endorser of CastAnonymousBallot
// now runs once per ballot, alone and with the issuer key's decoding.
func BenchmarkCredentialProof(b *testing.B) {
	a, _, _ := issuers(b)
	from := newCredential(a, "voters", msp.MSPRole_MEMBER).identity(b)
	sid := &msp.SerializedIdemixIdentity{}
	if err := proto.Unmarshal(from.who.idBytes, sid); err != nil {
		b.Fatal(err)
	}
	b.Run("verify", func(b *testing.B) {
		for b.Loop() {
			if err := credentialProof(a.key, sid, from.nym, "voters"); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("load the key", func(b *testing.B) {
		for b.Loop() {
			if _, err := pseudonym.LoadIssuerKey(a.raw); err != nil {
				b.Fatal(err)
			}
		}
	})
}
