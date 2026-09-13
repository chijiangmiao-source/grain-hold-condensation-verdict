// Package store persists assessments in SQLite. The unrounded intermediate
// values (gamma, td, delta) are stored as REAL so a later audit or reload
// reproduces the verdict without re-running the formula on rounded numbers.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"grain-ventilation/internal/decision"

	_ "modernc.org/sqlite"
)

// Assessment is one persisted row plus its computed result.
type Assessment struct {
	ID        int64           `json:"id"`
	Input     decision.Input  `json:"input"`
	Result    decision.Result `json:"result"`
	CreatedAt time.Time       `json:"created_at"`
}

// Store wraps the SQLite database.
type Store struct {
	db *sql.DB
}

// ErrNoRows is returned by Get for unknown ids.
var ErrNoRows = sql.ErrNoRows

// Open opens (creating if needed) the database at path and applies the
// schema. Use ":memory:" for tests.
func Open(ctx context.Context, path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite + modernc: a single writer is plenty for this app and avoids
	// "database is locked" under the verify suite's parallel requests.
	db.SetMaxOpenConns(1)

	s := &Store{db: db}
	if err := s.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS assessments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    voyage     TEXT    NOT NULL,
    hatch      TEXT    NOT NULL,
    tg         REAL    NOT NULL,
    ta         REAL    NOT NULL,
    rh         REAL    NOT NULL,
    gamma      REAL    NOT NULL,  -- unrounded Magnus intermediate
    td         REAL    NOT NULL,  -- unrounded dew point
    delta      REAL    NOT NULL,  -- unrounded Tg - Td, basis of verdict
    verdict    TEXT    NOT NULL,
    created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assessments_created_at ON assessments(created_at DESC);
`)
	return err
}

// Close releases the database handle.
func (s *Store) Close() error { return s.db.Close() }

// Create inserts one assessment and returns its id and creation timestamp.
func (s *Store) Create(ctx context.Context, in decision.Input, r decision.Result) (*Assessment, error) {
	now := time.Now().UTC()
	res, err := s.db.ExecContext(ctx, `
INSERT INTO assessments (voyage, hatch, tg, ta, rh, gamma, td, delta, verdict, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		in.Voyage, in.Hatch, in.Tg, in.Ta, in.RH,
		r.Gamma, r.Td, r.Delta, r.Verdict, now.Format(time.RFC3339Nano))
	if err != nil {
		return nil, fmt.Errorf("insert assessment: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return &Assessment{ID: id, Input: in, Result: r, CreatedAt: now}, nil
}

// List returns all assessments, newest first.
func (s *Store) List(ctx context.Context) ([]*Assessment, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, voyage, hatch, tg, ta, rh, gamma, td, delta, verdict, created_at
FROM assessments ORDER BY id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*Assessment
	for rows.Next() {
		a, err := scanAssessment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Get returns one assessment by id, or sql.ErrNoRows.
func (s *Store) Get(ctx context.Context, id int64) (*Assessment, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, voyage, hatch, tg, ta, rh, gamma, td, delta, verdict, created_at
FROM assessments WHERE id = ?`, id)
	return scanAssessment(row)
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanAssessment(sc rowScanner) (*Assessment, error) {
	var a Assessment
	var createdAt string
	err := sc.Scan(
		&a.ID, &a.Input.Voyage, &a.Input.Hatch,
		&a.Input.Tg, &a.Input.Ta, &a.Input.RH,
		&a.Result.Gamma, &a.Result.Td, &a.Result.Delta,
		&a.Result.Verdict, &createdAt)
	if err != nil {
		return nil, err
	}
	a.Result.GammaDisplay = decision.Round2(a.Result.Gamma)
	a.Result.TdDisplay = decision.Round2(a.Result.Td)
	a.Result.DeltaDisplay = decision.Round2(a.Result.Delta)
	if a.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt); err != nil {
		return nil, err
	}
	return &a, nil
}
