// Command private-ballot-contract is the private-ballot chaincode for Weft
// Experimental (ADR 0007). The peer builds this package, at the module's
// root, with test-network's deployCC -ccl go, and starts it as a chaincode
// that connects to the peer. See README.md.
package main

import (
	"fmt"
	"os"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"

	"github.com/ifeanyi-ugwu/weft/examples/private-ballot-contract/contract"
)

func main() {
	if err := shim.Start(contract.New()); err != nil {
		fmt.Fprintf(os.Stderr, "private-ballot couldn't start: %v\n", err)
		os.Exit(1)
	}
}
