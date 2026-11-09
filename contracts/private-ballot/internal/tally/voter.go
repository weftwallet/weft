package tally

import (
	"crypto/x509"
	"encoding/asn1"
	"encoding/pem"
)

// VoterTagX509 returns v = SHA-256(frame(["weft-voter x509 v2", channel, electionId, mspId, enrolmentId])),
// from the mspid of the transaction creator's SerializedIdentity and the
// enrolment ID that EnrolmentID reads from its id_bytes.
func VoterTagX509(channel, electionID, mspID, enrolmentID string) []byte {
	return digest(LabelVoterX509, channel, electionID, mspID, enrolmentID)
}

// VoterTagIdemix returns v = SHA-256(frame(["weft-voter idemix v1", channel, electionId, mspId, P])),
// with the 64-byte per-election pseudonym P.
func VoterTagIdemix(channel, electionID, mspID string, pseudonym []byte) []byte {
	if len(pseudonym) != 64 {
		panic("tally: the per-election pseudonym is 64 bytes")
	}
	return digest(LabelVoterIdemix, channel, electionID, mspID, pseudonym)
}

// EnrolmentID returns an X.509 creator's enrolment ID, from the id_bytes of
// its SerializedIdentity (private-tally-spec.md, The voter tag). The
// id_bytes decode with pem.Decode, as Fabric's MSP decodes them, to a
// CERTIFICATE block; the block parses with x509.ParseCertificate; and the
// certificate's subject has exactly one commonName attribute, a non-empty
// UTF8String or PrintableString. The enrolment ID is that attribute's
// value, the bytes inside the string's DER encoding. Fabric CA writes the
// enrolment ID there and refuses any other common name, so the value is the
// same in every certificate the CA issues for the ID, however the PEM text
// around it is written.
func EnrolmentID(idBytes []byte) (string, error) {
	block, _ := pem.Decode(idBytes)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", errNotX509Voter()
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", errCertificate()
	}
	id, ok := commonName(cert.RawSubject)
	if !ok {
		return "", errNoEnrolmentID()
	}
	return id, nil
}

var oidCommonName = asn1.ObjectIdentifier{2, 5, 4, 3}

// The DER string types a common name may have.
const (
	tagUTF8String      = 12
	tagPrintableString = 19
)

type attributeTypeAndValue struct {
	Type  asn1.ObjectIdentifier
	Value asn1.RawValue
}

// rdnSET is a RelativeDistinguishedName; encoding/asn1 decodes a slice
// type whose name ends in SET as a SET OF.
type rdnSET []attributeTypeAndValue

// commonName returns the value of the one commonName attribute in a Name,
// the certificate's raw subject, if there is exactly one and it is a
// non-empty UTF8String or PrintableString. x509.ParseCertificate has
// already checked the Name's encoding and each string's characters.
func commonName(rawSubject []byte) (string, bool) {
	var rdns []rdnSET
	rest, err := asn1.Unmarshal(rawSubject, &rdns)
	if err != nil || len(rest) != 0 {
		return "", false
	}
	var values []asn1.RawValue
	for _, rdn := range rdns {
		for _, atv := range rdn {
			if atv.Type.Equal(oidCommonName) {
				values = append(values, atv.Value)
			}
		}
	}
	if len(values) != 1 {
		return "", false
	}
	v := values[0]
	if v.Class != asn1.ClassUniversal || v.IsCompound || (v.Tag != tagUTF8String && v.Tag != tagPrintableString) || len(v.Bytes) == 0 {
		return "", false
	}
	return string(v.Bytes), true
}
