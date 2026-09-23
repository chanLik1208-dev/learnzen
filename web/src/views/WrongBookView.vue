<script setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const router = useRouter();
const items = ref([]);
const openCount = ref(0);
const loading = ref(true);
const error = ref('');
const showCleared = ref(false);

async function load() {
  loading.value = true;
  try {
    const data = await api.get(`/api/wrongbook?includeCleared=${showCleared.value}`);
    items.value = data.items;
    openCount.value = data.openCount;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function redo() {
  error.value = '';
  try {
    const s = await api.post('/api/practice/sessions', { mode: 'REDO', count: 10 });
    router.push({ name: 'practice-session', params: { id: s.sessionId } });
  } catch (err) {
    error.value = err.message;
  }
}
</script>

<template>
  <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
    <div>
      <h1 class="text-xl font-semibold">錯題本</h1>
      <p class="text-sm" style="color: var(--text-muted)">
        待重做 {{ openCount }} 題 · 連續答對兩次自動清除
      </p>
    </div>
    <motion.button
      class="btn btn-primary" :disabled="openCount === 0"
      :while-hover="openCount ? { y: -1 } : {}" :while-press="openCount ? { scale: 0.97 } : {}"
      :transition="{ type: 'spring', visualDuration: 0.15, bounce: 0 }"
      @click="redo"
    >開始重做</motion.button>
  </div>

  <label class="mb-4 flex cursor-pointer items-center gap-2 text-sm" style="color: var(--text-muted)">
    <input v-model="showCleared" type="checkbox" class="accent-current" @change="load" />
    顯示已清除的題目
  </label>

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

  <motion.div
    v-else-if="items.length === 0"
    :initial="{ opacity: 0, scale: 0.98 }" :animate="{ opacity: 1, scale: 1 }"
    :transition="{ duration: 0.25, ease: 'easeOut' }"
    class="card p-12 text-center"
  >
    <div class="mb-2 text-2xl">🎉</div>
    <p class="text-sm" style="color: var(--text-muted)">目前沒有待重做的錯題</p>
  </motion.div>

  <div v-else class="space-y-2.5">
    <AnimatePresence :initial="false">
      <motion.article
        v-for="(item, i) in items" :key="item.questionId"
        class="card card-interactive p-4"
        :initial="{ opacity: 0, y: 10 }"
        :animate="{ opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut', delay: i * 0.025 } }"
        :exit="{ opacity: 0, x: -12, transition: { duration: 0.15, ease: 'easeIn' } }"
        :while-hover="{ y: -2 }"
        layout
      >
        <div class="flex items-start justify-between gap-3">
          <p class="line-clamp-2 flex-1 whitespace-pre-line text-sm leading-relaxed">
            {{ item.preview }}
          </p>
          <span
            class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
            :style="item.clearedAt
              ? { background: 'var(--success-soft)', color: 'var(--success)' }
              : { background: 'var(--danger-soft)', color: 'var(--danger)' }"
          >
            {{ item.clearedAt ? '已清除' : `錯 ${item.wrongCount} 次` }}
          </span>
        </div>

        <div class="mt-2 flex flex-wrap items-center gap-2 text-[11px]" style="color: var(--text-subtle)">
          <span v-if="item.source">{{ item.source }} {{ item.examYear }}</span>
          <span v-if="!item.clearedAt && item.correctStreak > 0" style="color: var(--success)">
            已連續答對 {{ item.correctStreak }} 次
          </span>
        </div>
      </motion.article>
    </AnimatePresence>
  </div>
</template>
