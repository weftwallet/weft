package tally

import (
	"encoding/json"
	"strconv"
)

// ElectionRequest is CreateElection's electionJson once it has parsed into
// its fixed fields. The contract checks the values themselves.
type ElectionRequest struct {
	ID        string
	Title     string
	Options   []string
	ClosesAt  string
	Trustees  []string
	Threshold float64 // as JSON.parse reads it; the contract checks it is a whole number
	Voters    VotersRequest
}

// VotersRequest is electionJson's voters, one of two kinds.
type VotersRequest struct {
	Kind string
	// For "x509".
	Msps []string
	// For "idemix".
	Msp             string
	IssuerPublicKey string
	IssuerKeyHash   string
	Curve           string
}

var electionSchema = sObj(
	f("id", sStr),
	f("title", sStr),
	f("options", sList(sStr)),
	f("closesAt", sStr),
	f("trustees", sList(sStr)),
	f("threshold", sNum),
	f("voters", &schema{kind: kindObject, open: true}),
)

var votersSchemas = map[string]*schema{
	"x509":   sObj(f("kind", sStr), f("msps", sList(sStr))),
	"idemix": sObj(f("kind", sStr), f("msp", sStr), f("issuerPublicKey", sStr), f("issuerKeyHash", sStr), f("curve", sStr)),
}

func stringList(x any) []string {
	out := []string{}
	for _, item := range x.([]any) {
		out = append(out, item.(string))
	}
	return out
}

// ParseElectionRequest parses electionJson as the other arguments are
// parsed, with "The election" in the messages. voters is read last: its
// kind, which must be a string, chooses the fields the rest of it has.
func ParseElectionRequest(text string) (*ElectionRequest, error) {
	const t = thingElection
	x, err := parseStrict(t, text, electionSchema)
	if err != nil {
		return nil, err
	}
	voters := x["voters"].(map[string]any)
	kind, ok := voters["kind"]
	if !ok {
		return nil, errMissing(t, "voters.kind")
	}
	k, ok := kind.(string)
	if !ok {
		return nil, errWrongType(t, "voters.kind", kindNames[kindString])
	}
	vs, ok := votersSchemas[k]
	if !ok {
		return nil, errVotersKind()
	}
	if err := walk(t, voters, vs, "voters"); err != nil {
		return nil, err
	}
	// Out of range, ParseFloat returns an infinity, as JSON.parse does.
	threshold, _ := strconv.ParseFloat(string(x["threshold"].(json.Number)), 64)
	r := &ElectionRequest{
		ID:        x["id"].(string),
		Title:     x["title"].(string),
		Options:   stringList(x["options"]),
		ClosesAt:  x["closesAt"].(string),
		Trustees:  stringList(x["trustees"]),
		Threshold: threshold,
		Voters:    VotersRequest{Kind: k},
	}
	if k == "x509" {
		r.Voters.Msps = stringList(voters["msps"])
	} else {
		r.Voters.Msp = voters["msp"].(string)
		r.Voters.IssuerPublicKey = voters["issuerPublicKey"].(string)
		r.Voters.IssuerKeyHash = voters["issuerKeyHash"].(string)
		r.Voters.Curve = voters["curve"].(string)
	}
	return r, nil
}
