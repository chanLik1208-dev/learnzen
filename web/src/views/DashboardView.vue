<script setup>
import { computed, onMounted, ref } from 'vue';
import { motion } from 'motion-v';
import { api } from '../lib/api.js';
import { user } from '../lib/session.js';

const topics = ref([]);
const wrongOpen = ref(0);
const assignments = ref([]);
const loading = ref(true);

onMounted(async () => {
  // One failure should not blank the whole dashboard, so each panel settles
  // on its own and an empty panel says so rather than the page dying.
  const [t, w, a] = await Promise.allSettled([
    api.get('/api/topics'),
    api.get('/api/wrongbook'),
    api.get('/api/assignments'),
  ]);
  if (t.status === 'fulfilled') topics.value = t.value.topics;
  if (w.status === 'fulfilled') wrongOpen.value = w.value.openCount;
  if (a.status === 'fulfilled') assignments.value = a.value.assignments;
  loading.value = false;
});

const attempted = computed(() => topics.value.reduce((n, t) => n + t.attempted, 0));
const practisable = computed(() => topics.value.reduce((n, t) => n + t.questionCount, 0));
const rated = computed(() => topics.value.filter((t) => t.correctRate !== null));
const overall = computed(() => (rated.value.length
  ? rated.value.reduce((s, t) => s + t.correctRate, 0) / rated.value.length
  : null));

const pending = computed(() => assignments.value.filter(
  (a) => a.submission === null || a.submission.status === 'IN_PROGRESS',
));
const graded = computed(() => assignments.value.filter((a) => a.submission?.status === 'SUBMITTED'));

const fmt = (ms) => (ms == null ? '—' : new Date(ms).toLocaleDateString('zh-HK', { month: 'numeric', day: 'numeric' }));
</script>

<template>
  <h1 class="mb-1 text-xl font-semibold">你好，{{ user?.displayName }}</h1>
  <p class="mb-5 text-sm" style="color: var(--text-muted)">今天想練哪一part？</p>

  <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <template v-else>
    <div class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <motion.div
        v-for="(stat, i) in [
          { label: '已作答', value: attempted, suffix: ' 題', tone: 'var(--primary)' },
          { label: '整體正確率', value: overall === null ? null : Math.round(overall * 100), suffix: '%', tone: 'var(--success)' },
          { label: '待重做', value: wrongOpen, suffix: ' 題', tone: 'var(--danger)' },
          { label: '待完成作業', value: pending.length, suffix: ' 份', tone: 'var(--warning)' },
        ]" :key="stat.label"
        class="card p-4"
        :initial="{ opacity: 0, y: 10 }"
        :animate="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.25, ease: 'easeOut', delay: i * 0.04 }"
      >
        <div class="text-[11px]" style="color: var(--text-muted)">{{ stat.label }}</div>
        <div class="mt-1 text-2xl font-bold tabular-nums" :style="{ color: stat.tone }">
          <template v-if="stat.value === null">
            <span class="text-base font-normal" style="color: var(--text-subtle)">尚無記錄</span>
          </template>
          <template v-else>{{ stat.value }}<span class="text-sm font-medium">{{ stat.suffix }}</span></template>
        </div>
      </motion.div>
    </div>

    <section class="mb-6">
      <h2 class="mb-2.5 text-base font-semibold">待完成作業</h2>
      <div v-if="pending.length === 0" class="card p-8 text-center text-sm" style="color: var(--text-muted)">
        暫無待完成作業
      </div>
      <div v-else class="space-y-2.5">
        <motion.div
          v-for="(a, i) in pending" :key="a.id" class="card card-interactive flex items-center justify-between p-4"
          :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.25, ease: 'easeOut', delay: 0.15 + i * 0.04 }"
          :while-hover="{ y: -2 }"
        >
          <div>
            <div class="text-sm font-medium">{{ a.title }}</div>
            <div class="text-[11px]" style="color: var(--text-subtle)">
              {{ a.code }} · 截止 {{ fmt(a.dueAt) }}
            </div>
          </div>
          <RouterLink :to="{ name: 'assignments' }" class="btn btn-ghost !py-1.5 !text-[13px]">
            {{ a.submission ? '繼續作答' : '開始' }}
          </RouterLink>
        </motion.div>
      </div>
    </section>

    <section>
      <h2 class="mb-2.5 text-base font-semibold">最近成績</h2>
      <div v-if="graded.length === 0" class="card p-8 text-center text-sm" style="color: var(--text-muted)">
        還沒有已評分的作業
      </div>
      <div v-else class="space-y-2.5">
        <motion.div
          v-for="(a, i) in graded" :key="a.id" class="card flex items-center justify-between p-4"
          :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.25, ease: 'easeOut', delay: 0.2 + i * 0.04 }"
        >
          <div>
            <div class="text-sm font-medium">{{ a.title }}</div>
            <div class="text-[11px]" style="color: var(--text-subtle)">{{ a.code }}</div>
          </div>
          <div class="text-right">
            <span class="text-lg font-bold tabular-nums">{{ a.submission.score }}</span>
            <span class="text-sm" style="color: var(--text-subtle)">/{{ a.submission.maxScore }}</span>
          </div>
        </motion.div>
      </div>
    </section>

    <p v-if="practisable === 0" class="mt-6 rounded-xl p-4 text-sm"
       style="background: var(--warning-soft); color: var(--warning)">
      題庫還沒有可練習的題目——匯入的題目多半缺選項，已被標為草稿而不會派發。
    </p>
  </template>
</template>
