<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { createAssessment, createBatchAssessments, listAssessments } from '@/lib/api.js'
import VerdictBadge from '@/components/VerdictBadge.vue'

// Constraints mirror decision.Validate on the server. Client-side limits
// give instant feedback; the server remains the authority and its 422
// field errors are rendered verbatim.
const FIELDS = [
  { key: 'voyage', label: '航次代号', type: 'text', placeholder: '如 V-2026-09' },
  { key: 'hatch', label: '舱号', type: 'text', placeholder: '如 3H' },
  { key: 'tg', label: '粮温 Tg（℃）', type: 'number', min: -20, max: 60, step: '0.1', placeholder: '-20.0 ~ 60.0' },
  { key: 'ta', label: '舱内气温 Ta（℃）', type: 'number', min: -20, max: 60, step: '0.1', placeholder: '-20.0 ~ 60.0' },
  { key: 'rh', label: '相对湿度 RH（%）', type: 'number', min: 1, max: 100, step: '0.1', placeholder: '1.0 ~ 100.0' },
]

// The batch endpoint caps one submission at twenty ordered measurements; the
// constant mirrors store.MaxBatchRows on the server.
const MAX_BATCH_ROWS = 20
const MODE_SINGLE = 'single'
const MODE_BATCH = 'batch'

const mode = ref(MODE_SINGLE)

// ---- single-row mode (unchanged behaviour) ----
const form = reactive({ voyage: '', hatch: '', tg: '', ta: '', rh: '' })
const errors = reactive({})
const submitError = ref('')
const submitting = ref(false)
const latest = ref(null)

// ---- batch mode ----
let batchRowSeq = 0
function emptyBatchRow(prev = null) {
  // A new line inherits the previous line's voyage/hatch: consecutive
  // multi-hatch transcription usually keeps the voyage, and repeating a hatch
  // is a normal repeat measurement. The measured temperatures never copy.
  //
  // uid is a row IDENTITY: validation markers attach to it, so deleting a line
  // in front of a flagged one can never shift the marker onto another row.
  return { uid: ++batchRowSeq, voyage: prev?.voyage ?? '', hatch: prev?.hatch ?? '', tg: '', ta: '', rh: '' }
}
const batchRows = ref([emptyBatchRow()])
// Row-level failures keyed by the row's stable uid:
// [{ uid, fields: [{ field, code, message }] }]. Server 422 rows (1-based
// positions) are mapped to uids at receipt time.
const batchRowErrors = ref([])
const batchSubmitError = ref('')
// Which kind of banner is showing, so edits can keep it in sync:
// 'local' lists the offending positions; 'server' holds the rejection text.
// Anything else (connect/400 error) is left untouched until the next submit.
const batchErrorKind = ref('')
const batchSending = ref(false)
const batchResult = ref(null) // { count, items } on 201

function errFor(key) {
  return errors[key]?.message || ''
}

function batchErrorEntry(index) {
  const row = batchRows.value[index]
  return row ? batchRowErrors.value.find((r) => r.uid === row.uid) : null
}
function batchFieldError(index, key) {
  return batchErrorEntry(index)?.fields.find((f) => f.field === key) || null
}
function batchRowInvalid(index) {
  return !!batchErrorEntry(index)
}
// Current 1-based positions of flagged rows, in grid order.
const batchProblemRows = computed(() =>
  batchRows.value
    .map((row, i) => (batchRowErrors.value.some((r) => r.uid === row.uid) ? i + 1 : 0))
    .filter((n) => n > 0),
)

function addBatchRow() {
  if (batchRows.value.length >= MAX_BATCH_ROWS) return
  batchRows.value.push(emptyBatchRow(batchRows.value[batchRows.value.length - 1]))
}
function removeBatchRow(index) {
  if (batchRows.value.length <= 1) return
  const [removed] = batchRows.value.splice(index, 1)
  // The marker belongs to the deleted MEASUREMENT, so it leaves with it; it
  // must never be inherited by the row that moves into its position.
  if (batchRowErrors.value.some((r) => r.uid === removed.uid)) {
    batchRowErrors.value = batchRowErrors.value.filter((r) => r.uid !== removed.uid)
  }
  syncBatchBanner()
}

// Editing a flagged field clears THAT field's stale message immediately; once
// a row has no flagged fields left its row marker goes too.
function onBatchFieldInput(index, key) {
  const entry = batchErrorEntry(index)
  if (!entry) return
  const remaining = entry.fields.filter((f) => f.field !== key)
  if (remaining.length === entry.fields.length) return
  batchRowErrors.value = batchRowErrors.value
    .map((r) => (r.uid === entry.uid ? { ...r, fields: remaining } : r))
    .filter((r) => r.fields.length > 0)
  syncBatchBanner()
}

// Keep a validation banner consistent with the markers still present: the
// local banner re-lists current positions (rows may have been deleted), and
// either kind of validation banner disappears once nothing is flagged.
function syncBatchBanner() {
  if (batchErrorKind.value === 'local') {
    const positions = batchProblemRows.value
    if (positions.length === 0) {
      batchErrorKind.value = ''
      batchSubmitError.value = ''
    } else {
      batchSubmitError.value = `第 ${positions.join('、')} 行未通过校验，整批尚未提交`
    }
  } else if (batchErrorKind.value === 'server' && batchRowErrors.value.length === 0) {
    batchErrorKind.value = ''
    batchSubmitError.value = ''
  }
}

// After a successful save the result panel describes EXACTLY these rows and
// values. Any further edit (typing, adding/removing a line) invalidates it, so
// the panel can never present old conclusions for changed inputs.
watch(batchRows, () => {
  if (batchResult.value) batchResult.value = null
}, { deep: true })

// Scroll the first offending line into view so the chief officer can fix it
// without hunting through twenty rows.
async function locateFirstBatchError() {
  await nextTick()
  const el = document.querySelector('[data-test="batch-row"].batch-row-invalid')
  el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  el?.querySelector('input')?.focus?.()
}

// Instant client-side checks; a rejected value is never sent.
function validateLocally() {
  for (const k of Object.keys(errors)) delete errors[k]
  const fail = (key, message) => { errors[key] = { field: key, code: 'client', message } }

  if (!form.voyage.trim()) fail('voyage', '航次代号不能为空')
  if (!form.hatch.trim()) fail('hatch', '舱号不能为空')

  const checkNum = (key, label, lo, hi) => {
    const raw = String(form[key]).trim()
    if (raw === '') { fail(key, `${label}必须填写`); return }
    const v = Number(raw)
    if (!Number.isFinite(v)) { fail(key, `${label}必须为有限数值`); return }
    if (v < lo || v > hi) fail(key, `${label}必须在 ${lo.toFixed(1)} 至 ${hi.toFixed(1)} 之间`)
  }
  checkNum('tg', '粮温 Tg', -20, 60)
  checkNum('ta', '舱内气温 Ta', -20, 60)
  checkNum('rh', '相对湿度 RH', 1, 100)

  return Object.keys(errors).length === 0
}

// Per-row client checks build the SAME fields shape as the server 422, but
// keyed by the row's stable uid rather than its submit-time position, so a
// client-blocked batch and a server-rejected batch render identically and
// markers survive row deletions correctly.
function validateBatchLocally() {
  const rowErrs = []
  batchRows.value.forEach((row) => {
    const fields = []
    if (!row.voyage.trim()) fields.push({ field: 'voyage', code: 'client', message: '航次代号不能为空' })
    if (!row.hatch.trim()) fields.push({ field: 'hatch', code: 'client', message: '舱号不能为空' })

    const checkNum = (key, label, lo, hi) => {
      const raw = String(row[key]).trim()
      if (raw === '') { fields.push({ field: key, code: 'client', message: `${label}必须填写` }); return }
      const v = Number(raw)
      if (!Number.isFinite(v)) { fields.push({ field: key, code: 'client', message: `${label}必须为有限数值` }); return }
      if (v < lo || v > hi) {
        fields.push({ field: key, code: 'client', message: `${label}必须在 ${lo.toFixed(1)} 至 ${hi.toFixed(1)} 之间` })
      }
    }
    checkNum('tg', '粮温 Tg', -20, 60)
    checkNum('ta', '舱内气温 Ta', -20, 60)
    checkNum('rh', '相对湿度 RH', 1, 100)

    if (fields.length > 0) rowErrs.push({ uid: row.uid, fields })
  })
  return rowErrs
}

async function refreshList() {
  try {
    const res = await listAssessments()
    if (res.ok) items.value = res.data.items
  } catch {
    // The form stays usable; the submit action will surface a connect error.
  }
}

async function submit() {
  submitError.value = ''
  latest.value = null
  if (!validateLocally()) return

  submitting.value = true
  try {
    const payload = {
      voyage: form.voyage.trim(),
      hatch: form.hatch.trim(),
      tg: Number(form.tg),
      ta: Number(form.ta),
      rh: Number(form.rh),
    }
    const res = await createAssessment(payload)
    if (res.status === 422) {
      // Server field errors win; merge with any client-side keys.
      for (const f of res.data.fields || []) errors[f.field] = f
      submitError.value = res.data.error || '输入校验失败，未生成记录'
      return
    }
    if (!res.ok) {
      submitError.value = res.data?.error || `请求失败（${res.status}）`
      return
    }
    latest.value = res.data
    await refreshList()
  } catch (e) {
    submitError.value = '无法连接 API：' + e.message
  } finally {
    submitting.value = false
  }
}

async function submitBatch() {
  batchSubmitError.value = ''
  batchErrorKind.value = ''
  batchResult.value = null
  batchRowErrors.value = []

  // Instant local rejection keeps an obviously bad line from leaving the
  // browser; the server still independently rejects a bad whole batch.
  const localErrs = validateBatchLocally()
  if (localErrs.length > 0) {
    batchRowErrors.value = localErrs
    batchErrorKind.value = 'local'
    batchSubmitError.value = `第 ${batchProblemRows.value.join('、')} 行未通过校验，整批尚未提交`
    await locateFirstBatchError()
    return
  }

  // Every line is sent in measurement order. The browser never computes
  // gamma/Td/delta/verdict: it only renders what the batch response returns.
  const payload = batchRows.value.map((r) => ({
    voyage: r.voyage.trim(),
    hatch: r.hatch.trim(),
    tg: Number(r.tg),
    ta: Number(r.ta),
    rh: Number(r.rh),
  }))

  batchSending.value = true
  try {
    const res = await createBatchAssessments(payload)
    if (res.status === 422) {
      // Whole-batch rejection: keep ALL inputs, mark each row named by the
      // server with its original field errors, and jump to the first one.
      // Server row numbers are 1-based submit positions; map them to the
      // stable uids now so later edits/deletions stay attached to the same
      // measurement.
      const serverRows = Array.isArray(res.data?.rows) ? res.data.rows : []
      batchRowErrors.value = serverRows
        .map((r) => {
          const row = batchRows.value[r.row - 1]
          return row ? { uid: row.uid, fields: Array.isArray(r.fields) ? r.fields : [] } : null
        })
        .filter((r) => r && r.fields.length > 0)
      batchErrorKind.value = 'server'
      batchSubmitError.value = res.data?.error || '批量输入校验失败，整批未保存'
      await locateFirstBatchError()
      return
    }
    if (!res.ok) {
      batchSubmitError.value = res.data?.error || `请求失败（${res.status}）`
      return
    }
    batchResult.value = res.data
    await refreshList()
  } catch (e) {
    batchSubmitError.value = '无法连接 API：' + e.message
  } finally {
    batchSending.value = false
  }
}

const fmt2 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2))

// Distinct voyage codes for the overview entry points. This is only a
// navigation index built from the list; which record is "latest" per hatch is
// decided entirely by the server overview endpoint, never here.
const items = ref([])
const voyages = computed(() => {
  const seen = new Set()
  const out = []
  for (const a of items.value) {
    if (a.voyage && !seen.has(a.voyage)) {
      seen.add(a.voyage)
      out.push(a.voyage)
    }
  }
  return out
})

onMounted(refreshList)
</script>

<template>
  <section class="grid" :class="{ 'grid--wide': mode === MODE_BATCH }">
    <div class="card form">
      <div class="mode-tabs" data-test="mode-tabs">
        <a
          href="#"
          class="mode-tab"
          :class="{ active: mode === MODE_SINGLE }"
          data-test="mode-single"
          @click.prevent="mode = MODE_SINGLE"
        >单条录入</a>
        <a
          href="#"
          class="mode-tab"
          :class="{ active: mode === MODE_BATCH }"
          data-test="mode-batch"
          @click.prevent="mode = MODE_BATCH"
        >批量录入（最多 20 行）</a>
      </div>

      <!-- ============ single-row form ============ -->
      <form v-if="mode === MODE_SINGLE" class="single-form" novalidate @submit.prevent="submit">
        <h2>录入测量数据</h2>
        <p class="note">温差风险取决于粮温与舱内空气<b>露点</b>之差，而非相对湿度本身。提交后由 Go API 统一复算。</p>

        <div v-for="f in FIELDS" :key="f.key" class="field" :class="{ invalid: !!errors[f.key] }">
          <label :for="'f-' + f.key">{{ f.label }}</label>
          <input
            :id="'f-' + f.key"
            v-model="form[f.key]"
            :type="f.type"
            :min="f.min"
            :max="f.max"
            :step="f.step"
            :placeholder="f.placeholder"
            :aria-invalid="!!errors[f.key]"
            :aria-describedby="errors[f.key] ? 'err-' + f.key : null"
          />
          <p v-if="errFor(f.key)" :id="'err-' + f.key" class="field-err">{{ errFor(f.key) }}</p>
        </div>

        <p v-if="submitError" class="banner-error">{{ submitError }}</p>

        <button type="submit" :disabled="submitting">
          {{ submitting ? '复算中…' : '提交复算' }}
        </button>
      </form>

      <!-- ============ batch form ============ -->
      <form v-else class="batch-form" novalidate @submit.prevent="submitBatch">
        <h2>批量录入测量数据</h2>
        <p class="note">靠港前集中抄录时，按<b>测量先后</b>逐行填写航次、舱号、粮温、气温与湿度，一次提交。
          同航次同舱的后一行会关联本批较早记录；任一行非法则<b>整批不落库</b>，已填内容全部保留并定位到问题行。</p>

        <div class="batch-scroll">
          <div class="batch-grid" data-test="batch-grid">
            <div class="batch-head batch-row">
              <span>#</span>
              <span>航次代号</span>
              <span>舱号</span>
              <span>粮温 Tg（℃）</span>
              <span>气温 Ta（℃）</span>
              <span>湿度 RH（%）</span>
              <span></span>
            </div>

            <div
              v-for="(row, i) in batchRows"
              :key="i"
              class="batch-row"
              :class="{ 'batch-row-invalid': batchRowInvalid(i) }"
              :data-row="i + 1"
              data-test="batch-row"
            >
              <span class="batch-index">{{ i + 1 }}</span>
              <div class="batch-cell">
                <input
                  :id="`bf-${i}-voyage`"
                  v-model="row.voyage"
                  type="text"
                  placeholder="如 V-2026-09"
                  :aria-invalid="!!batchFieldError(i, 'voyage')"
                  @input="onBatchFieldInput(i, 'voyage')"
                />
                <p v-if="batchFieldError(i, 'voyage')" :id="`berr-${i}-voyage`" class="cell-err">
                  {{ batchFieldError(i, 'voyage').message }}
                </p>
              </div>
              <div class="batch-cell">
                <input
                  :id="`bf-${i}-hatch`"
                  v-model="row.hatch"
                  type="text"
                  placeholder="如 3H"
                  :aria-invalid="!!batchFieldError(i, 'hatch')"
                  @input="onBatchFieldInput(i, 'hatch')"
                />
                <p v-if="batchFieldError(i, 'hatch')" :id="`berr-${i}-hatch`" class="cell-err">
                  {{ batchFieldError(i, 'hatch').message }}
                </p>
              </div>
              <div class="batch-cell">
                <input
                  :id="`bf-${i}-tg`"
                  v-model="row.tg"
                  type="number"
                  min="-20"
                  max="60"
                  step="0.1"
                  placeholder="-20~60"
                  :aria-invalid="!!batchFieldError(i, 'tg')"
                  @input="onBatchFieldInput(i, 'tg')"
                />
                <p v-if="batchFieldError(i, 'tg')" :id="`berr-${i}-tg`" class="cell-err">
                  {{ batchFieldError(i, 'tg').message }}
                </p>
              </div>
              <div class="batch-cell">
                <input
                  :id="`bf-${i}-ta`"
                  v-model="row.ta"
                  type="number"
                  min="-20"
                  max="60"
                  step="0.1"
                  placeholder="-20~60"
                  :aria-invalid="!!batchFieldError(i, 'ta')"
                  @input="onBatchFieldInput(i, 'ta')"
                />
                <p v-if="batchFieldError(i, 'ta')" :id="`berr-${i}-ta`" class="cell-err">
                  {{ batchFieldError(i, 'ta').message }}
                </p>
              </div>
              <div class="batch-cell">
                <input
                  :id="`bf-${i}-rh`"
                  v-model="row.rh"
                  type="number"
                  min="1"
                  max="100"
                  step="0.1"
                  placeholder="1~100"
                  :aria-invalid="!!batchFieldError(i, 'rh')"
                  @input="onBatchFieldInput(i, 'rh')"
                />
                <p v-if="batchFieldError(i, 'rh')" :id="`berr-${i}-rh`" class="cell-err">
                  {{ batchFieldError(i, 'rh').message }}
                </p>
              </div>
              <div class="batch-cell batch-del">
                <button
                  type="button"
                  class="btn-mini"
                  data-test="batch-remove-row"
                  :disabled="batchRows.length <= 1"
                  :aria-label="`删除第 ${i + 1} 行`"
                  @click="removeBatchRow(i)"
                >✕</button>
              </div>
            </div>
          </div>
        </div>

        <div class="batch-actions">
          <button
            type="button"
            class="btn-secondary"
            data-test="batch-add-row"
            :disabled="batchRows.length >= MAX_BATCH_ROWS"
            @click="addBatchRow"
          >＋ 添加一行（{{ batchRows.length }}/{{ MAX_BATCH_ROWS }}）</button>
          <button type="submit" class="btn-primary" :disabled="batchSending">
            {{ batchSending ? '批量复算中…' : `一次提交 ${batchRows.length} 行` }}
          </button>
        </div>

        <p v-if="batchSubmitError" class="banner-error" data-test="batch-banner">{{ batchSubmitError }}</p>
      </form>
    </div>

    <div class="side">
      <!-- single-row result -->
      <template v-if="mode === MODE_SINGLE">
        <div v-if="latest" class="card result">
          <h2>判定结果 <VerdictBadge :verdict="latest.verdict" :hint="false" /></h2>
          <dl>
            <div><dt>γ（未舍入）</dt><dd>{{ latest.gamma }}</dd></div>
            <div><dt>γ（展示）</dt><dd>{{ fmt2(latest.gamma_display) }}</dd></div>
            <div><dt>露点 Td（℃）</dt><dd>{{ fmt2(latest.td_display) }}</dd></div>
            <div><dt>Δ = Tg − Td（℃，未舍入）</dt><dd>{{ latest.delta }}</dd></div>
            <div><dt>Δ（展示，℃）</dt><dd class="strong">{{ fmt2(latest.delta_display) }}</dd></div>
          </dl>
          <RouterLink :to="`/assessments/${latest.id}`" class="link">查看公式代入明细 →</RouterLink>
        </div>
        <div v-else class="card placeholder">
          <h2>判定结果</h2>
          <p>提交一次合法测量后在此显示。Δ&gt;2.00 允许，Δ&lt;−2.00 禁止，闭区间 [−2.00, 2.00] 复测。</p>
        </div>
      </template>

      <!-- batch result: one row per saved measurement, in order -->
      <template v-else>
        <div v-if="batchResult" class="card batch-result" data-test="batch-result">
          <h2>批量判定结果 <span class="meta">已保存 {{ batchResult.count }} 行</span></h2>
          <table>
            <thead>
              <tr><th>行</th><th>评估编号</th><th>航次/舱号</th><th>Δ（未舍入）</th><th>Δ（展示）</th><th>结论</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="(a, i) in batchResult.items" :key="a.id" data-test="batch-result-row">
                <td>{{ i + 1 }}</td>
                <td><RouterLink :to="`/assessments/${a.id}`" class="link">#{{ a.id }}</RouterLink></td>
                <td>{{ a.voyage }} / {{ a.hatch }}</td>
                <td>{{ a.delta }}</td>
                <td class="strong">{{ fmt2(a.delta_display) }}</td>
                <td><VerdictBadge :verdict="a.verdict" :hint="false" /></td>
                <td><RouterLink :to="`/assessments/${a.id}`" class="link">详情 →</RouterLink></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="card placeholder">
          <h2>批量判定结果</h2>
          <p>整批提交成功后，在此按行显示评估编号、未舍入温差、展示温差与结论，编号可直接进入既有详情页。</p>
        </div>
      </template>

      <div class="card history">
        <h2>历史记录</h2>
        <p v-if="items.length === 0" class="note">暂无记录。</p>
        <template v-else>
          <div class="voyage-entries" data-test="voyage-entries">
            <span class="note">按航次查看舱位概览（每舱最新风险）：</span>
            <RouterLink
              v-for="v in voyages"
              :key="v"
              :to="`/voyages/${encodeURIComponent(v)}/hatches/latest`"
              class="voyage-chip"
              data-test="voyage-entry"
            >{{ v }} →</RouterLink>
          </div>
          <table>
            <thead>
              <tr><th>#</th><th>航次/舱号</th><th>Tg</th><th>Ta</th><th>RH</th><th>Δ</th><th>结论</th></tr>
            </thead>
            <tbody>
              <tr v-for="a in items" :key="a.id">
                <td><RouterLink :to="`/assessments/${a.id}`" class="link">{{ a.id }}</RouterLink></td>
                <td>{{ a.voyage }} / {{ a.hatch }}</td>
                <td>{{ fmt2(a.tg) }}</td>
                <td>{{ fmt2(a.ta) }}</td>
                <td>{{ fmt2(a.rh) }}</td>
                <td :class="{ strong: true }">{{ fmt2(a.delta_display) }}</td>
                <td><VerdictBadge :verdict="a.verdict" :hint="false" /></td>
              </tr>
            </tbody>
          </table>
          <p class="note">刷新页面后结论仍来自 SQLite 中保存的记录，页面不做二次复算。</p>
        </template>
      </div>
    </div>
  </section>
</template>
