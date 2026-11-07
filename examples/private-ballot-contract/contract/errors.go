package contract

import (
	"fmt"
	"strings"
)

// Refusal is a call the contract refuses, with its exact message from the
// error table in contract-api.md. The verifiers' own refusals are
// tally.Error, with messages from the same table.
type Refusal struct{ Msg string }

func (r *Refusal) Error() string { return r.Msg }

func refuse(format string, args ...any) error { return &Refusal{Msg: fmt.Sprintf(format, args...)} }

func errNoElection(id string) error { return refuse("There's no election %s.", id) }
func errExists(id string) error     { return refuse("Election %s already exists.", id) }
func errElectionID() error {
	return refuse("Election IDs are 1 to 64 letters, digits, - or _.")
}
func errOptions() error { return refuse("An election has 2 to 20 options, all different.") }
func errTrustees() error {
	return refuse("An election has at least two trustee organisations, all different.")
}
func errThreshold() error { return refuse("The threshold must be from 2 to the number of trustees.") }
func errClosesAt() error {
	return refuse("closesAt isn't a time in the form 2027-01-31T17:00:00.000Z.")
}
func errIdemixUnsupported() error {
	return refuse("Elections with voter credentials aren't supported by this version of the contract.")
}
func errNotNamedTrustee(msp string) error {
	return refuse("%s isn't one of the trustee organisations named in this election.", msp)
}
func errNotTrustee(msp string) error { return refuse("%s isn't a trustee of this election.", msp) }
func errNoTrusteeAttribute() error {
	return refuse("This identity can't act as a trustee: its certificate doesn't carry weft.trustee=true.")
}
func errNotCreator(msp string) error {
	return refuse("%s didn't create this election, so it can't cancel it.", msp)
}
func errCeremonyEnded(state string) error {
	return refuse("The key ceremony has ended: the election is in %s.", state)
}
func errAlreadyPosted(msp string, round int) error {
	return refuse("%s has already posted round %d.", msp, round)
}
func errRoundNotFinished(round int, msp string) error {
	return refuse("Round %d isn't finished: waiting for %s.", round, msp)
}
func errNotAnotherTrustee(id string) error {
	return refuse("Trustee %s isn't another trustee of this election.", id)
}
func errNotOpen(state string) error { return refuse("The election isn't open: it is in %s.", state) }
func errVotingClosed() error        { return refuse("Voting has closed.") }
func errAlreadyClosed(state string) error {
	return refuse("Voting has already closed: the election is in %s.", state)
}
func errNotVoter(msp string) error {
	return refuse("This identity can't vote in this election: %s isn't one of its voter organisations.", msp)
}
func errNotDecrypting(state string) error {
	return refuse("The election is in %s: decryption shares are posted while it is in decrypting.", state)
}
func errSharePosted(msp string) error {
	return refuse("%s has already posted its decryption share.", msp)
}
func errTallyPublished() error { return refuse("The tally is already published.") }
func errCantPublish(state string) error {
	return refuse("The tally can't be published: the election is in %s.", state)
}
func errNotX509(action string) error {
	return refuse("This identity can't %s: it isn't an X.509 identity.", action)
}
func errNoBallot(tracking, id string) error {
	return refuse("There's no ballot with tracking code %s in election %s.", tracking, id)
}
func errNoFunction(name string) error { return refuse("The contract has no function %s.", name) }
func errArguments(name string, params []string) error {
	n := "1 argument"
	if len(params) != 1 {
		n = fmt.Sprintf("%d arguments", len(params))
	}
	list := strings.Join(params, ", ")
	if len(params) > 1 {
		list = strings.Join(params[:len(params)-1], ", ") + " and " + params[len(params)-1]
	}
	return refuse("%s takes %s: %s.", name, n, list)
}
