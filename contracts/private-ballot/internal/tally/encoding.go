package tally

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

// Frame returns frame([p_1, ..., p_m]) = len(p_1) || p_1 || ... || len(p_m) || p_m,
// each len a 4-byte big-endian integer. A part is a []byte, a string (its
// UTF-8 bytes) or an int or uint32, which is first written as 4 big-endian
// bytes.
func Frame(parts ...any) []byte {
	var out bytes.Buffer
	for _, p := range parts {
		b := partBytes(p)
		var n [4]byte
		binary.BigEndian.PutUint32(n[:], uint32(len(b)))
		out.Write(n[:])
		out.Write(b)
	}
	return out.Bytes()
}

func partBytes(p any) []byte {
	switch v := p.(type) {
	case []byte:
		return v
	case string:
		return []byte(v)
	case int:
		if v < 0 || int64(v) > 0xffffffff {
			panic(fmt.Sprintf("tally: not a 32-bit unsigned integer: %d", v))
		}
		return binary.BigEndian.AppendUint32(nil, uint32(v))
	case uint32:
		return binary.BigEndian.AppendUint32(nil, v)
	default:
		panic(fmt.Sprintf("tally: can't frame a %T", p))
	}
}

const hexDigits = "0123456789abcdef"

// ToHex returns lowercase hex.
func ToHex(b []byte) string {
	out := make([]byte, 2*len(b))
	for i, x := range b {
		out[2*i] = hexDigits[x>>4]
		out[2*i+1] = hexDigits[x&15]
	}
	return string(out)
}

func hexValue(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	}
	return -1
}

// FromHex reads strict lowercase hex: it refuses uppercase, odd lengths and,
// when n >= 0, any other number of bytes than n.
func FromHex(s string, n int) ([]byte, bool) {
	if len(s)%2 != 0 || (n >= 0 && len(s) != 2*n) {
		return nil, false
	}
	out := make([]byte, len(s)/2)
	for i := range out {
		hi, lo := hexValue(s[2*i]), hexValue(s[2*i+1])
		if hi < 0 || lo < 0 {
			return nil, false
		}
		out[i] = byte(hi<<4 | lo)
	}
	return out, true
}
