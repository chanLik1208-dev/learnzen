<script setup>
import { computed, onMounted, ref } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const data = ref(null);
const loading = ref(true);
const error = ref('');

onMounted(async () => {
  try {
    data.value = await api.get('/api/me/progress');
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
});

const attempted = computed(() => (data.value?.topics ?? []).filter((t) => t.answered > 0));
const untouched = computed(() => (data.value?.topics ?? [])
  .filter((t) => t.answered === 0 && t.questionCount > 0));

/** The tallest bar sets the scale, so a quiet month is not a flat line. */
const peak = computed(() => Math.max(1, ...(data.value?.activity ?? []).map((d) => d.answered)));

const pct = (n) => Math.round(n * 100);
const fmtDate = (ms) => new Date(ms).toLocaleDateString('zh-HK', { month: 'numeric', day: 'numeric' });
const tone = (accuracy) => (accuracy >= 0.7 ? 'var(--success)'
  : accuracy >= 0.5 ? 'var(--warning)' : 'var(--danger)');
</script>

<template>
  <h1 class="mb-1 text-xl font-semibold">學習檔案</h1>
  <p class="mb-5 text-sm" style="color: var(--text-muted)">你自己的進度，跟老師看到的是同一份</p>

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

  <template v-else-if="data">
    <div class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <motion.div
        v-for="(s, i) in [
          { label: '累計作答', value: data.totals.answered, unit: ' 題' },
          { label: '整體正確率', value: data.totals.accuracy === null ? null : `${pct(data.totals.accuracy)}%`,
            tone: data.totals.accuracy === null ? null : tone(data.totals.accuracy) },
          { label: '連續練習', value: data.totals.streakDays, unit: ' 天',
            tone: data.totals.streakDays > 0 ? 'var(--warning)' : null },
          { label: '已攻克錯題', value: data.totals.clearedWrong, unit: ' 題', tone: 'var(--success)' },
        ]" :key="s.label"
        class="card p-4"
        :initial="{ opacity: 0, y: 10 }" :animate="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.25, ease: 'easeOut', delay: i * 0.04 }"
      >
        <div class="text-[11px]" style="color: var(--text-muted)">{{ s.label }}</div>
        <div class="mt-1 text-2xl font-bold tabular-nums" :style="{ color: s.tone ?? 'var(--text)' }">
          <span v-if="s.value === null" class="text-sm font-normal" style="color: var(--text-subtle)">
            尚無記錄
          </span>
          <template v-else>{{ s.value }}<span class="text-sm font-medium">{{ s.unit ?? '' }}</span></template>
        </div>
      </motion.div>
    </div>

    <!-- weak and strong ────────────────────────────────────────────── -->
    <section v-if="data.weakest.length" class="mb-6 grid gap-3 sm:grid-cols-2">
      <motion.div
        class="card p-4"
        :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.25, ease: 'easeOut', delay: 0.15 }"
      >
        <h2 class="mb-2 text-sm font-semibold" style="color: var(--danger)">最該補的課題</h2>
        <RouterLink
          v-for="t in data.weakest" :key="t.topicId"
          :to="{ name: 'practice' }"
          class="flex items-center justify-between py-1 text-[13px] hover:underline"
        >
          <span>{{ t.name }}</span>
          <span class="tabular-nums" style="color: var(--text-muted)">
            {{ pct(t.accuracy) }}%<template v-if="t.openWrong"> · {{ t.openWrong }} 題待重做</template>
          </span>
        </RouterLink>
      </motion.div>

      <motion.div
        class="card p-4"
        :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.25, ease: 'easeOut', delay: 0.2 }"
      >
        <h2 class="mb-2 text-sm font-semibold" style="color: var(--success)">掌握得最好的</h2>
        <div v-for="t in data.strongest" :key="t.topicId"
             class="flex items-center justify-between py-1 text-[13px]">
          <span>{{ t.name }}</span>
          <span class="tabular-nums" style="color: var(--text-muted)">{{ pct(t.accuracy) }}%</span>
        </div>
      </motion.div>
    </section>

    <!-- activity ──────────────────────────────────────────────────── -->
    <section class="mb-6">
      <h2 class="mb-2.5 text-base font-semibold">最近四週</h2>
      <div class="card p-5">
        <div class="flex h-24 items-end gap-1">
          <motion.div
            v-for="(d, i) in data.activity" :key="d.date"
            class="flex-1 rounded-t"
            :style="{ background: d.answered === 0 ? 'var(--border)' : 'var(--primary)', minHeight: '2px' }"
            :title="`${d.date}：${d.answered} 題`"
            :initial="{ scaleY: 0 }"
            :animate="{ scaleY: 1 }"
            :transition="{ type: 'spring', visualDuration: 0.35, bounce: 0, delay: i * 0.012 }"
          >
            <div :style="{ height: `${Math.max(2, (d.answered / peak) * 96)}px` }" />
          </motion.div>
        </div>
        <div class="mt-2 flex justify-between text-[11px]" style="color: var(--text-subtle)">
          <span>{{ data.activity[0].date.slice(5) }}</span>
          <span>{{ data.activity.at(-1).date.slice(5) }}</span>
        </div>
      </div>
    </section>

    <!-- per topic ─────────────────────────────────────────────────── -->
    <section class="mb-6">
      <h2 class="mb-2.5 text-base font-semibold">各課題</h2>

      <div v-if="attempted.length === 0" class="card p-8 text-center text-sm"
           style="color: var(--text-muted)">還沒有作答記錄，先去練幾題</div>

      <div v-else class="card divide-y p-0" style="border-color: var(--border)">
        <motion.div
          v-for="(t, i) in attempted" :key="t.topicId"
          class="flex items-center gap-3 px-4 py-3"
          :initial="{ opacity: 0, x: -6 }" :animate="{ opacity: 1, x: 0 }"
          :transition="{ duration: 0.2, ease: 'easeOut', delay: Math.min(i, 20) * 0.02 }"
        >
          <span class="w-24 shrink-0 text-sm">{{ t.name }}</span>
          <div class="h-1.5 flex-1 overflow-hidden rounded-full" style="background: var(--border)">
            <motion.div
              class="h-full origin-left rounded-full"
              :style="{ background: tone(t.accuracy) }"
              :initial="{ scaleX: 0 }" :animate="{ scaleX: t.accuracy }"
              :transition="{ type: 'spring', visualDuration: 0.5, bounce: 0, delay: 0.1 + Math.min(i, 20) * 0.02 }"
            />
          </div>
          <span class="w-28 text-right text-[12px] tabular-nums" style="color: var(--text-muted)">
            {{ pct(t.accuracy) }}% · {{ t.answered }} 題
          </span>
          <span class="w-16 text-right text-[11px] tabular-nums"
                :style="{ color: t.openWrong ? 'var(--danger)' : 'var(--text-subtle)' }">
            錯 {{ t.openWrong }}
          </span>
        </motion.div>
      </div>

      <!-- Naming what has not been opened, because "no data" on a chart looks
           the same as "nothing to do" and they are not the same. -->
      <p v-if="untouched.length" class="mt-2.5 rounded-lg px-3 py-2 text-[12px]"
         style="background: var(--bg); color: var(--text-muted)">
        還沒碰過的課題：{{ untouched.map((t) => t.name).join('、') }}
      </p>
    </section>

    <section v-if="data.submissions.length">
      <h2 class="mb-2.5 text-base font-semibold">作業成績</h2>
      <div class="card divide-y p-0" style="border-color: var(--border)">
        <div v-for="s in data.submissions" :key="s.assignmentId"
             class="flex items-center justify-between px-4 py-3">
          <div>
            <div class="text-sm">{{ s.title }}</div>
            <div class="text-[11px]" style="color: var(--text-subtle)">
              {{ s.code }} · {{ fmtDate(s.submittedAt) }}
            </div>
          </div>
          <div class="text-right tabular-nums">
            <span class="font-bold" :style="{ color: s.rate === null ? 'var(--text)' : tone(s.rate) }">
              {{ s.score }}
            </span>
            <span class="text-xs" style="color: var(--text-subtle)">/{{ s.maxScore }}</span>
          </div>
        </div>
      </div>
    </section>
  </template>
</template>
