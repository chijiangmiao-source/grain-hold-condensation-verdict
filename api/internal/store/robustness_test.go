package store

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"grain-ventilation/internal/decision"
)

func mustRobustnessCheck(t *testing.T, a *Assessment) *RobustnessCheck {
	t.Helper()
	in := a.Input
	eps := map[string]float64{"tg": 0.01, "ta": 0.01, "rh": 0.5}
	corners := make([]BoundaryCorner, 0, 8)
	seen := map[string]bool{}
	var verdicts []string
	idx := 0
	for _, sg := range []string{"-", "+"} {
		for _, sa := range []string{"-", "+"} {
			for _, sr := range []string{"-", "+"} {
				idx++
				c := in
				c.Tg += mapSign(sg, eps["tg"])
				c.Ta += mapSign(sa, eps["ta"])
				c.RH += mapSign(sr, eps["rh"])
				r, err := decision.Evaluate(c)
				require.NoError(t, err)
				corners = append(corners, BoundaryCorner{
					Index: idx, TgSign: sg, TaSign: sa, RHSign: sr, Input: c, Result: *r,
					MatchesOriginal: r.Verdict == a.Result.Verdict,
				})
				if !seen[r.Verdict] {
					seen[r.Verdict] = true
					verdicts = append(verdicts, r.Verdict)
				}
			}
		}
	}
	status := RobustnessStable
	if len(verdicts) > 1 || verdicts[0] != a.Result.Verdict {
		status = RobustnessSensitive
	}
	return &RobustnessCheck{
		AssessmentID: a.ID,
		Assessment:   json.RawMessage(`{"id":1}`),
		TgEps:        eps["tg"], TaEps: eps["ta"], RhEps: eps["rh"],
		Corners: corners, Verdicts: verdicts, Status: status,
	}
}

func mapSign(sign string, v float64) float64 {
	if sign == "-" {
		return -v
	}
	return v
}

func TestRobustness_CreateGetRoundTrip(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, ":memory:")
	require.NoError(t, err)
	defer st.Close()

	a := mustCreate(t, ctx, st, "V-RB", "3H", 16.36)
	rc := mustRobustnessCheck(t, a)
	require.NoError(t, st.CreateRobustnessCheck(ctx, rc))
	require.NotZero(t, rc.ID)
	require.False(t, rc.CreatedAt.IsZero())

	got, err := st.GetRobustnessCheck(ctx, rc.ID)
	require.NoError(t, err)
	assert.Equal(t, rc.ID, got.ID)
	assert.Equal(t, a.ID, got.AssessmentID)
	assert.Equal(t, 0.01, got.TgEps)
	assert.Equal(t, 0.01, got.TaEps)
	assert.Equal(t, 0.5, got.RhEps)
	assert.Equal(t, RobustnessSensitive, got.Status)
	require.Len(t, got.Corners, 8)
	assert.Equal(t, rc.Verdicts, got.Verdicts)
	assert.Equal(t, json.RawMessage(`{"id":1}`), got.Assessment)

	// Each frozen corner round-trips with its unrounded inputs/result and
	// matches a fresh decision.Evaluate of the stored inputs.
	for i, cn := range got.Corners {
		assert.Equal(t, i+1, cn.Index)
		r, err := decision.Evaluate(cn.Input)
		require.NoError(t, err)
		assert.Equal(t, r.Verdict, cn.Result.Verdict, "corner %d verdict", cn.Index)
		assert.Equal(t, r.Delta, cn.Result.Delta, "corner %d unrounded delta", cn.Index)
		assert.Equal(t, r.Td, cn.Result.Td, "corner %d unrounded Td", cn.Index)
	}

	// The fixed sign order is exactly the eight +/- combinations.
	wantSigns := []string{"---", "--+", "-+-", "-++", "+--", "+-+", "++-", "+++"}
	for i, cn := range got.Corners {
		assert.Equal(t, wantSigns[i], cn.TgSign+cn.TaSign+cn.RHSign)
	}
}

func TestRobustness_GetMissing(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, ":memory:")
	require.NoError(t, err)
	defer st.Close()

	_, err = st.GetRobustnessCheck(ctx, 42)
	assert.ErrorIs(t, err, ErrNoRows)
}

// Robustness checks live in their own table and never appear in the
// assessment list or alter predecessor chains.
func TestRobustness_ChecksStaySeparateFromAssessments(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, ":memory:")
	require.NoError(t, err)
	defer st.Close()

	a := mustCreate(t, ctx, st, "V-SEP", "3H", 25)
	rc := mustRobustnessCheck(t, a)
	require.NoError(t, st.CreateRobustnessCheck(ctx, rc))

	list, err := st.List(ctx)
	require.NoError(t, err)
	require.Len(t, list, 1, "a check is not an assessment")
	assert.Equal(t, a.ID, list[0].ID)

	// A subsequent same-hatch measurement chains to the assessment, not to
	// the check row.
	next := mustCreate(t, ctx, st, "V-SEP", "3H", 24)
	require.True(t, next.HasPrev)
	assert.Equal(t, a.ID, next.PrevID)
}
