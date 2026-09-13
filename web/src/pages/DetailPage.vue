<script setup>
import { onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { getAssessment } from '@/lib/api.js'
import VerdictBadge from '@/components/VerdictBadge.vue'

const props = defineProps({ id: { type: String, required: true } })
const record = ref(null)
const status = ref('loading') // loading | ready | missing | error

const fmt2 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2))

async function load(id) {
  status.value = 'loading'
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

onMounted(() => load(props.id))
watch(() => props.id, (id) => load(id))
</script>

<template>
  <section>
    <p><RouterLink to="/" class="link">← 返回录入页</RouterLink></p>

    <div v-if="status === 'loading'" class="card"><p>加载中…</p></div>
    <div v-else-if="status === 'missing'" class="card">
      <h2>记录不存在</h2>
      <p>编号 #{{ props.id }} 没有对应的评估记录。</p>
    </div>
    <div v-else-if="status === 'error'" class="card">
      <h2>加载失败</h2><p>请确认 Go API 已启动。</p>
    </div>

    <article v-else class="card detail">
      <h2>评估明细 #{{ record.id }}</h2>
      <p class="meta">航次 {{ record.voyage }} · 舱号 {{ record.hatch }} · {{ new Date(record.created_at).toLocaleString() }}</p>
      <p>最终结论：<VerdictBadge :verdict="record.verdict" /></p>

      <h3>录入值</h3>
      <table class="kv"><tbody>
        <tr><td>粮温 Tg</td><td>{{ fmt2(record.tg) }} ℃</td></tr>
        <tr><td>舱内气温 Ta</td><td>{{ fmt2(record.ta) }} ℃</td></tr>
        <tr><td>相对湿度 RH</td><td>{{ fmt2(record.rh) }} %</td></tr>
      </tbody></table>

      <h3>公式代入（全部由 API 计算并返回，页面不重算）</h3>
      <ol class="formula">
        <li>{{ record.formula.gamma_line }}</li>
        <li>{{ record.formula.td_line }}</li>
        <li>{{ record.formula.delta_line }}</li>
        <li class="rule">{{ record.formula.rule_line }}</li>
      </ol>

      <h3>持久化的未舍入中间量</h3>
      <table class="kv"><tbody>
        <tr><td>γ（未舍入，SQLite REAL）</td><td>{{ record.gamma }}</td></tr>
        <tr><td>Td（未舍入，℃）</td><td>{{ record.td }}</td></tr>
        <tr><td>Δ（未舍入，℃，判定依据）</td><td class="strong">{{ record.delta }}</td></tr>
        <tr><td>展示值 γ / Td / Δ</td><td>{{ fmt2(record.gamma_display) }} / {{ fmt2(record.td_display) }} / {{ fmt2(record.delta_display) }}</td></tr>
      </tbody></table>
      <p class="note">判定依据是<b>未舍入 Δ</b>：例如 Δ 展示为 2.00 但未舍入值为 2.004 时仍判“允许”，
        因此结论只能采用 API 返回的 verdict，不能用页面上的两位小数反推。</p>
    </article>
  </section>
</template>
