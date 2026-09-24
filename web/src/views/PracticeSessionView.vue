<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';
import QuestionCard from '../components/QuestionCard.vue';

const route = useRoute();
const router = useRouter();

const loading = ref(true);
const error = ref('');
const questions = ref([]);
const results = ref(new Map()); // questionId -> { chosen, isCorrect, correctLabels, explanation }
const index = ref(0);
const summary = ref(null);

const current = computed(() => questions.value[index.value] ?? null);
const currentResult = computed(() => (current.value ? results.value.get(current.value.id) ?? null : null));
const answeredCount = computed(() => results.value.size);
const progress = computed(() => (questions.value.length ? answeredCount.value / questions.value.length : 0));
const correctCount = computed(() => [...results.value.values()].filter((r) => r.isCorrect).length);
const isLast = computed(() => index.value >= questions.value.length - 1);

onMounted(async () => {
  try {
    // Always rehydrate from the server rather than from anything carried
    // through the router, so a refresh and a fresh arrival behave identically.
    const data = await api.get(`/api/practice/sessions/${route.params.id}`);
    questions.value = data.questions;

    for (const a of data.answered) {
      const q = data.questions.find((x) => x.id === a.questionId);
      results.value.set(a.questionId, {
        chosen: a.chosen,
        isCorrect: a.isCorrect,
        correctLabels: q?.correctLabels ?? [],
        explanation: q?.explanation ?? null,
      });
    }
    // Drop the student on the first question they have not answered yet.
    const next = data.questions.findIndex((q) => !results.value.has(q.id));
    index.value = next === -1 ? data.questions.length - 1 : next;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
});

async function answer(labels) {
  if (!current.value || currentResult.value) return;
  const questionId = current.value.id;
  try {
    const res = await api.post(`/api/practice/sessions/${route.params.id}/answers`, {
      questionId, chosen: labels,
    });
    results.value.set(questionId, res);
    results.value = new Map(results.value);
  } catch (err) {
    error.value = err.message;
  }
}

/** A student flagging the question they just answered. */
async function sendReport(payload) {
  try {
    await api.post(`/api/questions/${current.value.id}/report`, payload);
  } catch (err) {
    error.value = err.message;
  }
}

function next() {
  if (isLast.value) return finish();
  index.value += 1;
}

async function finish() {
  summary.value = await api.post(`/api/practice/sessions/${route.params.id}/finish`);
}
</script>

<template>
  <div v-if="loading" class="py-20 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <div v-else-if="error" class="card p-5 text-sm" style="color: var(--danger)">{{ error }}</div>

  <!-- ── summary ───────────────────────────────────────────────────────── -->
  <motion.div
    v-else-if="summary" key="summary"
    :initial="{ opacity: 0, scale: 0.97, y: 10 }"
    :animate="{ opacity: 1, scale: 1, y: 0 }"
    :transition="{ type: 'spring', visualDuration: 0.35, bounce: 0 }"
    class="card mx-auto max-w-md p-8 text-center"
    style="box-shadow: var(--shadow-3)"
  >
    <div class="mb-1 text-4xl font-bold tabular-nums">
      {{ summary.correct }}<span class="text-xl" style="color: var(--text-subtle)">/{{ summary.answered }}</span>
    </div>
    <p class="mb-6 text-sm" style="color: var(--text-muted)">
      {{ summary.accuracy === null ? '未作答' : `正確率 ${Math.round(summary.accuracy * 100)}%` }}
    </p>
    <div class="flex justify-center gap-2">
      <button class="btn btn-ghost" @click="router.push({ name: 'wrongbook' })">看錯題本</button>
      <button class="btn btn-primary" @click="router.push({ name: 'practice' })">再練一組</button>
    </div>
  </motion.div>

  <!-- ── question ──────────────────────────────────────────────────────── -->
  <div v-else-if="current">
    <div class="mb-5">
      <div class="mb-2 flex items-baseline justify-between text-sm">
        <span class="font-medium tabular-nums">
          第 {{ index + 1 }} / {{ questions.length }} 題
        </span>
        <span class="tabular-nums" style="color: var(--text-muted)">
          答對 {{ correctCount }}
        </span>
      </div>

      <div class="h-1.5 overflow-hidden rounded-full" style="background: var(--border)">
        <!-- scaleX rather than width: width would relayout on every answer. -->
        <motion.div
          class="h-full origin-left rounded-full"
          style="background: var(--primary)"
          :initial="false"
          :animate="{ scaleX: progress }"
          :transition="{ type: 'spring', visualDuration: 0.4, bounce: 0 }"
        />
      </div>
    </div>

    <AnimatePresence mode="wait" :initial="false">
      <motion.div
        :key="current.id"
        :initial="{ opacity: 0, x: 24 }"
        :animate="{ opacity: 1, x: 0, transition: { type: 'spring', visualDuration: 0.3, bounce: 0 } }"
        :exit="{ opacity: 0, x: -16, transition: { duration: 0.15, ease: 'easeIn' } }"
      >
        <QuestionCard
          :question="current" :result="currentResult" reportable
          @answer="answer" @report="sendReport"
        />
      </motion.div>
    </AnimatePresence>

    <AnimatePresence>
      <motion.div
        v-if="currentResult" key="next"
        :initial="{ opacity: 0, y: 8 }"
        :animate="{ opacity: 1, y: 0, transition: { duration: 0.22, ease: 'easeOut' } }"
        :exit="{ opacity: 0, transition: { duration: 0.12 } }"
        class="mt-4 flex justify-end"
      >
        <motion.button
          class="btn btn-primary"
          :while-hover="{ y: -1 }"
          :while-press="{ scale: 0.97 }"
          :transition="{ type: 'spring', visualDuration: 0.15, bounce: 0 }"
          @click="next"
        >
          {{ isLast ? '完成練習' : '下一題' }}
        </motion.button>
      </motion.div>
    </AnimatePresence>
  </div>
</template>
