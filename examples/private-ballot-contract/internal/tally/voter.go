package tally

// VoterTagX509 returns v = SHA-256(frame(["weft-voter x509 v1", channel, electionId, mspId, idBytes])),
// from the mspid and id_bytes of the transaction creator's SerializedIdentity.
func VoterTagX509(channel, electionID, mspID string, idBytes []byte) []byte {
	return digest(LabelVoterX509, channel, electionID, mspID, idBytes)
}

// VoterTagIdemix returns v = SHA-256(frame(["weft-voter idemix v1", channel, electionId, mspId, P])),
// with the 64-byte per-election pseudonym P.
func VoterTagIdemix(channel, electionID, mspID string, pseudonym []byte) []byte {
	if len(pseudonym) != 64 {
		panic("tally: the per-election pseudonym is 64 bytes")
	}
	return digest(LabelVoterIdemix, channel, electionID, mspID, pseudonym)
}
