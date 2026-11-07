// Package contract is the private-ballot contract (ADR 0007), on
// fabric-chaincode-go's shim: its functions, state keys, events and errors
// are those in apps/docs/src/content/docs/experimental/contract-api.md.
//
// Every function is deterministic. None reads a clock, the transaction's
// timestamp or any randomness, and none iterates over a Go map to decide
// what it writes, so every endorser writes the same bytes.
//
// Unreviewed cryptography, for Weft Experimental only.
package contract

import (
	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-protos-go-apiv2/peer"
)

// Contract implements shim.Chaincode.
type Contract struct{}

// New returns the contract.
func New() *Contract { return &Contract{} }

type handler func(stub shim.ChaincodeStubInterface, args []string) ([]byte, error)

type function struct {
	params []string
	run    handler
}

var functions = map[string]function{
	"CreateElection":      {[]string{"electionJson"}, createElection},
	"PostCommitments":     {[]string{"electionId", "round1Json"}, postCommitments},
	"PostShares":          {[]string{"electionId", "round2Json"}, postShares},
	"ConfirmShares":       {[]string{"electionId", "proofJson"}, confirmShares},
	"ReportBadShare":      {[]string{"electionId", "fromTrustee"}, reportBadShare},
	"CancelElection":      {[]string{"electionId"}, cancelElection},
	"OpenElection":        {[]string{"electionId"}, openElection},
	"CastBallot":          {[]string{"electionId", "ballotJson"}, castBallot},
	"CastAnonymousBallot": {[]string{"electionId", "ballotJson", "pseudonymJson"}, castAnonymousBallot},
	"CloseElection":       {[]string{"electionId"}, closeElection},
	"PostDecryptionShare": {[]string{"electionId", "shareJson"}, postDecryptionShare},
	"PublishTally":        {[]string{"electionId"}, publishTally},
	"GetElection":         {[]string{"electionId"}, getElection},
	"GetCeremony":         {[]string{"electionId"}, getCeremony},
	"GetBallot":           {[]string{"electionId", "tracking"}, getBallot},
	"GetDecryptionShares": {[]string{"electionId"}, getDecryptionShares},
}

// Init does nothing: the contract is deployed without --init-required.
func (c *Contract) Init(shim.ChaincodeStubInterface) *peer.Response { return shim.Success(nil) }

// Invoke runs one function. A refusal is an error response, so the peer
// discards the transaction's writes and the client gets the message.
func (c *Contract) Invoke(stub shim.ChaincodeStubInterface) *peer.Response {
	name, args := stub.GetFunctionAndParameters()
	payload, err := call(stub, name, args)
	if err != nil {
		return shim.Error(err.Error())
	}
	return shim.Success(payload)
}

func call(stub shim.ChaincodeStubInterface, name string, args []string) ([]byte, error) {
	fn, ok := functions[name]
	if !ok {
		return nil, errNoFunction(name)
	}
	if len(args) != len(fn.params) {
		return nil, errArguments(name, fn.params)
	}
	return fn.run(stub, args)
}
