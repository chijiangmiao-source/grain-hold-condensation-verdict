package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"grain-ventilation/internal/decision"
)

func checkPath(id int64) string {
	return "/api/assessments/" + strconv.FormatInt(id, 10) + "/robustness-checks"
}

func submitForCheck(t *testing.T, r http.Handler, voyage, hatch string, tg, ta, rh float64) map[string]any {
	t.Helper()
	w, got := postMap(t, r, map[string]any{
		"voyage": voyage, "hatch": hatch, "tg": tg, "ta": ta, "rh": rh,
	})
	require.Equal(t, http.StatusCreated, w, got)
	return got
}

func postCheck(t *testing.T, r http.Handler, id int64, body map[string]any) (int, map[string]any) {
	t.Helper()
	w := do(t, r, http.MethodPost, checkPath(id), body)
	var got map[string]any
	if w.Body.Len() > 0 {
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	}
	return w.Code, got
}

func postCheckRaw(t *testing.T, r http.Handler, id int64, raw string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, checkPath(id), bytes.NewBufferString(raw))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var got map[string]any
	if w.Body.Len() > 0 {
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	}
	return w.Code, got
}

func getCheck(t *testing.T, r http.Handler, id int64) (int, map[string]any) {
	t.Helper()
	return getMap(t, r, "/api/robustness-checks/"+strconv.FormatInt(id, 10))
}

// A stable sample far from every verdict boundary: 25/20/70 with the
// instruments' symmetric error magnitudes keeps all eight corners "allowed",
// so the verdict set is exactly the original one and the check is stable.
func TestRobustness_StableSampleAllCornersKeepVerdict(t *testing.T) {
	r := setup(t)
	a := submitForCheck(t, r, "V-RS", "3H", 25, 20, 70)

	w, got := postCheck(t, r, int64(a["id"].(float64)),
		map[string]any{"tg_eps": 0.5, "ta_eps": 0.5, "rh_eps": 1.0})
	require.Equal(t, http.StatusCreated, w, got)

	assert.Equal(t, "stable", got["status"])
	assert.Equal(t, []any{"allowed"}, got["verdicts"])
	assert.Equal(t, a["id"], got["assessment_id"])
	tol := got["tolerances"].(map[string]any)
	assert.Equal(t, 0.5, tol["tg"])
	assert.Equal(t, 0.5, tol["ta"])
	assert.Equal(t, 1.0, tol["rh"])
	assert.NotEmpty(t, got["created_at"])

	// The original assessment is frozen verbatim inside the check.
	snap := got["assessment"].(map[string]any)
	assert.Equal(t, a["id"], snap["id"])
	assert.Equal(t, "allowed", snap["verdict"])
	assert.Equal(t, 25.0, snap["tg"])

	corners := got["corners"].([]any)
	require.Len(t, corners, 8)
	wantSigns := []string{"---", "--+", "-+-", "-++", "+--", "+-+", "++-", "+++"}
	for i, c0 := range corners {
		c := c0.(map[string]any)
		assert.Equal(t, float64(i+1), c["index"])
		assert.Equal(t, wantSigns[i], c["tg_sign"].(string)+c["ta_sign"].(string)+c["rh_sign"].(string))
		assert.Equal(t, "allowed", c["verdict"])
		// The server itself flags every corner as matching the original verdict.
		assert.Equal(t, true, c["matches_original"], "corner %d matches_original", c["index"])

		// Every served number equals an independent decision.Evaluate of the
		// served corner inputs: the server ran the existing unrounded path,
		// and nothing on the page can fabricate these.
		in := decision.Input{
			Voyage: "V-RS", Hatch: "3H",
			Tg: c["tg"].(float64), Ta: c["ta"].(float64), RH: c["rh"].(float64),
		}
		res, err := decision.Evaluate(in)
		require.NoError(t, err)
		assert.Equal(t, res.Gamma, c["gamma"])
		assert.Equal(t, res.Td, c["td"])
		assert.Equal(t, res.Delta, c["delta"])
		assert.Equal(t, res.GammaDisplay, c["gamma_display"])
		assert.Equal(t, res.TdDisplay, c["td_display"])
		assert.Equal(t, res.DeltaDisplay, c["delta_display"])
	}

	// Corner 1 is tg-/ta-/rh-: centre minus the magnitudes, in that order.
	first := corners[0].(map[string]any)
	assert.Equal(t, 24.5, first["tg"])
	assert.Equal(t, 19.5, first["ta"])
	assert.Equal(t, 69.0, first["rh"])

	// Reload by check id returns the identical immutable record.
	w2, reloaded := getCheck(t, r, int64(got["id"].(float64)))
	require.Equal(t, http.StatusOK, w2, reloaded)
	assert.Equal(t, got["status"], reloaded["status"])
	assert.Equal(t, got["corners"], reloaded["corners"])
	assert.Equal(t, got["verdicts"], reloaded["verdicts"])
	assert.Equal(t, got["assessment_id"], reloaded["assessment_id"])
	assert.Equal(t, got["tolerances"], reloaded["tolerances"])
}

// A sensitive sample: unrounded Δ ≈ 2.0008 says "allowed", but within the
// instruments' symmetric error box four corners already retest. The verdict
// set then contains more than the original verdict, so the check is
// sensitive even though the displayed Δ rounds to 2.00 on both sides.
func TestRobustness_SensitiveSampleSpansTwoVerdicts(t *testing.T) {
	r := setup(t)
	a := submitForCheck(t, r, "V-RX", "3H", 16.36, 20, 70)
	require.Equal(t, "allowed", a["verdict"])

	w, got := postCheck(t, r, int64(a["id"].(float64)),
		map[string]any{"tg_eps": 0.01, "ta_eps": 0.01, "rh_eps": 0.5})
	require.Equal(t, http.StatusCreated, w, got)

	assert.Equal(t, "sensitive", got["status"])
	// Deterministic first-encounter order: corner 1 (---) is still allowed.
	assert.Equal(t, []any{"allowed", "retest"}, got["verdicts"])

	var retest, allowed int
	for _, c0 := range got["corners"].([]any) {
		c := c0.(map[string]any)
		// The server-provided flag, not any client-side string comparison.
		assert.Equal(t, c["verdict"] == "allowed", c["matches_original"],
			"corner %v matches_original follows its server verdict", c["index"])
		// The exact four humid (RH+) corners are the ones that cross Δ = 2.
		if c["rh_sign"] == "+" {
			assert.Equal(t, "retest", c["verdict"], "corner %v", c["index"])
			assert.Equal(t, false, c["matches_original"])
			retest++
		} else {
			assert.Equal(t, "allowed", c["verdict"], "corner %v", c["index"])
			assert.Equal(t, true, c["matches_original"])
			allowed++
		}
	}
	assert.Equal(t, 4, allowed)
	assert.Equal(t, 4, retest)

	// Refresh consistency: the verdict set survives a reload unchanged.
	_, reloaded := getCheck(t, r, int64(got["id"].(float64)))
	assert.Equal(t, []any{"allowed", "retest"}, reloaded["verdicts"])
	assert.Equal(t, "sensitive", reloaded["status"])
}

// The negative boundary side: unrounded Δ ≈ -2.0022 says "denied" while
// drier corners retest. The set starts with the first corner's retest.
func TestRobustness_SensitiveSampleBelowNegativeBoundary(t *testing.T) {
	r := setup(t)
	a := submitForCheck(t, r, "V-RN", "3H", 12.357, 20, 70)
	require.Equal(t, "denied", a["verdict"])

	w, got := postCheck(t, r, int64(a["id"].(float64)),
		map[string]any{"tg_eps": 0.01, "ta_eps": 0.01, "rh_eps": 0.5})
	require.Equal(t, http.StatusCreated, w, got)
	assert.Equal(t, "sensitive", got["status"])
	assert.Equal(t, []any{"retest", "denied"}, got["verdicts"])
}

// A missing origin assessment is a 422 with explicit field-level feedback,
// and no check row is created.
func TestRobustness_MissingAssessmentIs422FieldFeedbackAndNoRecord(t *testing.T) {
	r := setup(t)
	w, got := postCheck(t, r, 9999, map[string]any{"tg_eps": 0.5, "ta_eps": 0.5, "rh_eps": 1})
	require.Equal(t, http.StatusUnprocessableEntity, w, got)
	assert.Contains(t, got["error"], "未生成任何记录")
	fields := got["fields"].([]any)
	require.Len(t, fields, 1)
	f := fields[0].(map[string]any)
	assert.Equal(t, "assessment", f["field"])
	assert.Equal(t, "not_found", f["code"])
	assert.Contains(t, f["message"], "#9999")

	// Nothing was persisted: the first check id is still missing.
	wg, _ := getCheck(t, r, 1)
	assert.Equal(t, http.StatusNotFound, wg)

	// A non-numeric assessment id is a 404 rather than a parse crash.
	wbad := do(t, r, http.MethodPost, "/api/assessments/notanid/robustness-checks",
		map[string]any{"tg_eps": 0.5, "ta_eps": 0.5, "rh_eps": 1})
	assert.Equal(t, http.StatusNotFound, wbad.Code)
}

// Non-finite, non-positive or range-overflowing magnitudes are 422 field
// errors and never create a record; multiple offending fields are reported
// together.
func TestRobustness_InvalidTolerancesAre422AndNotPersisted(t *testing.T) {
	r := setup(t)
	a := submitForCheck(t, r, "V-RI", "3H", 25, 20, 70)
	id := int64(a["id"].(float64))

	expectFields := func(body map[string]any, want map[string]string) {
		t.Helper()
		w, got := postCheck(t, r, id, body)
		require.Equal(t, http.StatusUnprocessableEntity, w, got)
		gotCodes := map[string]string{}
		for _, f0 := range got["fields"].([]any) {
			f := f0.(map[string]any)
			gotCodes[f["field"].(string)] = f["code"].(string)
			assert.NotEmpty(t, f["message"])
		}
		assert.Equal(t, want, gotCodes)
	}

	expectFields(
		map[string]any{"ta_eps": 0.5, "rh_eps": 1.0},
		map[string]string{"tg_eps": "required"})
	expectFields(
		map[string]any{"tg_eps": 0, "ta_eps": 0, "rh_eps": 0},
		map[string]string{"tg_eps": "not_positive", "ta_eps": "not_positive", "rh_eps": "not_positive"})
	expectFields(
		map[string]any{"tg_eps": -1, "ta_eps": 0.5, "rh_eps": 1},
		map[string]string{"tg_eps": "not_positive"})
	expectFields(
		map[string]any{"tg_eps": "0.5", "ta_eps": 0.5, "rh_eps": 1},
		map[string]string{"tg_eps": "wrong_type"})
	// tg 25 + 40 = 65 > 60 leaves the legal temperature interval.
	expectFields(
		map[string]any{"tg_eps": 40, "ta_eps": 0.5, "rh_eps": 1},
		map[string]string{"tg_eps": "out_of_range"})
	// rh 70 - 70 = 0 < 1 leaves the legal humidity interval.
	expectFields(
		map[string]any{"tg_eps": 0.5, "ta_eps": 0.5, "rh_eps": 70},
		map[string]string{"rh_eps": "out_of_range"})
	// All three bad at once: reported together, no record.
	expectFields(
		map[string]any{"tg_eps": -1, "ta_eps": 0, "rh_eps": 999},
		map[string]string{
			"tg_eps": "not_positive",
			"ta_eps": "not_positive",
			"rh_eps": "out_of_range",
		})

	// Non-finite JSON literal 1e999 -> not_finite on that field.
	code, got := postCheckRaw(t, r, id, `{"tg_eps":1e999,"ta_eps":0.5,"rh_eps":1}`)
	require.Equal(t, http.StatusUnprocessableEntity, code, got)
	require.Len(t, got["fields"].([]any), 1)
	assert.Equal(t, "not_finite", got["fields"].([]any)[0].(map[string]any)["code"])

	// None of the rejected requests above persisted a check.
	wg, _ := getCheck(t, r, 1)
	assert.Equal(t, http.StatusNotFound, wg)
}

// A magnitude that lands the boundary EXACTLY on a legal interval endpoint
// is still acceptable (closed interval): tg/ta 20 ± 40 spans -20..60 exactly.
func TestRobustness_BoundaryExactlyAtLegalLimitIsAccepted(t *testing.T) {
	r := setup(t)
	a := submitForCheck(t, r, "V-RE", "3H", 20, 20, 50)

	w, got := postCheck(t, r, int64(a["id"].(float64)),
		map[string]any{"tg_eps": 40, "ta_eps": 40, "rh_eps": 49})
	require.Equal(t, http.StatusCreated, w, got)

	corners := got["corners"].([]any)
	// --- corner reaches tg=-20, ta=-20, rh=1: all legal, evaluated normally.
	first := corners[0].(map[string]any)
	assert.Equal(t, -20.0, first["tg"])
	assert.Equal(t, -20.0, first["ta"])
	assert.Equal(t, 1.0, first["rh"])
	// +++ corner reaches tg=60, ta=60, rh=99.
	last := corners[7].(map[string]any)
	assert.Equal(t, 60.0, last["tg"])
	assert.Equal(t, 60.0, last["ta"])
	assert.Equal(t, 99.0, last["rh"])
}

// Structural document errors stay 400 (request-format errors), not 422, and
// never persist a check.
func TestRobustness_MalformedBodiesAre400(t *testing.T) {
	r := setup(t)
	a := submitForCheck(t, r, "V-RM", "3H", 25, 20, 70)
	id := int64(a["id"].(float64))

	must400 := func(raw, hint string) {
		t.Helper()
		code, got := postCheckRaw(t, r, id, raw)
		require.Equalf(t, http.StatusBadRequest, code, "%s -> %d %v", hint, code, got)
		assert.NotContains(t, got, "fields")
	}
	must400(`null`, "top-level null")
	must400(`[]`, "top-level array")
	must400(`{"tg_eps":0.5,"ta_eps":0.5,"rh_eps":1,"x":1}`, "unknown field")
	must400(`{"tg_eps":0.5,"tg_eps":0.6,"ta_eps":0.5,"rh_eps":1}`, "duplicate field")
	must400(`{"tg_eps":0.5,"ta_eps":0.5,"rh_eps":1} GARBAGE`, "trailing junk")

	wg, _ := getCheck(t, r, 1)
	assert.Equal(t, http.StatusNotFound, wg, "malformed requests persist nothing")

	// An otherwise-valid empty object follows the SAME rule as a single
	// assessment submission: missing fields are per-field 422s, not a 400.
	we, empty := postCheckRaw(t, r, id, `{}`)
	require.Equal(t, http.StatusUnprocessableEntity, we, empty)
	require.Len(t, empty["fields"].([]any), 3)
	for _, f0 := range empty["fields"].([]any) {
		assert.Equal(t, "required", f0.(map[string]any)["code"])
	}
}

func TestRobustness_GetUnknownCheckIs404(t *testing.T) {
	r := setup(t)
	w, got := getCheck(t, r, 12345)
	assert.Equal(t, http.StatusNotFound, w)
	assert.Contains(t, got["error"], "稳健性核查")
}

// Creating a check mutates nothing in the assessments table: the list is
// unchanged, predecessor chains still work, and the existing assessment DTO
// shapes keep their exact fields.
func TestRobustness_DoesNotAffectExistingEndpoints(t *testing.T) {
	r := setup(t)
	first := submitForCheck(t, r, "V-RC", "3H", 25, 20, 70)
	_, check := postCheck(t, r, int64(first["id"].(float64)),
		map[string]any{"tg_eps": 0.5, "ta_eps": 0.5, "rh_eps": 1})
	require.Equal(t, "stable", check["status"])

	// The assessments list still contains exactly the one assessment and no
	// robustness fields leak into it.
	wl, list := getMap(t, r, "/api/assessments")
	require.Equal(t, http.StatusOK, wl)
	items := list["items"].([]any)
	require.Len(t, items, 1)
	row := items[0].(map[string]any)
	assert.Equal(t, first["id"], row["id"])
	assert.NotContains(t, row, "corners")
	assert.NotContains(t, row, "tolerances")

	// A repeat measurement still chains normally (check rows are invisible).
	second := submitForCheck(t, r, "V-RC", "3H", 24, 20, 70)
	wd, detail := getMap(t, r, "/api/assessments/"+
		strconv.FormatFloat(second["id"].(float64), 'f', 0, 64))
	require.Equal(t, http.StatusOK, wd)
	cmp := detail["comparison"].(map[string]any)
	assert.Equal(t, true, cmp["available"])
	assert.Equal(t, first["id"], cmp["previous"].(map[string]any)["id"])
}
