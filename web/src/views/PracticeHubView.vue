<script setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const router = useRouter();
const topics = ref([]);
const loading = ref(true);
const error = ref('');
const starting = ref(null);

onMounted(async () => {
  try {
    topics.value = (await api.get('/api/topics')).topics;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
});

async function start(topic) {
  if (starting.value || !topic.open || topic.questionCount === 0) return;
  starting.value = topic.id;
  error.value = '';
  try {
    const s = await api.post('/api/practice/sessions', {
      mode: 'TOPIC', topicId: topic.id, count: Math.min(topic.questionCount, 10),
    });
    router.push({ name: 'practice-session', params: { id: s.sessionId } });
  } catch (err) {
    error.value = err.message;
    starting.value = null;
  }
}
</script>

<template>
  <h1 class="mb-1 text-xl font-semibold">課題練習</h1>
  <p class="mb-5 text-sm" style="color: var(--text-muted)">選一個課題，每組 10 題</p>

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

  <div v-else-if="topics.length === 0" class="card p-10 text-center text-sm" style="color: var(--text-muted)">
    尚未匯入課題
  </div>

  <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
    <motion.button
      v-for="(topic, i) in topics" :key="topic.id"
      type="button"
      class="card card-interactive p-4 text-left"
      :initial="{ opacity: 0, y: 10 }"
      :animate="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.25, ease: 'easeOut', delay: i * 0.03 }"
      :while-hover="topic.open && topic.questionCount ? { y: -4 } : {}"
      :while-press="topic.open && topic.questionCount ? { scale: 0.98 } : {}"
      :style="{ cursor: topic.open && topic.questionCount ? 'pointer' : 'not-allowed' }"
      @click="start(topic)"
    >
      <div class="mb-1 text-sm font-semibold"
           :style="{ color: topic.open && topic.questionCount ? 'var(--text)' : 'var(--text-disabled)' }">
        {{ topic.nameZh }}
      </div>

      <div class="text-[11px]" style="color: var(--text-subtle)">
        <template v-if="!topic.open">教師已關閉</template>
        <template v-else-if="topic.questionCount === 0">尚無題目</template>
        <template v-else>{{ topic.questionCount }} 題可練</template>
      </div>

      <!-- Null accuracy means "never attempted", which must not render the
           same as a genuine 0%. -->
      <div v-if="topic.correctRate !== null" class="mt-2">
        <div class="h-1 overflow-hidden rounded-full" style="background: var(--border)">
          <motion.div
            class="h-full origin-left rounded-full"
            :style="{ background: topic.correctRate >= 0.6 ? 'var(--success)' : 'var(--warning)' }"
            :initial="{ scaleX: 0 }" :animate="{ scaleX: topic.correctRate }"
            :transition="{ type: 'spring', visualDuration: 0.5, bounce: 0, delay: 0.1 + i * 0.03 }"
          />
        </div>
        <div class="mt-1 text-[10px] tabular-nums" style="color: var(--text-subtle)">
          正確率 {{ Math.round(topic.correctRate * 100) }}%
        </div>
      </div>
    </motion.button>
  </div>
</template>
