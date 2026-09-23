<script setup>
import { onMounted, ref, watch } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const classes = ref([]);
const classId = ref('');
const topics = ref([]);
const loading = ref(true);
const error = ref('');
const pending = ref(new Set());

onMounted(async () => {
  try {
    classes.value = (await api.get('/api/teacher/classes')).classes;
    classId.value = classes.value[0]?.id ?? '';
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
});

watch(classId, async (id) => {
  if (!id) return;
  loading.value = true;
  try {
    topics.value = (await api.get(`/api/teacher/classes/${id}/topics`)).topics;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}, { immediate: true });

async function toggle(topic) {
  if (pending.value.has(topic.id)) return;
  const next = !topic.open;
  // Flip locally first so the switch responds immediately, and put it back if
  // the server disagrees — a switch that waits for a round trip feels broken.
  topic.open = next;
  topic.explicitlySet = true;
  pending.value = new Set(pending.value).add(topic.id);
  try {
    await api.put(`/api/teacher/classes/${classId.value}/topics/${topic.id}`, { open: next });
  } catch (err) {
    topic.open = !next;
    error.value = err.message;
  } finally {
    const copy = new Set(pending.value);
    copy.delete(topic.id);
    pending.value = copy;
  }
}
</script>

<template>
  <h1 class="mb-1 text-xl font-semibold">課題開關</h1>
  <p class="mb-5 text-sm" style="color: var(--text-muted)">
    關掉的課題，該班學生就練不到。沒設定過的課題預設是開的。
  </p>

  <AnimatePresence>
    <motion.p
      v-if="error" key="err"
      :initial="{ opacity: 0, height: 0 }" :animate="{ opacity: 1, height: 'auto' }"
      :exit="{ opacity: 0, height: 0 }"
      class="mb-4 overflow-hidden rounded-lg px-3 py-2 text-sm"
      style="background: var(--danger-soft); color: var(--danger)"
    >{{ error }}</motion.p>
  </AnimatePresence>

  <select v-model="classId" class="field mb-5 !w-auto">
    <option v-for="c in classes" :key="c.id" :value="c.id">{{ c.name }}</option>
  </select>

  <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <div v-else class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
    <motion.div
      v-for="(t, i) in topics" :key="t.id"
      class="card flex items-center justify-between p-4"
      :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.22, ease: 'easeOut', delay: Math.min(i, 20) * 0.02 }"
    >
      <div class="min-w-0">
        <div class="truncate text-sm font-medium"
             :style="{ color: t.open ? 'var(--text)' : 'var(--text-disabled)' }">
          {{ t.nameZh }}
        </div>
        <div class="text-[11px]" style="color: var(--text-subtle)">
          {{ t.questionCount }} 題可練
          <!-- Distinguishing a default from a decision matters: otherwise a
               teacher cannot tell "nobody configured this" from "someone
               closed it on purpose". -->
          <span v-if="!t.explicitlySet"> · 預設</span>
        </div>
      </div>

      <button
        type="button"
        class="relative h-6 w-11 shrink-0 rounded-full transition-colors duration-150"
        :style="{ background: t.open ? 'var(--success)' : 'var(--border-strong)' }"
        :aria-pressed="t.open"
        :aria-label="`${t.nameZh} ${t.open ? '開啟' : '關閉'}`"
        @click="toggle(t)"
      >
        <motion.span
          class="absolute top-0.5 block h-5 w-5 rounded-full bg-white"
          style="box-shadow: var(--shadow-1)"
          :initial="false"
          :animate="{ x: t.open ? 22 : 2 }"
          :transition="{ type: 'spring', visualDuration: 0.2, bounce: 0.2 }"
        />
      </button>
    </motion.div>
  </div>
</template>
