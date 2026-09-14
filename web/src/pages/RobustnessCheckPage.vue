<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { getRobustnessCheck } from '@/lib/api.js'
import VerdictBadge from '@/components/VerdictBadge.vue'

const props = defineProps({ id: { type: String, required: true } })

const check = ref(null)
const status = ref('loading') // loading | ready | missing | error
const errorMessage = ref('')

const fmt2 = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2))

const original = computed(() => check.value?.assessment ?? null)
const corners = computed(() => check.value?.corners ?? [])
const verdictSet = computed(() => check.value?.verdicts ?? [])

// Diverging rows are identified ONLY by the server-provided
// matches_original flag; the browser compares no verdict strings and
// derives no boundary values itself.
function differsFromOriginal(corner) {
  return corner.matches_original === false
}
const divergingCount = computed(() => corners.value.filter(differsFromOriginal).length)

const signText = (s) => (s === '-' ? '−' : '+')

async function load(id) {
  status.value = 'loading'
  errorMessage.value = ''
  try {
    const res = await getRobustnessCheck(id)
    if (res.status === 404) { status.value = 'missing'; return }
    if (!res.ok) {
      status.value = 'error'
      errorMessage.value = res.data?.error || `请求失败（${res.status}）`
      return
    }
    check.value = res.data
    status.value = 'ready'
  } catch (e) {
    status.value = 'error'
    errorMessage.value = '无法连接 API：' + e.message
  }
}

onMounted(() => load(props.id))
watch(() => props.id, (id) => load(id))
</script>

<template>
  <section>
    <p><RouterLink to="/" class="link">← 返回历史区</RouterLink></p>

    <div v-if="status === 'loading'" class="card"><p>加载中…</p></div>

    <div v-else-if="status === 'missing'" class="card" data-test="check-missing">
      <h2>稳健性核查不存在</h2>
      <p class="banner-error">核查编号 #{{ props.id }} 没有对应的核查记录，或已无法读取。</p>
      <p class="note">核查为不可变记录，只能凭发起成功后获得的核查编号重新打开；也可从历史区找到原评估后重新发起。</p>
      <p><RouterLink to="/" class="link">← 返回历史区（查找原评估）</RouterLink></p>
    </div>

    <div v-else-if="status === 'error'" class="card" data-test="check-error">
      <h2>稳健性核查读取失败</h2>
      <p class="banner-error">{{ errorMessage }}</p>
      <p><RouterLink to="/" class="link">← 返回历史区（查找原评估）</RouterLink></p>
    </div>

    <article v-else class="card" data-test="check-detail">
      <h2>
        稳健性核查 #{{ check.id }}
        <span class="status-pill" :class="check.status === 'stable' ? 'status-stable' : 'status-sensitive'"
              data-test="check-status">
          {{ check.status === 'stable' ? '稳定' : '敏感' }}
        </span>
      </h2>
      <p class="meta">创建于 {{ new Date(check.created_at).toLocaleString() }} ·
        原评估
        <RouterLink :to="`/assessments/${check.assessment_id}`" class="link">#{{ check.assessment_id }}</RouterLink>
      </p>

      <div v-if="check.status === 'stable'" class="risk risk-stable" data-test="risk-stable">
        <strong>结论稳定：</strong>八组边界组合的结论<b>全部与原结论一致</b>，结论集合仅含
        <VerdictBadge :verdict="verdictSet[0]" :hint="false" />。
        在所填仪表允许误差范围内，单次露点结论不会在真实值边界上翻转。
      </div>
      <div v-else class="risk risk-sensitive" data-test="risk-sensitive">
        <strong>风险提示 · 结论敏感：</strong>八组边界中有
        <b>{{ divergingCount }} 组</b>结论与原结论不同，结论集合包含多种结论：
        <VerdictBadge v-for="v in verdictSet" :key="v" :verdict="v" :hint="false" />。
        仪表允许误差已足以让单次露点结论在真实值边界上翻转，<b>不得仅凭原结论操作舱口通风</b>，
        应按更保守口径处置并立即重新测量粮温、气温与湿度。
      </div>

      <h3>原评估（发起时快照，不可变）</h3>
      <table class="kv">
        <tbody>
          <tr><td>航次 / 舱号</td><td>{{ original.voyage }} / {{ original.hatch }}</td></tr>
          <tr>
            <td>原测量值 Tg / Ta / RH</td>
            <td>{{ fmt2(original.tg) }} ℃ / {{ fmt2(original.ta) }} ℃ / {{ fmt2(original.rh) }} %</td>
          </tr>
          <tr><td>未舍入露点 Td / 温差 Δ</td><td>{{ original.td }} ℃ / {{ original.delta }} ℃</td></tr>
          <tr><td>原结论</td><td><VerdictBadge :verdict="original.verdict" :hint="false" /></td></tr>
        </tbody>
      </table>
      <p class="note">完整公式代入与前序对照仍以原评估详情为准：
        <RouterLink :to="`/assessments/${check.assessment_id}`" class="link">打开原评估 #{{ check.assessment_id }} →</RouterLink>
      </p>

      <h3>误差范围（对称 ±）</h3>
      <table class="kv">
        <tbody>
          <tr>
            <td>粮温 Tg</td>
            <td>±{{ check.tolerances.tg }} ℃ →
              边界 {{ fmt2(original.tg - check.tolerances.tg) }} ~ {{ fmt2(original.tg + check.tolerances.tg) }} ℃</td>
          </tr>
          <tr>
            <td>舱内气温 Ta</td>
            <td>±{{ check.tolerances.ta }} ℃ →
              边界 {{ fmt2(original.ta - check.tolerances.ta) }} ~ {{ fmt2(original.ta + check.tolerances.ta) }} ℃</td>
          </tr>
          <tr>
            <td>相对湿度 RH</td>
            <td>±{{ check.tolerances.rh }} % →
              边界 {{ fmt2(original.rh - check.tolerances.rh) }} ~ {{ fmt2(original.rh + check.tolerances.rh) }} %</td>
          </tr>
        </tbody>
      </table>

      <h3>八组服务端边界结果</h3>
      <p class="note">以下八行全部由 Go 服务端以原评估输入为中心生成并调用<b>未舍入露点判定</b>，
        刷新或凭核查编号重新打开时逐字一致；浏览器不生成边界、不参与判定。</p>
      <div class="corner-scroll">
        <table class="corner-table" data-test="corner-table">
          <thead>
            <tr>
              <th>#</th><th>Tg</th><th>Ta</th><th>RH</th>
              <th>Tg 值（℃）</th><th>Ta 值（℃）</th><th>RH 值（%）</th>
              <th>露点 Td（未舍入）</th><th>Δ（未舍入）</th><th>Δ（展示）</th><th>结论</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in corners" :key="c.index"
                :class="{ 'corner-diverges': differsFromOriginal(c) }"
                data-test="corner-row">
              <td>{{ c.index }}</td>
              <td>{{ signText(c.tg_sign) }}</td>
              <td>{{ signText(c.ta_sign) }}</td>
              <td>{{ signText(c.rh_sign) }}</td>
              <td>{{ c.tg }}</td>
              <td>{{ c.ta }}</td>
              <td>{{ c.rh }}</td>
              <td>{{ c.td }}</td>
              <td class="strong">{{ c.delta }}</td>
              <td>{{ fmt2(c.delta_display) }}</td>
              <td><VerdictBadge :verdict="c.verdict" :hint="false" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="note">结论集合（去重、按首次出现顺序）：
        <VerdictBadge v-for="v in verdictSet" :key="v" :verdict="v" :hint="false" />
        ——集合仅含原结论即标记“稳定”，包含多种结论即标记“敏感”。</p>
    </article>
  </section>
</template>
