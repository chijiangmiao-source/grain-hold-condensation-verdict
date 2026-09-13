package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"grain-ventilation/internal/decision"
)

func TestStore_CreateGetList(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, ":memory:")
	require.NoError(t, err)
	defer st.Close()

	in := decision.Input{Voyage: "VOY-7", Hatch: "2P", Tg: 25, Ta: 20, RH: 70}
	r, err := decision.Evaluate(in)
	require.NoError(t, err)

	created, err := st.Create(ctx, in, *r)
	require.NoError(t, err)
	assert.Equal(t, int64(1), created.ID)

	got, err := st.Get(ctx, created.ID)
	require.NoError(t, err)
	assert.Equal(t, in, got.Input)
	// Unrounded intermediates survive a round-trip.
	assert.Equal(t, r.Gamma, got.Result.Gamma)
	assert.Equal(t, r.Td, got.Result.Td)
	assert.Equal(t, r.Delta, got.Result.Delta)
	assert.Equal(t, r.Verdict, got.Result.Verdict)
	// Display values are re-derived and rounded.
	assert.Equal(t, 14.36, got.Result.TdDisplay)

	list, err := st.List(ctx)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, created.ID, list[0].ID)
}

func TestStore_GetMissing(t *testing.T) {
	st, err := Open(context.Background(), ":memory:")
	require.NoError(t, err)
	defer st.Close()

	_, err = st.Get(context.Background(), 999)
	assert.ErrorIs(t, err, ErrNoRows)
}
