package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"grain-ventilation/internal/decision"
)

// Robustness-check statuses. A check is stable only when every one of the
// eight boundary corners keeps the ORIGINAL verdict; otherwise it is
// sensitive.
const (
	RobustnessStable    = "stable"
	RobustnessSensitive = "sensitive"
)

// BoundaryCorner is one of the eight +/- boundary combinations and the full
// unrounded decision the existing decision.Evaluate path gives for it.
// MatchesOriginal is decided by the SERVER: it records whether this corner's
// verdict equals the original assessment's verdict, so the browser only
// renders the flag and never compares/derives verdicts itself.
type BoundaryCorner struct {
	Index           int             `json:"index"` // 1..8
	TgSign          string          `json:"tg_sign"`
	TaSign          string          `json:"ta_sign"`
	RHSign          string          `json:"rh_sign"`
	Input           decision.Input  `json:"input"`
	Result          decision.Result `json:"result"`
	MatchesOriginal bool            `json:"matches_original"`
}

// RobustnessCheck is one immutable robustness verification. Assessment is
// the original assessment DTO snapshot taken at creation time, so the check
// is self-contained: it renders the original inputs even if that assessment
// is later deleted. Nothing updates a check after it is created.
type RobustnessCheck struct {
	ID           int64
	AssessmentID int64
	Assessment   json.RawMessage
	TgEps        float64
	TaEps        float64
	RhEps        float64
	Corners      []BoundaryCorner
	Verdicts     []string
	Status       string
	CreatedAt    time.Time
}

// CreateRobustnessCheck inserts one check. The corners, distinct-verdict
// set and original assessment snapshot are stored as JSON TEXT; the row is
// never modified afterwards. ID and CreatedAt are filled back into rc.
func (s *Store) CreateRobustnessCheck(ctx context.Context, rc *RobustnessCheck) error {
	corners, err := json.Marshal(rc.Corners)
	if err != nil {
		return fmt.Errorf("marshal corners: %w", err)
	}
	verdicts, err := json.Marshal(rc.Verdicts)
	if err != nil {
		return fmt.Errorf("marshal verdicts: %w", err)
	}

	now := time.Now().UTC()
	res, err := s.db.ExecContext(ctx, `
INSERT INTO robustness_checks
    (assessment_id, assessment, tg_eps, ta_eps, rh_eps, corners, verdicts, status, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rc.AssessmentID, string(rc.Assessment),
		rc.TgEps, rc.TaEps, rc.RhEps,
		string(corners), string(verdicts), rc.Status,
		now.Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("insert robustness check: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return err
	}
	rc.ID, rc.CreatedAt = id, now
	return nil
}

// GetRobustnessCheck returns one check by id, or ErrNoRows.
func (s *Store) GetRobustnessCheck(ctx context.Context, id int64) (*RobustnessCheck, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, assessment_id, assessment, tg_eps, ta_eps, rh_eps, corners, verdicts, status, created_at
FROM robustness_checks WHERE id = ?`, id)

	var rc RobustnessCheck
	var assessment, corners, verdicts, createdAt string
	err := row.Scan(
		&rc.ID, &rc.AssessmentID, &assessment,
		&rc.TgEps, &rc.TaEps, &rc.RhEps,
		&corners, &verdicts, &rc.Status, &createdAt)
	if err == sql.ErrNoRows {
		return nil, ErrNoRows
	}
	if err != nil {
		return nil, err
	}

	rc.Assessment = json.RawMessage(assessment)
	if err := json.Unmarshal([]byte(corners), &rc.Corners); err != nil {
		return nil, fmt.Errorf("read corners: %w", err)
	}
	if err := json.Unmarshal([]byte(verdicts), &rc.Verdicts); err != nil {
		return nil, fmt.Errorf("read verdicts: %w", err)
	}
	if rc.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt); err != nil {
		return nil, err
	}
	return &rc, nil
}
