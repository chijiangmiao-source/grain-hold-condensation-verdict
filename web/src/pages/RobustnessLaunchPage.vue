<script setup>
import { onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { createRobustnessCheck, getAssessment } from '@/lib/api.js'
import VerdictBadge from '@/components/VerdictBadge.vue'

const props = defineProps({ id: { type: String, required: true } })
const router = useRouter()

const record = ref(null)
const status = ref('loading') // loading | ready | missing | error

// Three SYMMETRIC instrument error magnitudes. The browser validates them
// for instant feedback only; the server independently re-validates and
// generates every boundary combination itself.
const form = reactive({ tg_eps: '', ta_eps: '', rh_eps: '' })
const errors = reactive({})
const submitError = ref('')
const submitting = ref(false)

const fmt2 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2))

const FIELDS = [
  { key: 'tg_eps', source: 'tg', label: '粮温 Tg 对称误差幅度', unit: '℃', lo: -20, hi: 60, step: '0.01' },
  { key: 'ta_eps', source: 'ta', label: '舱内气温 Ta 对称误差幅度', unit: '℃', lo: -20, hi: 60, step: '0.01' },
  { key: 'rh_eps', source: 'rh', label: '相对湿度 RH 对称误差幅度', unit: '%', lo: 1, hi: 100, step: '0.1' },
]

// The symmetric interval each field spans around the ORIGINAL measured
// value, rendered only as a hint. The authoritative range check is on the
// server; this mirrors decision bounds for instant feedback.
function intervalHint(f) {
  const base = Number(record.value?.[f.source])
  const raw = String(form[f.key]).trim()
  const eps = Number(raw)
  if (!record.value || raw === '' || !Number.isFinite(eps) || eps <= 0) return ''
  return `原评估值 ${fmt2(base)}${f.unit}，对称区间 ${fmt2(base - eps)} ~ ${fmt2(base + eps)}${f.unit}（合法区间 ${f.lo} ~ ${f.hi}）`
}

async function load(id) {
  status.value = 'loading'
  record.value = null
  try {
    const res = await getAssessment(id)
    if (res.status === 404) { status.value = 'missing'; return }
    if (!res.ok) { status.value = 'error'; return }
    record.value = res.data
    status.value = 'ready'
  } catch {
    status.value = 'error'
  }
}

function errFor(key) {
  return errors[key]?.message || ''
}

// Local pre-checks only; every request is independently validated by Go.
function validateLocally() {
  for (const k of Object.keys(errors)) delete errors[k]
  for (const f of FIELDS) {
    const raw = String(form[f.key]).trim()
    const base = Number(record.value[f.source])
    if (raw === '') {
      errors[f.key] = { field: f.key, code: 'required', message: `${f.label}必须填写` }
      continue
    }
    const v = Number(raw)
    if (!Number.isFinite(v)) {
      errors[f.key] = { field: f.key, code: 'not_finite', message: `${f.label}必须为有限数值` }
      continue
    }
    if (v <= 0) {
      errors[f.key] = { field: f.key, code: 'not_positive', message: `${f.label}必须为正数（大于 0）` }
      continue
    }
    if (base - v < f.lo || base + v > f.hi) {
      errors[f.key] = { field: f.key, code: 'out_of_range',
        message: `${f.label}会使边界值越出 ${f.lo} ~ ${f.hi} 的合法区间（对称区间 ${fmt2(base - v)} ~ ${fmt2(base + v)}）` }
    }
  }
  return Object.keys(errors).length === 0
}

async function submit() {
  submitError.value = ''
  if (!validateLocally()) return
  submitting.value = true
  try {
    const res = await createRobustnessCheck(props.id, {
      tg_eps: Number(form.tg_eps),
      ta_eps: Number(form.ta_eps),
      rh_eps: Number(form.rh_eps),
    })
    if (res.status === 422) {
      for (const fld of res.data.fields || []) errors[fld.field] = fld
      submitError.value = res.data.error || '输入校验失败，未生成任何记录'
      return
    }
    if (!res.ok) {
      submitError.value = res.data?.error || `请求失败（${res.status}）`
      return
    }
    // Enter the independent check detail by its own check number.
    router.push(`/robustness-checks/${res.data.id}`)
  } catch (e) {
    submitError.value = '无法连接 API：' + e.message
  } finally {
    submitting.value = false
  }
}

onMounted(() => load(props.id))
watch(() => props.id, (id) => load(id))
</script>

<template>
  <section>
    <p>
      <RouterLink :to="`/assessments/${props.id}`" class="link">← 返回评估明细 #{{ props.id }}</RouterLink>
    </p>

    <div v-if="status === 'loading'" class="card"><p>加载中…</p></div>

    <div v-else-if="status === 'missing'" class="card" data-test="origin-missing">
      <h2>原评估不存在</h2>
      <p class="banner-error">编号 #{{ props.id }} 没有对应的评估记录，无法发起稳健性核查。</p>
      <p><RouterLink to="/" class="link">← 返回历史区</RouterLink></p>
    </div>

    <div v-else-if="status === 'error'" class="card" data-test="origin-error">
      <h2>原评估加载失败</h2>
      <p>请确认 Go API 已启动。</p>
      <p><RouterLink to="/" class="link">← 返回历史区</RouterLink></p>
    </div>

    <template v-else>
      <div class="card" data-test="origin-summary">
        <h2>发起稳健性核查</h2>
        <p class="note">海上仪表存在允许误差时，单次露点结论可能在真实值边界上翻转。请填写粮温、气温与湿度的
          <b>对称误差幅度</b>（±值，必须为正数且不得把边界推出合法区间）；服务端以原评估输入为中心生成
          <b>八组</b>边界组合，逐组调用与录入完全相同的<b>未舍入露点判定</b>，并保存不可变核查。浏览器不生成边界、不参与判定。</p>
        <table class="kv">
          <tbody>
            <tr><td>原评估编号</td><td>#{{ record.id }}</td></tr>
            <tr><td>航次 / 舱号</td><td>{{ record.voyage }} / {{ record.hatch }}</td></tr>
            <tr>
              <td>原测量值 Tg / Ta / RH</td>
              <td>{{ fmt2(record.tg) }} ℃ / {{ fmt2(record.ta) }} ℃ / {{ fmt2(record.rh) }} %</td>
            </tr>
            <tr><td>未舍入露点 Td / 温差 Δ</td><td>{{ record.td }} ℃ / {{ record.delta }} ℃</td></tr>
            <tr><td>原结论</td><td><VerdictBadge :verdict="record.verdict" :hint="false" /></td></tr>
          </tbody>
        </table>
      </div>

      <form class="card" novalidate data-test="robustness-form" @submit.prevent="submit">
        <h3>对称误差幅度</h3>
        <div v-for="f in FIELDS" :key="f.key" class="field" :class="{ invalid: !!errors[f.key] }">
          <label :for="'rf-' + f.key">{{ f.label }}（{{ f.unit }}）</label>
          <input
            :id="'rf-' + f.key"
            v-model="form[f.key]"
            type="number"
            min="0"
            :step="f.step"
            :placeholder="`正数；±后不得越出 ${f.lo} ~ ${f.hi}`"
            :aria-invalid="!!errors[f.key]"
            :aria-describedby="errors[f.key] ? 'rerr-' + f.key : null"
          />
          <p v-if="intervalHint(f)" class="note">{{ intervalHint(f) }}</p>
          <p v-if="errFor(f.key)" :id="'rerr-' + f.key" class="field-err">{{ errFor(f.key) }}</p>
        </div>

        <p v-if="submitError" class="banner-error" data-test="robustness-banner">{{ submitError }}</p>

        <button type="submit" :disabled="submitting" data-test="robustness-submit">
          {{ submitting ? '核查中…' : '生成八组边界并核查' }}
        </button>
      </form>
    </template>
  </section>
</template>
