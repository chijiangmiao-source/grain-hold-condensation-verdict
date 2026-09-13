package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"grain-ventilation/internal/decision"
	"grain-ventilation/internal/store"
)

func setup(t *testing.T) *gin.Engine {
	t.Helper()
	st, err := store.Open(context.Background(), ":memory:")
	require.NoError(t, err)
	t.Cleanup(func() { st.Close() })
	return NewRouter(st)
}

func do(t *testing.T, r http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		require.NoError(t, json.NewEncoder(&buf).Encode(body))
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func doRaw(t *testing.T, r http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/assessments", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func validBody() map[string]any {
	return map[string]any{"voyage": "V-100", "hatch": "4H", "tg": 25.0, "ta": 20.0, "rh": 70.0}
}

func TestCreate_SuccessAndFormula(t *testing.T) {
	r := setup(t)
	w := do(t, r, http.MethodPost, "/api/assessments", validBody())
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	assert.Equal(t, "allowed", created["verdict"])
	assert.Equal(t, 14.36, created["td_display"])
	assert.Equal(t, 10.64, created["delta_display"])

	formula := created["formula"].(map[string]any)
	for _, key := range []string{"gamma_line", "td_line", "delta_line", "rule_line"} {
		assert.NotEmpty(t, formula[key])
	}
	assert.Contains(t, formula["delta_line"], "25 −")
	// Unrounded values are present at a different precision than display.
	assert.NotEqual(t, created["delta"], created["delta_display"])
}

// A 422 of any flavour must never produce a row.
func TestCreate_InvalidLeavesNoRecord(t *testing.T) {
	r := setup(t)

	bodies := []map[string]any{
		{"voyage": "v", "hatch": "h", "tg": 60.5, "ta": 20, "rh": 70}, // range
		{"voyage": "v", "hatch": "h", "tg": 20, "ta": 20, "rh": 0},    // RH below 1
		{"voyage": "v", "hatch": "h", "tg": -21, "ta": 99, "rh": 70},  // two bad fields
		{"voyage": "", "hatch": "h", "tg": 20, "ta": 20, "rh": 70},    // empty voyage
	}
	for _, b := range bodies {
		w := do(t, r, http.MethodPost, "/api/assessments", b)
		require.Equal(t, http.StatusUnprocessableEntity, w.Code, w.Body.String())
		var resp map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
		require.NotEmpty(t, resp["fields"])
	}

	// Raw non-finite JSON literals are also 422 (not 400): the value
	// 1e999 overflows float64 to +Inf during decode.
	w := doRaw(t, r, `{"voyage":"v","hatch":"h","tg":1e999,"ta":20,"rh":70}`)
	require.Equal(t, http.StatusUnprocessableEntity, w.Code, w.Body.String())
	var resp map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	fields := resp["fields"].([]any)
	require.Len(t, fields, 1)
	assert.Equal(t, "tg", fields[0].(map[string]any)["field"])

	w = do(t, r, http.MethodGet, "/api/assessments", nil)
	require.Equal(t, http.StatusOK, w.Code)
	var list map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &list))
	assert.Empty(t, list["items"], "no record may be persisted on 422")
}

// The two critical endpoints delta = +/-2.00 must both decide "retest"
// through the real HTTP + JSON + SQLite stack. Bisection on Tg locates the
// exact float64 verdict transition: the largest Tg still retesting and the
// next float64 (already allowing/denying). The retest side must display
// exactly +/-2.00.
func TestCreate_BandEndpointsRetest(t *testing.T) {
	r := setup(t)

	w := do(t, r, http.MethodPost, "/api/assessments", validBody())
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	var first map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &first))
	td := first["td"].(float64)

	post := func(tg float64) map[string]any {
		body := validBody()
		body["tg"] = tg
		w := do(t, r, http.MethodPost, "/api/assessments", body)
		require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
		var got map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
		return got
	}

	sweep := func(dir float64, outside string) {
		lo := td + dir*(2.0-1e-6) // safely inside the retest band
		hi := td + dir*(2.0+1e-6) // safely outside
		require.Equal(t, "retest", post(lo)["verdict"])
		require.Equal(t, outside, post(hi)["verdict"])

		// Binary-search the float64 boundary (verdict is monotone in Tg).
		for i := 0; i < 80; i++ {
			mid := (lo + hi) / 2
			if mid == lo || mid == hi {
				break
			}
			if post(mid)["verdict"] == "retest" {
				lo = mid
			} else {
				hi = mid
			}
		}
		lastRetest := post(lo)
		firstStrict := post(hi)
		assert.Equal(t, "retest", lastRetest["verdict"])
		assert.Equal(t, 2.00*dir, lastRetest["delta_display"])
		assert.Equal(t, outside, firstStrict["verdict"])
		// lo and hi are adjacent float64 values: no representable Tg exists
		// between "endpoint retest" and "strictly outside".
		assert.Equal(t, math.Nextafter(lo, dir*math.Inf(1)), hi)
	}

	sweep(+1, "allowed")
	sweep(-1, "denied")
}

// A valid submission keeps showing the same verdict after reload: the POST
// response, GET list and GET detail all agree.
func TestCreate_PersistedVerdictStable(t *testing.T) {
	r := setup(t)
	w := do(t, r, http.MethodPost, "/api/assessments", validBody())
	require.Equal(t, http.StatusCreated, w.Code)
	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	id := strconv.FormatFloat(created["id"].(float64), 'f', 0, 64)

	w = do(t, r, http.MethodGet, "/api/assessments", nil)
	require.Equal(t, http.StatusOK, w.Code)
	var list map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &list))
	item := list["items"].([]any)[0].(map[string]any)
	assert.Equal(t, created["verdict"], item["verdict"])
	assert.Equal(t, created["delta"], item["delta"])
	assert.Equal(t, created["td"], item["td"])

	w = do(t, r, http.MethodGet, "/api/assessments/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)
	var detail map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &detail))
	assert.Equal(t, created["verdict"], detail["verdict"])
	assert.Equal(t, created["delta"], detail["delta"])
	assert.Equal(t, created["formula"], detail["formula"])
}

func TestGet_DetailAndMissing(t *testing.T) {
	r := setup(t)
	w := do(t, r, http.MethodPost, "/api/assessments", validBody())
	require.Equal(t, http.StatusCreated, w.Code)
	var created map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))

	id := strconv.FormatFloat(created["id"].(float64), 'f', 0, 64)
	w = do(t, r, http.MethodGet, "/api/assessments/"+id, nil)
	require.Equal(t, http.StatusOK, w.Code)
	var detail map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &detail))
	assert.Equal(t, "allowed", detail["verdict"])
	assert.Contains(t, detail["formula"].(map[string]any)["gamma_line"], "ln(70/100)")

	w = do(t, r, http.MethodGet, "/api/assessments/9999", nil)
	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestCreate_MissingAndWrongTypesAre422(t *testing.T) {
	r := setup(t)

	w := do(t, r, http.MethodPost, "/api/assessments", map[string]any{"voyage": "v", "hatch": "h", "tg": 20})
	require.Equal(t, http.StatusUnprocessableEntity, w.Code)
	var resp map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Len(t, resp["fields"].([]any), 2)

	w = doRaw(t, r, `{"voyage":"v","hatch":"h","tg":"abc","ta":20,"rh":70}`)
	require.Equal(t, http.StatusUnprocessableEntity, w.Code)
	var wrongType map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &wrongType))
	wtFields := wrongType["fields"].([]any)
	require.Len(t, wtFields, 1)
	assert.Equal(t, "wrong_type", wtFields[0].(map[string]any)["code"])

	w = doRaw(t, r, `{"voyage":"v","hatch":"h","tg":-1e999,"ta":20,"rh":70}`)
	require.Equal(t, http.StatusUnprocessableEntity, w.Code)
	var negInf map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &negInf))
	ni := negInf["fields"].([]any)
	require.Len(t, ni, 1)
	assert.Equal(t, "not_finite", ni[0].(map[string]any)["code"])

	// Malformed JSON stays a 400.
	w = doRaw(t, r, `{not json`)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestHealthz(t *testing.T) {
	r := setup(t)
	w := do(t, r, http.MethodGet, "/api/healthz", nil)
	assert.Equal(t, http.StatusOK, w.Code)
}

// Guard against accidental constant drift.
func TestConstants(t *testing.T) {
	assert.Equal(t, -20.0, decision.MinTempC)
	assert.Equal(t, 60.0, decision.MaxTempC)
	assert.Equal(t, 1.0, decision.MinRH)
	assert.Equal(t, 100.0, decision.MaxRH)
}
