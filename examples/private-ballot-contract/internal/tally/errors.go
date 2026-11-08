package tally

import "fmt"

// Error is a refusal with the contract's exact message, from the error table
// in contract-api.md. @weftwallet/tally builds the same strings, and the
// negative test vectors hold them.
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

func refuse(format string, args ...any) error { return &Error{Msg: fmt.Sprintf(format, args...)} }

// count writes "1 ciphertext" or "3 ciphertexts".
func count(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}

// The kinds of JSON argument, as the messages name them.
const (
	thingBallot   = "The ballot"
	thingRound1   = "The round 1 post"
	thingRound2   = "The round 2 post"
	thingConfirm  = "The confirmation"
	thingDecShare = "The decryption share"
	thingElection = "The election"
	// thingPseudonym is the pseudonym package's Thing.
	thingPseudonym = "The pseudonym proof"
)

func errNotJSON(t string) error   { return refuse("%s isn't JSON.", t) }
func errNotObject(t string) error { return refuse("%s isn't a JSON object.", t) }
func errMissing(t, path string) error {
	return refuse("%s isn't in the version 1 format: %s is missing.", t, path)
}
func errUnknownField(t, path string) error {
	return refuse("%s isn't in the version 1 format: it has an unknown field, %s.", t, path)
}
func errWrongType(t, path, kind string) error {
	return refuse("%s isn't in the version 1 format: %s isn't %s.", t, path, kind)
}
func errNotPoint(t, path string) error  { return refuse("%s's %s isn't a canonical point.", t, path) }
func errNotScalar(t, path string) error { return refuse("%s's %s isn't a canonical scalar.", t, path) }
func errNotBytes(t, path string, n int) error {
	return refuse("%s's %s isn't %d bytes of lowercase hex.", t, path, n)
}

func errVotersKind() error {
	return refuse("%s isn't in the version 1 format: voters.kind is neither \"x509\" nor \"idemix\".", thingElection)
}

func errWrongElection() error { return refuse("The ballot isn't for this election.") }
func errCiphertextCount(n, l int) error {
	return refuse("The ballot has %s; this election has %d options.", count(n, "ciphertext"), l)
}
func errBitProofCount(n, l int) error {
	return refuse("The ballot has %s; this election has %d options.", count(n, "bit proof"), l)
}
func errNoRandomness(j int) error { return refuse("Ciphertext %d has no randomness.", j) }
func errNotBit(j int) error       { return refuse("Ciphertext %d is not a 0 or a 1.", j) }
func errNotOne() error            { return refuse("The ballot does not choose exactly one option.") }
func errRepeated() error          { return refuse("A ciphertext in this ballot is already on the ledger.") }
func errRepeatedInBallot(i, j int) error {
	return refuse("Ciphertexts %d and %d have the same randomness.", i, j)
}
func errIdentityVoted() error   { return refuse("This identity has already voted in this election.") }
func errCredentialVoted() error { return refuse("This credential has already voted in this election.") }
func errProofOfKnowledge(msp string) error {
	return refuse("The proof of knowledge from %s doesn't verify.", msp)
}
func errCommitmentCount(msp string, n, k int) error {
	return refuse("Round 1 from %s has %s; this election's threshold is %d.", msp, count(n, "commitment"), k)
}
func errIdentityCommitment(msp string, t int) error {
	return refuse("Commitment %d from %s is the identity point.", t, msp)
}
func errIdentityCeremonyKey(msp string) error {
	return refuse("The one-time key from %s is the identity point.", msp)
}
func errShareRecipients(msp string) error {
	return refuse("Round 2 from %s doesn't send exactly one share to each other trustee.", msp)
}
func errConfirmation(msp string) error {
	return refuse("The confirmation from %s doesn't match its verifying share.", msp)
}
func errShareCount(n, l int) error {
	entries := fmt.Sprintf("%d entries", n)
	if n == 1 {
		entries = "1 entry"
	}
	return refuse("The decryption share has %s; this election has %d options.", entries, l)
}
func errShare(j int, msp string) error {
	return refuse("Share %d from %s does not match its key.", j, msp)
}
func errTooFewShares(k, m int) error {
	verb := "have"
	if m == 1 {
		verb = "has"
	}
	return refuse("The tally needs %d decryption shares; %d %s been posted.", k, m, verb)
}
func errCountTooLarge() error {
	return refuse("A count is larger than the number of ballots, so the totals or shares are wrong.")
}
func errCountsSum(s, n int) error {
	return refuse("The counts add up to %d, not to the %s, so the totals or shares are wrong.", s, count(n, "ballot"))
}
