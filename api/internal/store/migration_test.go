package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	_ "modernc.org/sqlite"
)

// A database created by the ORIGINAL schema (assessments without prev_id,
// no robustness_checks table) must migrate losslessly on startup: every
// historical row keeps its inputs, and the new robustness table becomes
// usable without touching assessments.
func TestMigrate_FromOriginalSchemaIsLossless(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "old.db")

	// Build the legacy database straight through database/sql.
	legacy, err := sql.Open("sqlite", path)
	require.NoError(t, err)
	_, err = legacy.Exec(`
CREATE TABLE assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, voyage TEXT NOT NULL, hatch TEXT NOT NULL,
    tg REAL NOT NULL, ta REAL NOT NULL, rh REAL NOT NULL,
    gamma REAL NOT NULL, td REAL NOT NULL, delta REAL NOT NULL,
    verdict TEXT NOT NULL, created_at TEXT NOT NULL
)`)
	require.NoError(t, err)
	_, err = legacy.Exec(`
INSERT INTO assessments (voyage, hatch, tg, ta, rh, gamma, td, delta, verdict, created_at)
VALUES ('V-OLD', '3H', 25, 20, 70, 0.98, 14.359, 10.641, 'allowed', '2026-09-01T00:00:00Z')`)
	require.NoError(t, err)
	require.NoError(t, legacy.Close())

	// store.Open applies every additive migration in place.
	st, err := Open(ctx, path)
	require.NoError(t, err)
	defer st.Close()

	// The historical assessment survives verbatim, prev_id now NULL (a first
	// measurement for its chain).
	got, err := st.Get(ctx, 1)
	require.NoError(t, err)
	assert.Equal(t, "V-OLD", got.Input.Voyage)
	assert.Equal(t, 25.0, got.Input.Tg)
	assert.Equal(t, "allowed", got.Result.Verdict)
	assert.False(t, got.HasPrev)

	// The new robustness table is usable against the migrated database.
	require.NoError(t, st.CreateRobustnessCheck(ctx, &RobustnessCheck{
		AssessmentID: 1,
		Assessment:   []byte(`{"id":1}`),
		TgEps:        0.5, TaEps: 0.5, RhEps: 1,
		Corners:  []BoundaryCorner{{Index: 1, Input: got.Input, Result: got.Result}},
		Verdicts: []string{"allowed"},
		Status:   RobustnessStable,
	}))
	rc, err := st.GetRobustnessCheck(ctx, 1)
	require.NoError(t, err)
	assert.Equal(t, RobustnessStable, rc.Status)

	// Reopening runs the migration idempotently (IF NOT EXISTS), still fine.
	require.NoError(t, st.Close())
	st2, err := Open(ctx, path)
	require.NoError(t, err)
	defer st2.Close()
	one, err := st2.GetRobustnessCheck(ctx, 1)
	require.NoError(t, err)
	assert.Equal(t, int64(1), one.AssessmentID)
}
