<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';
import QuestionCard from '../components/QuestionCard.vue';

const list = ref([]);
const loading = ref(true);
const error = ref('');

/** Null when browsing the list; a paper object while attempting one. */
const paper = ref(null);
const answers = ref(new Map());
const saving = ref(false);
const result = ref(null);
const remaining = ref(null);
let ticker = null;

async function load() {
  loading.value = true;
  try {
    list.value = (await api.get('/api/assignments')).assignments;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
onUnmounted(() => clearInterval(ticker));

const fmtDate = (ms) => (ms == null ? '無截止' : new Date(ms).toLocaleString('zh-HK',
  { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));

const fmtClock = (ms) => {
  if (ms == null) return null;
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function statusOf(a) {
  if (a.submission?.status === 'SUBMITTED') return { label: '已提交', tone: 'var(--success)', soft: 'var(--success-soft)' };
  if (a.submission?.status === 'IN_PROGRESS') return { label: '作答中', tone: 'var(--warning)', soft: 'var(--warning-soft)' };
  return { label: '未開始', tone: 'var(--text-muted)', soft: 'var(--bg)' };
}

async function open(a) {
  error.value = '';
  try {
    if (a.submission?.status === 'SUBMITTED') {
      result.value = await api.get(`/api/assignments/${a.id}/review`);
      paper.value = { assignment: a, questions: [] };
      return;
    }
    const data = await api.post(`/api/assignments/${a.id}/start`);
    paper.value = data;
    answers.value = new Map(
      data.questions.filter((q) => q.chosen).map((q) => [q.id, q.chosen.split(',')]),
    );
    startClock(data.hardStopAt, data.serverTime);
  } catch (err) {
    error.value = err.message;
  }
}

/**
 * The countdown is display only. It is seeded from the server's own clock and
 * its deadline, and reaching zero asks the server to submit — the server is
 * what actually decides the paper is over, so a paused tab or a shifted system
 * clock buys nothing.
 */
function startClock(hardStopAt, serverTime) {
  clearInterval(ticker);
  if (hardStopAt == null) { remaining.value = null; return; }
  const drift = Date.now() - serverTime;
  const tick = () => {
    remaining.value = hardStopAt - (Date.now() - drift);
    if (remaining.value <= 0) { clearInterval(ticker); submit(); }
  };
  tick();
  ticker = setInterval(tick, 1000);
}

async function pick(questionId, labels) {
  answers.value.set(questionId, labels);
  answers.value = new Map(answers.value);
  saving.value = true;
  try {
    await api.put(`/api/assignments/${paper.value.assignment.id}/answers`, {
      answers: [{ questionId, chosen: labels }],
    });
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

async function submit() {
  try {
    result.value = await api.post(`/api/assignments/${paper.value.assignment.id}/submit`);
    clearInterval(ticker);
    remaining.value = null;
  } catch (err) {
    error.value = err.message;
  }
}

function back() {
  paper.value = null;
  result.value = null;
  clearInterval(ticker);
  load();
}

const answeredCount = computed(() => answers.value.size);
</script>

<template>
  <AnimatePresence mode="wait" :initial="false">
    <!-- ── list ──────────────────────────────────────────────────────── -->
    <motion.div
      v-if="!paper" key="list"
      :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }"
      :transition="{ duration: 0.18 }"
    >
      <h1 class="mb-5 text-xl font-semibold">作業</h1>

      <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>
      <div v-else-if="list.length === 0" class="card p-10 text-center text-sm" style="color: var(--text-muted)">
        目前沒有作業
      </div>

      <div v-else class="space-y-2.5">
        <motion.div
          v-for="(a, i) in list" :key="a.id"
          class="card card-interactive p-4"
          :initial="{ opacity: 0, y: 10 }" :animate="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.25, ease: 'easeOut', delay: i * 0.04 }"
          :while-hover="{ y: -2 }"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium">{{ a.title }}</span>
                <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                      :style="{ background: statusOf(a).soft, color: statusOf(a).tone }">
                  {{ statusOf(a).label }}
                </span>
              </div>
              <div class="mt-0.5 text-[11px]" style="color: var(--text-subtle)">
                {{ a.code }} · 截止 {{ fmtDate(a.dueAt) }}
                <template v-if="a.timeLimitSeconds"> · 限時 {{ Math.round(a.timeLimitSeconds / 60) }} 分鐘</template>
              </div>
            </div>

            <div class="flex items-center gap-3">
              <!-- A submission that does not exist renders as a dash, never as 0. -->
              <div v-if="a.submission?.status === 'SUBMITTED'" class="text-right tabular-nums">
                <span class="text-base font-bold">{{ a.submission.score }}</span>
                <span class="text-xs" style="color: var(--text-subtle)">/{{ a.submission.maxScore }}</span>
              </div>
              <div v-else class="text-sm" style="color: var(--text-subtle)">—</div>

              <button class="btn btn-ghost !py-1.5 !text-[13px]" @click="open(a)">
                {{ a.submission?.status === 'SUBMITTED' ? '檢視' : a.submission ? '繼續' : '開始' }}
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </motion.div>

    <!-- ── attempt / review ──────────────────────────────────────────── -->
    <motion.div
      v-else key="paper"
      :initial="{ opacity: 0, y: 10 }" :animate="{ opacity: 1, y: 0 }" :exit="{ opacity: 0 }"
      :transition="{ duration: 0.22, ease: 'easeOut' }"
    >
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <button class="btn btn-ghost !py-1.5 !text-[13px]" @click="back">← 返回</button>

        <div class="flex items-center gap-3 text-sm">
          <span v-if="saving" style="color: var(--text-subtle)">儲存中…</span>
          <span v-else-if="!result" style="color: var(--text-subtle)">已答 {{ answeredCount }} 題</span>
          <!-- Under a minute the clock turns red: colour is the state signal,
               and it changes faster than anything moves. -->
          <span
            v-if="remaining !== null"
            class="rounded-lg px-2.5 py-1 font-semibold tabular-nums"
            :style="remaining < 60000
              ? { background: 'var(--danger-soft)', color: 'var(--danger)' }
              : { background: 'var(--bg)', color: 'var(--text-muted)' }"
          >{{ fmtClock(remaining) }}</span>
        </div>
      </div>

      <AnimatePresence>
        <motion.div
          v-if="result" key="result"
          :initial="{ opacity: 0, scale: 0.98, y: 8 }"
          :animate="{ opacity: 1, scale: 1, y: 0 }"
          :transition="{ type: 'spring', visualDuration: 0.3, bounce: 0 }"
          class="card mb-5 p-6 text-center" style="box-shadow: var(--shadow-3)"
        >
          <div class="text-3xl font-bold tabular-nums">
            {{ result.submission.score }}<span class="text-lg" style="color: var(--text-subtle)">/{{ result.submission.maxScore }}</span>
          </div>
          <p class="mt-1 text-sm" style="color: var(--text-muted)">
            {{ result.revealed ? '答案已公開，可查看詳解' : '老師尚未公開答案' }}
          </p>
        </motion.div>
      </AnimatePresence>

      <div v-if="!result" class="space-y-4">
        <QuestionCard
          v-for="q in paper.questions" :key="q.id"
          :question="q"
          :result="null"
          @answer="(labels) => pick(q.id, labels)"
        />

        <div class="flex justify-end pt-2">
          <motion.button
            class="btn btn-primary"
            :while-hover="{ y: -1 }" :while-press="{ scale: 0.97 }"
            :transition="{ type: 'spring', visualDuration: 0.15, bounce: 0 }"
            @click="submit"
          >交卷（已答 {{ answeredCount }}/{{ paper.questions.length }}）</motion.button>
        </div>
      </div>

      <div v-else class="space-y-2.5">
        <div v-for="a in result.answers" :key="a.questionId" class="card p-4">
          <div class="flex items-center justify-between text-sm">
            <span style="color: var(--text-muted)">題 {{ a.questionId }}</span>
            <span class="font-semibold" :style="{ color: a.isCorrect ? 'var(--success)' : 'var(--danger)' }">
              {{ a.isCorrect ? '答對' : '答錯' }}
              <template v-if="a.correctLabels"> · 正確 {{ a.correctLabels.join('、') }}</template>
            </span>
          </div>
          <p v-if="a.explanation" class="mt-2 whitespace-pre-line text-[13px] leading-relaxed"
             style="color: var(--text-muted)">{{ a.explanation }}</p>
        </div>
      </div>
    </motion.div>
  </AnimatePresence>

  <AnimatePresence>
    <motion.p
      v-if="error" key="err"
      :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }" :exit="{ opacity: 0 }"
      class="mt-4 rounded-lg px-3 py-2 text-sm"
      style="background: var(--danger-soft); color: var(--danger)"
    >{{ error }}</motion.p>
  </AnimatePresence>
</template>
