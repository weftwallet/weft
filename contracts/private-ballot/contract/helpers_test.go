package contract

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/v2/pkg/attrmgr"
)

// The vectors @weftwallet/tally writes, read by relative path from the
// repository's root, and the contract's documentation, whose error table
// every refusal must come from.
var (
	vectorsDir  = filepath.Join("..", "..", "..", "packages", "tally", "vectors", "v1")
	contractAPI = filepath.Join("..", "..", "..", "apps", "docs", "src", "content", "docs", "experimental", "contract-api.md")
)

func load(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(vectorsDir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	out := make([]byte, len(s)/2)
	for i := range out {
		var b byte
		for _, c := range s[2*i : 2*i+2] {
			b <<= 4
			switch {
			case c >= '0' && c <= '9':
				b |= byte(c - '0')
			case c >= 'a' && c <= 'f':
				b |= byte(c-'a') + 10
			default:
				t.Fatalf("bad hex %q", s)
			}
		}
		out[i] = b
	}
	return out
}

// Identities. Trustee identities and other members carry real self-signed
// certificates, made once per run, so cid parses them as the peer's
// creators are parsed; the vectors' voters carry the placeholder PEM the
// vectors fix, which is all the voter tag reads.

var (
	certsMu sync.Mutex
	certs   = map[string][]byte{}
)

func certificate(t *testing.T, msp, name string, attrs map[string]string) []byte {
	certsMu.Lock()
	defer certsMu.Unlock()
	key := msp + "/" + name
	if b, ok := certs[key]; ok {
		return b
	}
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(int64(len(certs) + 1)),
		Subject:      pkix.Name{CommonName: name, Organization: []string{msp}, OrganizationalUnit: []string{"client"}},
		NotBefore:    time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:     time.Date(2036, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	if attrs != nil {
		value, _ := json.Marshal(map[string]any{"attrs": attrs})
		tmpl.ExtraExtensions = append(tmpl.ExtraExtensions, pkix.Extension{Id: attrmgr.AttrOID, Value: value})
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatal(err)
	}
	b := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	certs[key] = b
	return b
}

// trustee is msp's trustee identity, with weft.trustee=true.
func trustee(t *testing.T, msp string) identity {
	return identity{msp, certificate(t, msp, "trustee", map[string]string{"weft.trustee": "true", "hf.EnrollmentID": "trustee"})}
}

// member is an X.509 identity of msp without the trustee attribute.
func member(t *testing.T, msp string) identity {
	return identity{msp, certificate(t, msp, "user1", map[string]string{"hf.EnrollmentID": "user1"})}
}

// idemixCreator stands in for a voter credential: its id_bytes aren't a PEM certificate.
func idemixCreator(msp string) identity {
	return identity{msp, []byte("\x0a\x05voter\x12\x05voter")}
}

// Every refusal the tests see, for the check that every row of the error
// table is reached.
var (
	seenMu sync.Mutex
	seen   = map[string]bool{}
)

func saw(msg string) {
	seenMu.Lock()
	seen[msg] = true
	seenMu.Unlock()
}

// unreachable lists rows of the error table that no call can reach. Since
// CreateElection accepts voter credentials, there are none; a row added
// here needs the reason it can't be reached.
var unreachable = map[string]bool{}

// errorRows reads the messages in contract-api.md's two error tables and
// returns each as a pattern, with every <placeholder> matching any text.
func errorRows() (map[string]*regexp.Regexp, error) {
	b, err := os.ReadFile(contractAPI)
	if err != nil {
		return nil, err
	}
	text := string(b)
	start := strings.Index(text, "\n## Errors")
	if start < 0 {
		return nil, fmt.Errorf("contract-api.md has no Errors section")
	}
	text = text[start:]
	if end := strings.Index(text[1:], "\n## "); end >= 0 {
		text = text[:end+1]
	}
	rows := map[string]*regexp.Regexp{}
	row := regexp.MustCompile("(?m)^\\| `([^`]+)` \\|")
	placeholder := regexp.MustCompile(`<[^>]+>`)
	for _, m := range row.FindAllStringSubmatch(text, -1) {
		parts := placeholder.Split(m[1], -1)
		for i := range parts {
			parts[i] = regexp.QuoteMeta(parts[i])
		}
		rows[m[1]] = regexp.MustCompile("^" + strings.Join(parts, ".+") + "$")
	}
	if len(rows) < 40 {
		return nil, fmt.Errorf("found only %d rows in the error tables", len(rows))
	}
	return rows, nil
}

// TestMain runs the tests and, when all of them ran, checks that every
// refusal the contract made is a row of the error table, and that a test
// reaches every row that this version can reach.
func TestMain(m *testing.M) {
	code := m.Run()
	if code == 0 && flag.Lookup("test.run").Value.String() == "" {
		if msg := coverage(); msg != "" {
			os.Stderr.WriteString(msg)
			code = 1
		}
	}
	os.Exit(code)
}

// plural writes a message in the form its row has: the table gives the
// plural, and "isn't a string." stands for every type.
var (
	singular = regexp.MustCompile(`\b1 (ciphertext|bit proof|commitment|ballot|argument)\b`)
	typeName = regexp.MustCompile(`isn't (a number|a list|an object)\.$`)
)

func plural(msg string) string {
	msg = singular.ReplaceAllString(msg, "2 ${1}s")
	msg = strings.ReplaceAll(msg, "1 entry", "2 entries")
	msg = strings.ReplaceAll(msg, "1 has been posted", "2 have been posted")
	// The table gives OpenElection's message, and says CastBallot gives it
	// with "vote in this election".
	msg = strings.Replace(msg, "This identity can't vote in this election: it isn't an X.509 identity.", "This identity can't open the election: it isn't an X.509 identity.", 1)
	return typeName.ReplaceAllString(msg, "isn't a string.")
}

func coverage() string {
	rows, err := errorRows()
	if err != nil {
		return "FAIL error table: " + err.Error() + "\n"
	}
	var problems []string
	for raw := range seen {
		msg := plural(raw)
		matched := false
		for _, re := range rows {
			matched = matched || re.MatchString(msg)
		}
		if !matched {
			problems = append(problems, "a refusal that isn't in the error table: "+msg)
		}
	}
	for row, re := range rows {
		if unreachable[row] {
			continue
		}
		hit := false
		for msg := range seen {
			hit = hit || re.MatchString(plural(msg))
		}
		if !hit {
			problems = append(problems, "no test reaches the row: "+row)
		}
	}
	sort.Strings(problems)
	if len(problems) == 0 {
		return ""
	}
	return "FAIL error table coverage:\n  " + strings.Join(problems, "\n  ") + "\n"
}
