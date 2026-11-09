package tally

import (
	"bytes"
	"encoding/json"
	"io"
	"sort"
	"strconv"
)

// Strict parsing of the contract's JSON arguments into fixed fields, in the
// same order as @weftwallet/tally's parseStrict, because the first failure
// decides the message: at each object, unknown fields first (in the byte
// order of their names), then each field in the schema's order, depth first;
// list items in order.

type kind int

const (
	kindString kind = iota
	kindNumber
	kindList
	kindObject
)

var kindNames = map[kind]string{kindString: "a string", kindNumber: "a number", kindList: "a list", kindObject: "an object"}

type field struct {
	name   string
	schema *schema
}

type schema struct {
	kind   kind
	of     *schema
	fields []field
	// open accepts any fields: the object is checked later, once a field
	// in it has chosen its schema (CreateElection's voters, by kind).
	open bool
}

var (
	sStr = &schema{kind: kindString}
	sNum = &schema{kind: kindNumber}
)

func sList(of *schema) *schema       { return &schema{kind: kindList, of: of} }
func sObj(fields ...field) *schema   { return &schema{kind: kindObject, fields: fields} }
func f(name string, s *schema) field { return field{name, s} }

func joinPath(path, name string) string {
	if path == "" {
		return name
	}
	return path + "." + name
}

func matches(x any, s *schema) bool {
	switch s.kind {
	case kindString:
		_, ok := x.(string)
		return ok
	case kindNumber:
		_, ok := x.(json.Number)
		return ok
	case kindList:
		_, ok := x.([]any)
		return ok
	default:
		_, ok := x.(map[string]any)
		return ok
	}
}

func walk(thing string, x map[string]any, s *schema, path string) error {
	if s.open {
		return nil
	}
	known := map[string]bool{}
	for _, fd := range s.fields {
		known[fd.name] = true
	}
	var unknown []string
	for k := range x {
		if !known[k] {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown) // byte order, as Go compares strings
		return errUnknownField(thing, joinPath(path, unknown[0]))
	}
	for _, fd := range s.fields {
		p := joinPath(path, fd.name)
		v, ok := x[fd.name]
		if !ok {
			return errMissing(thing, p)
		}
		if err := check(thing, v, fd.schema, p); err != nil {
			return err
		}
	}
	return nil
}

func check(thing string, x any, s *schema, path string) error {
	if !matches(x, s) {
		return errWrongType(thing, path, kindNames[s.kind])
	}
	switch s.kind {
	case kindObject:
		return walk(thing, x.(map[string]any), s, path)
	case kindList:
		for i, item := range x.([]any) {
			if err := check(thing, item, s.of, path+"["+strconv.Itoa(i)+"]"); err != nil {
				return err
			}
		}
	}
	return nil
}

// parseStrict checks text against the schema and returns the decoded object.
func parseStrict(thing, text string, s *schema) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader([]byte(text)))
	dec.UseNumber()
	var x any
	if err := dec.Decode(&x); err != nil {
		return nil, errNotJSON(thing)
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errNotJSON(thing)
	}
	obj, ok := x.(map[string]any)
	if !ok {
		return nil, errNotObject(thing)
	}
	if err := walk(thing, obj, s, ""); err != nil {
		return nil, err
	}
	return obj, nil
}

// numberIs reports whether a JSON number has the value want, compared as
// JavaScript compares the number JSON.parse gives.
func numberIs(n json.Number, want float64) bool {
	// Out of range, ParseFloat returns an infinity, as JSON.parse does.
	v, _ := strconv.ParseFloat(string(n), 64)
	return v == want
}
