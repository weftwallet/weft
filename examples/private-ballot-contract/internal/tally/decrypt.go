package tally

import (
	"fmt"
	"sort"

	r255 "github.com/gtank/ristretto255"
)

// ShareEntry is one option's decryption share, as lowercase hex.
type ShareEntry struct {
	D string `json:"d"`
	C string `json:"c"`
	Z string `json:"z"`
}

// DecryptionShare is a PostDecryptionShare argument.
type DecryptionShare struct {
	Shares []ShareEntry `json:"shares"`
}

var shareSchema = sObj(f("shares", sList(sObj(f("d", sStr), f("c", sStr), f("z", sStr)))))

// CheckDecryptionShare checks PostDecryptionShare from the trustee at index:
// for each total, D_ij = s_i·A_j with
// c = Hs("share", [ctx, id_i, j, A_j, D_ij, S_i, z·G - c·S_i, z·A_j - c·D_ij]).
func CheckDecryptionShare(p *Prepared, totals []Ciphertext, index int, text string) (*DecryptionShare, error) {
	const t = thingDecShare
	x, err := parseStrict(t, text, shareSchema)
	if err != nil {
		return nil, err
	}
	entries := objects(x["shares"])
	L := len(p.Options)
	if len(entries) != L {
		return nil, errShareCount(len(entries), L)
	}
	type decoded struct {
		d    *r255.Element
		c, z *r255.Scalar
	}
	ds := make([]decoded, L)
	out := &DecryptionShare{}
	for j, e := range entries {
		var err error
		if ds[j].d, _, err = pointAt(t, fmt.Sprintf("shares[%d].d", j), e["d"].(string)); err != nil {
			return nil, err
		}
		if ds[j].c, _, err = scalarAt(t, fmt.Sprintf("shares[%d].c", j), e["c"].(string)); err != nil {
			return nil, err
		}
		if ds[j].z, _, err = scalarAt(t, fmt.Sprintf("shares[%d].z", j), e["z"].(string)); err != nil {
			return nil, err
		}
		out.Shares = append(out.Shares, ShareEntry{e["d"].(string), e["c"].(string), e["z"].(string)})
	}
	S := p.S[index]
	for j, sh := range ds {
		A, _, err := pointAt(thingDecShare, "total", totals[j].A)
		if err != nil {
			return nil, fmt.Errorf("tally: total %d doesn't decode", j)
		}
		T1 := lin(sh.z, generator(), sh.c, S)
		T2 := lin(sh.z, A, sh.c, sh.d)
		if Hs(LabelShare, p.Ctx, p.IDs[index], j, A.Bytes(), sh.d.Bytes(), S.Bytes(), T1.Bytes(), T2.Bytes()).Equal(sh.c) != 1 {
			return nil, errShare(j, p.Trustees[index])
		}
	}
	return out, nil
}

// Lagrange returns lambda_i = product over m in ids, m != i, of id_m / (id_m - id_i), mod l.
func Lagrange(i int, ids []int) *r255.Scalar {
	num, den := scalarOf(1), scalarOf(1)
	xi := scalarOf(uint64(i))
	for _, m := range ids {
		if m == i {
			continue
		}
		xm := scalarOf(uint64(m))
		num.Multiply(num, xm)
		den.Multiply(den, r255.NewScalar().Subtract(xm, xi))
	}
	return num.Multiply(num, r255.NewScalar().Invert(den))
}

// PostedShare is a checked decryption share and the 0-based index of the trustee that posted it.
type PostedShare struct {
	Index int             `json:"index"`
	Share DecryptionShare `json:"share"`
}

// TallyResult is what PublishTally writes, with the values it computed on the way.
type TallyResult struct {
	Quorum  []int    `json:"quorum"`
	Lambdas []string `json:"lambdas"`
	M       []string `json:"M"`
	Counts  []int    `json:"counts"`
	Total   int      `json:"total"`
}

// RecoverTally combines the shares of the k trustees with the lowest
// identifiers and finds each count t_j in 0 to N by stepping from 0. The
// shares must already have been checked with CheckDecryptionShare.
func RecoverTally(p *Prepared, totals []Ciphertext, ballots int, posted []PostedShare) (*TallyResult, error) {
	k := p.Threshold
	if len(posted) < k {
		return nil, errTooFewShares(k, len(posted))
	}
	q := append([]PostedShare{}, posted...)
	sort.Slice(q, func(a, b int) bool { return q[a].Index < q[b].Index })
	q = q[:k]
	ids := make([]int, k)
	for n, s := range q {
		ids[n] = s.Index + 1
	}
	res := &TallyResult{}
	lambdas := make([]*r255.Scalar, k)
	for n, id := range ids {
		lambdas[n] = Lagrange(id, ids)
		res.Quorum = append(res.Quorum, q[n].Index)
		res.Lambdas = append(res.Lambdas, scalarHex(lambdas[n]))
	}
	G := generator()
	sum := 0
	var tooLarge bool
	for j, tot := range totals {
		M, _, err := pointAt(thingDecShare, "total", tot.B)
		if err != nil {
			return nil, fmt.Errorf("tally: total %d doesn't decode", j)
		}
		for n, s := range q {
			D, _, err := pointAt(thingDecShare, "d", s.Share.Shares[j].D)
			if err != nil {
				return nil, fmt.Errorf("tally: a share doesn't decode")
			}
			M = r255.NewElement().Subtract(M, mul(lambdas[n], D))
		}
		res.M = append(res.M, pointHex(M))
		found := -1
		cur := identity()
		for t := 0; t <= ballots; t++ {
			if cur.Equal(M) == 1 {
				found = t
				break
			}
			cur.Add(cur, G)
		}
		if found < 0 {
			tooLarge = true
			break
		}
		res.Counts = append(res.Counts, found)
		sum += found
	}
	if tooLarge {
		return nil, errCountTooLarge()
	}
	if sum != ballots {
		return nil, errCountsSum(sum, ballots)
	}
	res.Total = sum
	return res, nil
}
