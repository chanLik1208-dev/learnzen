<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const classes = ref([]);
const classId = ref('');
const students = ref([]);
const loading = ref(true);
const error = ref('');
const sortBy = ref('name');

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
    students.value = (await api.get(`/api/teacher/classes/${id}/students`)).students;
    error.value = '';
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}, { immediate: true });

/**
 * Students who have never answered anything sort last regardless of the
 * chosen order: a null accuracy is not a low score, and letting it fall in
 * among the genuine zeros would hide who simply has not started.
 */
const sorted = computed(() => [...students.value].sort((a, b) => {
  if (sortBy.value === 'accuracy') {
    if (a.accuracy === null && b.accuracy === null) return 0;
    if (a.accuracy === null) return 1;
    if (b.accuracy === null) return -1;
    return a.accuracy - b.accuracy;
  }
  if (sortBy.value === 'wrong') return b.openWrongCount - a.openWrongCount;
  return a.displayName.localeCompare(b.displayName, 'zh-HK');
}));

const started = computed(() => students.value.filter((s) => s.answered > 0));
const untouched = computed(() => students.value.filter((s) => s.answered === 0));

const pct = (n) => Math.round(n * 100);
</script>

<template>
  <h1 class="mb-1 text-xl font-semibold">班級學生</h1>
  <p class="mb-5 text-sm" style="color: var(--text-muted)">
    點名字看個別學習檔案
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

  <div class="mb-5 flex flex-wrap items-center gap-3">
    <select v-model="classId" class="field !w-auto">
      <option v-for="c in classes" :key="c.id" :value="c.id">
        {{ c.name }}（{{ c.studentCount }} 人）
      </option>
    </select>
    <select v-model="sortBy" class="field !w-auto">
      <option value="name">依姓名</option>
      <option value="accuracy">依正確率（低到高）</option>
      <option value="wrong">依待重做題數</option>
    </select>
  </div>

  <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <div v-else-if="students.length === 0" class="card p-10 text-center text-sm"
       style="color: var(--text-muted)">這個班別還沒有學生</div>

  <template v-else>
    <div class="mb-5 grid grid-cols-3 gap-3">
      <motion.div
        v-for="(s, i) in [
          { label: '學生', value: students.length },
          { label: '已開始練習', value: started.length },
          { label: '完全未開始', value: untouched.length, tone: untouched.length ? 'var(--warning)' : null },
        ]" :key="s.label"
        class="card p-4"
        :initial="{ opacity: 0, y: 10 }" :animate="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.25, ease: 'easeOut', delay: i * 0.04 }"
      >
        <div class="text-[11px]" style="color: var(--text-muted)">{{ s.label }}</div>
        <div class="mt-1 text-2xl font-bold tabular-nums" :style="{ color: s.tone ?? 'var(--text)' }">
          {{ s.value }}
        </div>
      </motion.div>
    </div>

    <div class="card divide-y p-0" style="border-color: var(--border)">
      <motion.div
        v-for="(s, i) in sorted" :key="s.id"
        class="flex flex-wrap items-center gap-3 px-4 py-3"
        :initial="{ opacity: 0, x: -8 }" :animate="{ opacity: 1, x: 0 }"
        :transition="{ duration: 0.2, ease: 'easeOut', delay: Math.min(i, 20) * 0.02 }"
        layout
      >
        <div class="min-w-0 flex-1">
          <RouterLink :to="{ name: 'student-profile', params: { id: s.id } }"
                      class="text-sm font-medium hover:underline">{{ s.displayName }}</RouterLink>
          <span class="ml-2 text-[11px]" style="color: var(--text-subtle)">{{ s.username }}</span>
        </div>

        <div class="w-32 shrink-0">
          <!-- Nothing attempted is stated in words; a zero-length bar would
               read as "answered everything wrong". -->
          <template v-if="s.accuracy === null">
            <span class="text-[12px]" style="color: var(--text-subtle)">未開始</span>
          </template>
          <template v-else>
            <div class="h-1.5 overflow-hidden rounded-full" style="background: var(--border)">
              <motion.div
                class="h-full origin-left rounded-full"
                :style="{ background: s.accuracy >= 0.6 ? 'var(--success)' : 'var(--danger)' }"
                :initial="{ scaleX: 0 }" :animate="{ scaleX: s.accuracy }"
                :transition="{ type: 'spring', visualDuration: 0.5, bounce: 0, delay: 0.1 + Math.min(i, 20) * 0.02 }"
              />
            </div>
            <div class="mt-0.5 text-[10px] tabular-nums" style="color: var(--text-subtle)">
              {{ pct(s.accuracy) }}% · {{ s.answered }} 題
            </div>
          </template>
        </div>

        <span
          class="w-20 shrink-0 text-right text-[12px] tabular-nums"
          :style="{ color: s.openWrongCount > 0 ? 'var(--danger)' : 'var(--text-subtle)' }"
        >
          待重做 {{ s.openWrongCount }}
        </span>
      </motion.div>
    </div>
  </template>
</template>
