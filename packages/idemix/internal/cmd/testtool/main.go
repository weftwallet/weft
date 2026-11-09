// Command testtool is the scratch issuer and IBM idemix's MSP verifier for
// the Node tests, which can't run Go themselves. Each subcommand reads JSON
// on stdin, writes JSON on stdout, and exits with status 1 and the error on
// stderr when something fails.
//
//	testtool issuer <dir>  makes an issuer in dir: { issuerPublicKey, revocationPublicKey, nonce }
//	testtool issue <dir>   { nonce, request, ou, role, enrollmentId } → { credential, cri, revocationHandle }
//	testtool verify        { mspId, issuerPublicKey, revocationPublicKey, creator, message, signature } → { mspId, ou, role }
//	testtool pseudonym     { issuerPublicKey, idBytes, channel, electionId, tracking, pseudonymJson } → { pseudonym }
//
// pseudonym is the contract's verifier: the pseudonym proof checked against
// the Nym in idBytes (a SerializedIdemixIdentity), with the contract's
// message when it fails. tracking is lowercase hex.
//
// Bytes are base64; request is the JSON the module's credentialRequest gives,
// which Fabric CA reads with encoding/json, as here.
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"encoding/hex"

	idemix "github.com/IBM/idemix/bccsp/schemes/dlog/crypto"
	"github.com/hyperledger/fabric-protos-go-apiv2/msp"
	"google.golang.org/protobuf/proto"

	"github.com/weftwallet/weft/contracts/private-ballot/pseudonym"
	"github.com/weftwallet/weft/packages/idemix/internal/testtool"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func output(v any) error { return json.NewEncoder(os.Stdout).Encode(v) }

func input(v any) error {
	b, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func b64(s string) []byte {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		panic(fmt.Sprintf("not base64: %q", s))
	}
	return b
}

var enc = base64.StdEncoding.EncodeToString

func run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: testtool issuer|issue|verify|pseudonym")
	}
	switch args[0] {
	case "issuer":
		is, err := testtool.NewIssuer()
		if err != nil {
			return err
		}
		if err := is.Save(args[1]); err != nil {
			return err
		}
		return output(map[string]string{"issuerPublicKey": enc(is.PublicKey), "revocationPublicKey": enc(is.RevocationPublicKey), "nonce": enc(testtool.Nonce())})
	case "issue":
		var in struct {
			Nonce        string          `json:"nonce"`
			Request      json.RawMessage `json:"request"`
			OU           string          `json:"ou"`
			Role         int             `json:"role"`
			EnrollmentID string          `json:"enrollmentId"`
		}
		if err := input(&in); err != nil {
			return err
		}
		req := &idemix.CredRequest{}
		if err := json.Unmarshal(in.Request, req); err != nil {
			return fmt.Errorf("the request isn't a CredRequest as Fabric CA reads it: %w", err)
		}
		raw, err := proto.Marshal(req)
		if err != nil {
			return err
		}
		is, err := testtool.LoadIssuer(args[1])
		if err != nil {
			return err
		}
		issued, err := is.Issue(raw, b64(in.Nonce), in.OU, in.Role, in.EnrollmentID)
		if err != nil {
			return err
		}
		return output(map[string]any{"credential": enc(issued.Credential), "cri": enc(issued.CRI), "revocationHandle": issued.RevocationHandle})
	case "verify":
		var in struct {
			MspID               string `json:"mspId"`
			IssuerPublicKey     string `json:"issuerPublicKey"`
			RevocationPublicKey string `json:"revocationPublicKey"`
			Creator             string `json:"creator"`
			Message             string `json:"message"`
			Signature           string `json:"signature"`
		}
		if err := input(&in); err != nil {
			return err
		}
		v, err := testtool.NewMSP(in.MspID, b64(in.IssuerPublicKey), b64(in.RevocationPublicKey))
		if err != nil {
			return err
		}
		got, err := v.Verify(b64(in.Creator), b64(in.Message), b64(in.Signature))
		if err != nil {
			return err
		}
		return output(map[string]string{"mspId": got.MspID, "ou": got.OU, "role": got.Role})
	case "pseudonym":
		var in struct {
			IssuerPublicKey string `json:"issuerPublicKey"`
			IDBytes         string `json:"idBytes"`
			Channel         string `json:"channel"`
			ElectionID      string `json:"electionId"`
			Tracking        string `json:"tracking"`
			PseudonymJSON   string `json:"pseudonymJson"`
		}
		if err := input(&in); err != nil {
			return err
		}
		key, err := pseudonym.LoadIssuerKey(b64(in.IssuerPublicKey))
		if err != nil {
			return err
		}
		sid := &msp.SerializedIdemixIdentity{}
		if err := proto.Unmarshal(b64(in.IDBytes), sid); err != nil {
			return err
		}
		nym, ok := pseudonym.DecodePoint(append(append([]byte{}, sid.NymX...), sid.NymY...))
		if !ok {
			return fmt.Errorf("the identity's Nym isn't a point of G1")
		}
		tracking, err := hex.DecodeString(in.Tracking)
		if err != nil {
			return err
		}
		var j pseudonym.JSON
		if err := json.Unmarshal([]byte(in.PseudonymJSON), &j); err != nil {
			return fmt.Errorf("%s isn't JSON.", pseudonym.Thing)
		}
		proof, err := pseudonym.Decode(j)
		if err != nil {
			return err
		}
		st := &pseudonym.Statement{Key: key, Channel: in.Channel, ElectionID: in.ElectionID, Tracking: tracking, Nym: nym}
		if err := pseudonym.Verify(st, proof); err != nil {
			return err
		}
		return output(map[string]string{"pseudonym": hex.EncodeToString(proof.PBytes())})
	}
	return fmt.Errorf("no subcommand %s", args[0])
}
