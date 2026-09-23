<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const route = useRoute();
const router = useRouter();

const assignments = ref([]);
const selectedId = ref(route.query.id ? Number(route.query.id) : null);
const scores = ref(null);
const analysis = ref(null);
const loading = ref(true);
const loadingDetail = ref(false);
const error = ref('');
const tab = ref('scores');

onMounted(async () => {
  try {
    assignments.value = (await api.get('/api/teacher/assignments')).assignments;
    selectedId.value ??= assignments.value[0]?.id ?? null;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
});

watch(selectedId, async (id) => {
  if (!id) return;
  loadingDetail.value = true;
  error.value = '';
  scores.value = null;
  analysis.value = null;
  router.replace({ query: { id } });
  try {
    const [s, a] = await Promise.all([
      api.get(`/api/teacher/assignments/${id}/scores`),
      api.get(`/api/teacher/assignments/${id}/analysis`),
    ]);
    scores.value = s;
    analysis.value = a;
  } catch (err) {
    error.value = err.message;
  } finally {
    loadingDetail.value = false;
  }
}, { immediate: true });

const selected = computed(() => assignments.value.find((a) => a.id === selectedId.value) ?? null);

const submitted = computed(() => (scores.value?.rows ?? []).filter((r) => r.status === 'SUBMITTED'));
const stats = computed(() => {
  const marks = submitted.value.map((r) => r.score);
  if (marks.length === 0) return null;
  const sorted = [...marks].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    count: marks.length,
    mean: marks.reduce((s, m) => s + m, 0) / marks.length,
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    min: sorted[0],
    max: sorted.at(-1),
  };
});

const STATUS = {
  SUBMITTED: { label: '已交', tone: 'var(--success)', soft: 'var(--success-soft)' },
  IN_PROGRESS: { label: '作答中', tone: 'var(--warning)', soft: 'var(--warning-soft)' },
  NOT_STARTED: { label: '未開始', tone: 'var(--text-muted)', soft: 'var(--bg)' },
};

const pct = (n) => (n == null ? null : Math.round(n * 100));
const fmt = (ms) => (ms == null ? '—' : new Date(ms).toLocaleString('zh-HK',
  { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
</script>

<template>
  <h1 class="mb-1 text-xl font-semibold">成績與分析</h1>
  <p class="mb-5 text-sm" style="color: var(--text-muted)">每位學生都列出來，包括沒開始作答的</p>

  <AnimatePresence>
    <motion.p
      v-if="error" key="err"
      :initial="{ opacity: 0, height: 0 }" :animate="{ opacity: 1, height: 'auto' }"
      :exit="{ opacity: 0, height: 0 }"
      class="mb-4 overflow-hidden rounded-lg px-3 py-2 text-sm"
      style="background: var(--danger-soft); color: var(--danger)"
    >{{ error }}</motion.p>
  </AnimatePresence>

  <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <div v-else-if="assignments.length === 0" class="card p-10 text-center">
    <p class="mb-3 text-sm" style="color: var(--text-muted)">還沒有任何作業</p>
    <RouterLink :to="{ name: 'create-paper' }" class="btn btn-primary">去組卷</RouterLink>
  </div>

  <template v-else>
    <select v-model="selectedId" class="field mb-5 !w-auto">
      <option v-for="a in assignments" :key="a.id" :value="a.id">
        {{ a.title }}（{{ a.status === 'PUBLISHED' ? '已發佈' : a.status === 'DRAFT' ? '草稿' : '已結束' }}）
      </option>
    </select>

    <div v-if="loadingDetail" class="py-16 text-center text-sm" style="color: var(--text-muted)">
      載入中…
    </div>

    <template v-else-if="scores">
      <div class="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <motion.div
          v-for="(s, i) in [
            { label: '已交', value: `${submitted.length}/${scores.rows.length}` },
            { label: '平均分', value: stats ? stats.mean.toFixed(1) : null },
            { label: '中位數', value: stats ? String(stats.median) : null },
            { label: '最高／最低', value: stats ? `${stats.max} / ${stats.min}` : null },
          ]" :key="s.label"
          class="card p-4"
          :initial="{ opacity: 0, y: 10 }" :animate="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.25, ease: 'easeOut', delay: i * 0.04 }"
        >
          <div class="text-[11px]" style="color: var(--text-muted)">{{ s.label }}</div>
          <div class="mt-1 text-xl font-bold tabular-nums">
            <!-- No submissions is "no data", not zero. -->
            <span v-if="s.value === null" class="text-sm font-normal" style="color: var(--text-subtle)">
              尚無資料
            </span>
            <template v-else>{{ s.value }}</template>
          </div>
        </motion.div>
      </div>

      <div class="mb-4 flex gap-1 rounded-lg p-1" style="background: var(--bg); width: fit-content">
        <button
          v-for="t in [['scores', '學生成績'], ['analysis', '逐題分析']]" :key="t[0]"
          class="rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors duration-150"
          :style="tab === t[0]
            ? { background: 'var(--surface)', color: 'var(--text)', boxShadow: 'var(--shadow-1)' }
            : { color: 'var(--text-muted)' }"
          @click="tab = t[0]"
        >{{ t[1] }}</button>
      </div>

      <AnimatePresence mode="wait" :initial="false">
        <!-- students ─────────────────────────────────────────────────── -->
        <motion.div
          v-if="tab === 'scores'" key="scores"
          :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
          :exit="{ opacity: 0, transition: { duration: 0.12 } }"
          :transition="{ duration: 0.22, ease: 'easeOut' }"
          class="card overflow-hidden"
        >
          <table class="w-full text-sm">
            <thead>
              <tr style="border-bottom: 1px solid var(--border)">
                <th class="px-4 py-2.5 text-left text-xs font-medium" style="color: var(--text-muted)">學生</th>
                <th class="px-4 py-2.5 text-left text-xs font-medium" style="color: var(--text-muted)">狀態</th>
                <th class="px-4 py-2.5 text-right text-xs font-medium" style="color: var(--text-muted)">分數</th>
                <th class="hidden px-4 py-2.5 text-right text-xs font-medium sm:table-cell"
                    style="color: var(--text-muted)">交卷時間</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in scores.rows" :key="r.studentId" style="border-bottom: 1px solid var(--border)">
                <td class="px-4 py-2.5">
                  <RouterLink :to="{ name: 'student-profile', params: { id: r.studentId } }"
                              class="hover:underline">{{ r.displayName }}</RouterLink>
                  <span class="ml-1.5 text-[11px]" style="color: var(--text-subtle)">{{ r.username }}</span>
                </td>
                <td class="px-4 py-2.5">
                  <span class="rounded-full px-2 py-0.5 text-[11px] font-medium"
                        :style="{ background: STATUS[r.status].soft, color: STATUS[r.status].tone }">
                    {{ STATUS[r.status].label }}
                  </span>
                  <span v-if="r.late" class="ml-1.5 text-[11px]" style="color: var(--warning)">遲交</span>
                </td>
                <td class="px-4 py-2.5 text-right tabular-nums">
                  <!-- A student who never started has no score. Rendering that
                       as 0 would put them in the same bucket as someone who
                       answered everything wrong. -->
                  <template v-if="r.score === null">
                    <span style="color: var(--text-subtle)">—</span>
                  </template>
                  <template v-else>
                    <span class="font-semibold">{{ r.score }}</span>
                    <span class="text-xs" style="color: var(--text-subtle)">/{{ r.maxScore }}</span>
                  </template>
                </td>
                <td class="hidden px-4 py-2.5 text-right text-[12px] sm:table-cell"
                    style="color: var(--text-subtle)">{{ fmt(r.submittedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </motion.div>

        <!-- per question ─────────────────────────────────────────────── -->
        <motion.div
          v-else key="analysis"
          :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
          :exit="{ opacity: 0, transition: { duration: 0.12 } }"
          :transition="{ duration: 0.22, ease: 'easeOut' }"
          class="space-y-2"
        >
          <div v-if="!analysis?.questions.length" class="card p-10 text-center text-sm"
               style="color: var(--text-muted)">這份卷沒有題目</div>

          <motion.div
            v-for="(q, i) in analysis.questions" :key="q.questionId"
            class="card p-4"
            :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
            :transition="{ duration: 0.22, ease: 'easeOut', delay: i * 0.03 }"
          >
            <div class="flex items-start gap-3">
              <span class="w-6 shrink-0 pt-0.5 text-sm tabular-nums" style="color: var(--text-subtle)">
                {{ q.seq }}
              </span>
              <p class="line-clamp-2 flex-1 whitespace-pre-line text-[13.5px] leading-relaxed">
                {{ q.preview }}
              </p>
            </div>

            <div class="mt-3 flex items-center gap-3 pl-9">
              <div class="h-1.5 flex-1 overflow-hidden rounded-full" style="background: var(--border)">
                <motion.div
                  class="h-full origin-left rounded-full"
                  :style="{ background: q.classCorrectRate >= 0.6 ? 'var(--success)' : 'var(--danger)' }"
                  :initial="{ scaleX: 0 }" :animate="{ scaleX: q.classCorrectRate ?? 0 }"
                  :transition="{ type: 'spring', visualDuration: 0.5, bounce: 0, delay: 0.1 + i * 0.03 }"
                />
              </div>
              <span class="w-28 text-right text-[12px] tabular-nums" style="color: var(--text-muted)">
                <template v-if="q.classCorrectRate === null">未有人作答</template>
                <template v-else>
                  本班 {{ pct(q.classCorrectRate) }}%
                  <span v-if="q.officialCorrectRate != null" style="color: var(--text-subtle)">
                    / 公開 {{ Math.round(q.officialCorrectRate) }}%
                  </span>
                </template>
              </span>
            </div>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    </template>
  </template>
</template>
