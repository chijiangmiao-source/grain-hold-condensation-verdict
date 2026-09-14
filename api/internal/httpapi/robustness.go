package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"grain-ventilation/internal/decision"
	"grain-ventilation/internal/store"
)

// robustnessToleranceFields is the only set of keys a robustness-check
// request may carry: the three SYMMETRIC error magnitudes. The original
// assessment inputs are taken from the persisted assessment named by the
// path, never from the request body.
var robustnessToleranceFields = map[string]bool{
	"tg_eps": true, "ta_eps": true, "rh_eps": true,
}

// createRobustnessCheck handles
// POST /api/assessments/:id/robustness-checks.
//
// The original assessment is loaded from SQLite; the browser only supplies
// three positive symmetric error magnitudes. The server generates the eight
// +/- boundary corners and runs each through the SAME unrounded
// decision.Evaluate path as a normal submission, then freezes the original
// assessment snapshot, error parameters, every boundary result and the
// distinct-verdict set into one immutable row. Nothing is computed in the
// browser and a rejected request never creates a record.
func createRobustnessCheck(st *store.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := strconv.ParseInt(c.Param("id"), 10, 64)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "记录不存在"})
			return
		}
		a, err := st.Get(c.Request.Context(), id)
		if errors.Is(err, store.ErrNoRows) {
			// Field-level feedback like a 422: the origin assessment the
			// chief officer started from no longer exists, so no check can be
			// built and nothing is persisted.
			c.JSON(http.StatusUnprocessableEntity, gin.H{
				"error": "稳健性核查输入校验失败，未生成任何记录",
				"fields": []decision.FieldError{{
					Field:   "assessment",
					Code:    "not_found",
					Message: fmt.Sprintf("原评估 #%d 不存在，无法发起稳健性核查", id),
				}},
			})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		raw, ok := readObjectBody(c)
		if !ok {
			return
		}
		if field, bad := unknownField(raw, robustnessToleranceFields); bad {
			c.JSON(http.StatusBadRequest, gin.H{"error": "出现未知字段: " + field})
			return
		}

		eps, bad := parseRobustnessTolerances(raw, a.Input)
		if len(bad) > 0 {
			c.JSON(http.StatusUnprocessableEntity, gin.H{
				"error":  "稳健性核查输入校验失败，未生成任何记录",
				"fields": bad,
			})
			return
		}

		corners, verdicts, status, err := buildBoundaryCorners(a.Input, a.Result.Verdict, eps)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		// Freeze the full original assessment DTO so a check stays
		// self-contained and reproducible even if that row later disappears.
		snapshot, err := json.Marshal(toDTO(a))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		rc := &store.RobustnessCheck{
			AssessmentID: id,
			Assessment:   snapshot,
			TgEps:        eps.tg,
			TaEps:        eps.ta,
			RhEps:        eps.rh,
			Corners:      corners,
			Verdicts:     verdicts,
			Status:       status,
		}
		if err := st.CreateRobustnessCheck(c.Request.Context(), rc); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存失败: " + err.Error()})
			return
		}
		c.JSON(http.StatusCreated, robustnessCheckDTO(rc))
	}
}

// tolerances holds the three parsed symmetric error magnitudes.
type tolerances struct {
	tg, ta, rh float64
}

// toleranceSpec describes one error-magnitude field for parsing and the
// boundary-fit check.
type toleranceSpec struct {
	field string
	label string
	base  float64 // the original assessment's value (the centre)
	lo    float64 // legal interval of the measured quantity
	hi    float64
}

// parseRobustnessTolerances decodes the three error magnitudes with the same
// required/wrong_type/not_finite semantics as an assessment field, then adds
// the robustness-specific rules: each magnitude must be a strictly positive
// finite number, and base +/- magnitude must stay inside the quantity's
// legal range. Every offending field is reported at once; the caller rejects
// the whole request (422) without persisting anything.
func parseRobustnessTolerances(raw map[string]json.RawMessage, in decision.Input) (tolerances, []decision.FieldError) {
	specs := []toleranceSpec{
		{"tg_eps", "粮温 Tg 的对称误差幅度", in.Tg, decision.MinTempC, decision.MaxTempC},
		{"ta_eps", "舱内气温 Ta 的对称误差幅度", in.Ta, decision.MinTempC, decision.MaxTempC},
		{"rh_eps", "相对湿度 RH 的对称误差幅度", in.RH, decision.MinRH, decision.MaxRH},
	}
	values := map[string]float64{}
	var bad []decision.FieldError

	for _, s := range specs {
		b, present := raw[s.field]
		if !present || string(b) == "null" {
			bad = append(bad, decision.FieldError{Field: s.field, Code: "required", Message: s.label + "必须填写"})
			continue
		}
		var v float64
		if err := json.Unmarshal(b, &v); err != nil {
			var ute *json.UnmarshalTypeError
			if errors.As(err, &ute) && strings.HasPrefix(ute.Value, "number") {
				// 1e999 overflows float64 to +Inf during decode.
				bad = append(bad, decision.FieldError{Field: s.field, Code: "not_finite", Message: s.label + "必须为有限数值"})
			} else {
				bad = append(bad, decision.FieldError{Field: s.field, Code: "wrong_type", Message: s.label + "必须是数值"})
			}
			continue
		}
		if !isFinite(v) {
			bad = append(bad, decision.FieldError{Field: s.field, Code: "not_finite", Message: s.label + "必须为有限数值"})
			continue
		}
		if v <= 0 {
			bad = append(bad, decision.FieldError{Field: s.field, Code: "not_positive", Message: s.label + "必须为正数（大于 0）"})
			continue
		}
		if s.base-v < s.lo || s.base+v > s.hi {
			bad = append(bad, decision.FieldError{Field: s.field, Code: "out_of_range", Message: fmt.Sprintf(
				"%s %s 会使边界值越出 %.1f 至 %.1f 的合法区间（原评估值 %s，对称区间为 %s ~ %s）",
				s.label, num(v), s.lo, s.hi, num(s.base), num(s.base-v), num(s.base+v))})
			continue
		}
		values[s.field] = v
	}

	return tolerances{tg: values["tg_eps"], ta: values["ta_eps"], rh: values["rh_eps"]}, bad
}

// buildBoundaryCorners generates the eight corners of the symmetric error
// box (tg/ta/rh each at -eps or +eps) in a fixed order, and evaluates each
// through the SAME unrounded decision.Evaluate used for every assessment —
// no second formula implementation, no rounding before the verdict.
//
// The distinct verdict set is collected in deterministic first-encounter
// order. The check is "stable" only when ALL eight corners keep the original
// verdict; a single differing corner makes it "sensitive" (that includes the
// extreme case where the set has one member but it is not the original
// verdict).
func buildBoundaryCorners(in decision.Input, originalVerdict string, eps tolerances) ([]store.BoundaryCorner, []string, string, error) {
	corners := make([]store.BoundaryCorner, 0, 8)
	seen := map[string]bool{}
	var verdicts []string
	allMatch := true

	idx := 0
	for _, tgSign := range []string{"-", "+"} {
		for _, taSign := range []string{"-", "+"} {
			for _, rhSign := range []string{"-", "+"} {
				idx++
				cornerInput := in
				cornerInput.Tg = in.Tg + signedEps(tgSign, eps.tg)
				cornerInput.Ta = in.Ta + signedEps(taSign, eps.ta)
				cornerInput.RH = in.RH + signedEps(rhSign, eps.rh)

				res, err := decision.Evaluate(cornerInput)
				if err != nil {
					return nil, nil, "", fmt.Errorf("evaluate boundary corner %d: %w", idx, err)
				}
				matches := res.Verdict == originalVerdict
				corners = append(corners, store.BoundaryCorner{
					Index:           idx,
					TgSign:          tgSign,
					TaSign:          taSign,
					RHSign:          rhSign,
					Input:           cornerInput,
					Result:          *res,
					MatchesOriginal: matches,
				})
				if !seen[res.Verdict] {
					seen[res.Verdict] = true
					verdicts = append(verdicts, res.Verdict)
				}
				if !matches {
					allMatch = false
				}
			}
		}
	}

	status := store.RobustnessSensitive
	if allMatch {
		status = store.RobustnessStable
	}
	return corners, verdicts, status, nil
}

func signedEps(sign string, eps float64) float64 {
	if sign == "-" {
		return -eps
	}
	return eps
}

// isFinite reports whether v is neither NaN nor an infinity. JSON decoding
// can normally not produce these except via an overflowing literal such as
// 1e999, which fails to decode into float64; this also covers any NaN
// payload that reaches here.
func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

// getRobustnessCheck serves the independent check detail by check id. A
// missing check is 404; the page still keeps the way back to the history
// area (and hence the original assessment entry).
func getRobustnessCheck(st *store.Store) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := strconv.ParseInt(c.Param("id"), 10, 64)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "稳健性核查记录不存在"})
			return
		}
		rc, err := st.GetRobustnessCheck(c.Request.Context(), id)
		if errors.Is(err, store.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "稳健性核查记录不存在"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, robustnessCheckDTO(rc))
	}
}

// robustnessCheckDTO renders one immutable check. The assessment snapshot is
// emitted verbatim as frozen at creation time (never recomputed on read),
// and each boundary corner carries the full unrounded result the server
// evaluated. The browser only renders these fields.
func robustnessCheckDTO(rc *store.RobustnessCheck) gin.H {
	corners := make([]gin.H, 0, len(rc.Corners))
	for _, cn := range rc.Corners {
		r := cn.Result
		corners = append(corners, gin.H{
			"index":            cn.Index,
			"tg_sign":          cn.TgSign,
			"ta_sign":          cn.TaSign,
			"rh_sign":          cn.RHSign,
			"tg":               cn.Input.Tg,
			"ta":               cn.Input.Ta,
			"rh":               cn.Input.RH,
			"gamma":            r.Gamma,
			"td":               r.Td,
			"delta":            r.Delta,
			"gamma_display":    r.GammaDisplay,
			"td_display":       r.TdDisplay,
			"delta_display":    r.DeltaDisplay,
			"verdict":          r.Verdict,
			"matches_original": cn.MatchesOriginal,
		})
	}
	return gin.H{
		"id":            rc.ID,
		"assessment_id": rc.AssessmentID,
		"assessment":    rc.Assessment,
		"tolerances": gin.H{
			"tg": rc.TgEps, "ta": rc.TaEps, "rh": rc.RhEps,
		},
		"corners":    corners,
		"verdicts":   rc.Verdicts,
		"status":     rc.Status,
		"created_at": rc.CreatedAt.Format(time.RFC3339Nano),
	}
}
