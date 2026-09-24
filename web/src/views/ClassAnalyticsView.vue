<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const classes = ref([]);
const classId = ref('');
const data = ref(null);
const loading = ref(true);
const error = ref('');

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
  data.value = null;
  try {
    data.value = await api.get(`/api/teacher/classes/${id}/analytics`);
    error.value = '';
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}, { immediate: true });

const engaged = computed(() => (data.value?.roster ?? []).filter((r) => r.answered > 0));
const struggling = computed(() => [...engaged.value]
  .filter((r) => r.accuracy < 0.5)
  .sort((a, b) => a.accuracy - b.accuracy));
const quiet = computed(() => (data.value?.roster ?? [])
  .filter((r) => r.answered > 0 && r.activeDays === 0));

const topicsWithData = computed(() => (data.value?.topics ?? []).filter((t) => t.answered > 0));

const pct = (n) => Math.round(n * 100);
const tone = (a) => (a >= 0.7 ? 'var(--success)' : a >= 0.5 ? 'var(--warning)' : 'var(--danger)');
</script>

<template>
  <h1 class="mb-1 text-xl font-semibold">學情分析</h1>
  <p class="mb-5 text-sm" style="color: var(--text-muted)">整班的掌握情況，以及最值得花一節課講的題目</p>

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
    <option v-for="c in classes" :key="c.id" :value="c.id">
      {{ c.name }}（{{ c.studentCount }} 人）
    </option>
  </select>

  <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <template v-else-if="data">
    <div class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <motion.div
        v-for="(s, i) in [
          { label: '學生', value: data.studentCount, unit: ' 人' },
          { label: '有在練習', value: engaged.length, unit: ' 人' },
          { label: '整班正確率',
            value: data.classAccuracy === null ? null : `${pct(data.classAccuracy)}%`,
            tone: data.classAccuracy === null ? null : tone(data.classAccuracy) },
          { label: '從未開始', value: data.notStarted.length, unit: ' 人',
            tone: data.notStarted.length ? 'var(--warning)' : null },
        ]" :key="s.label"
        class="card p-4"
        :initial="{ opacity: 0, y: 10 }" :animate="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.25, ease: 'easeOut', delay: i * 0.04 }"
      >
        <div class="text-[11px]" style="color: var(--text-muted)">{{ s.label }}</div>
        <div class="mt-1 text-2xl font-bold tabular-nums" :style="{ color: s.tone ?? 'var(--text)' }">
          <span v-if="s.value === null" class="text-sm font-normal" style="color: var(--text-subtle)">
            尚無資料
          </span>
          <template v-else>{{ s.value }}<span class="text-sm font-medium">{{ s.unit ?? '' }}</span></template>
        </div>
      </motion.div>
    </div>

    <!-- People, named. A count alone is not actionable. -->
    <section v-if="data.notStarted.length" class="mb-6">
      <div class="card p-4" style="border-color: var(--warning)">
        <h2 class="mb-1 text-sm font-semibold" style="color: var(--warning)">
          還沒開始練習的 {{ data.notStarted.length }} 人
        </h2>
        <p class="text-[13px]" style="color: var(--text-muted)">{{ data.notStarted.join('、') }}</p>
      </div>
    </section>

    <section v-if="data.hotspots.length" class="mb-6">
      <h2 class="mb-1 text-base font-semibold">最該講的題目</h2>
      <p class="mb-2.5 text-[12px]" style="color: var(--text-subtle)">
        至少兩位學生做過、全班正確率低於一半的題目。旁邊是公開答對率，落差大的最值得講。
      </p>
      <div class="space-y-2">
        <motion.div
          v-for="(h, i) in data.hotspots" :key="h.questionId"
          class="card p-4"
          :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.22, ease: 'easeOut', delay: i * 0.03 }"
        >
          <p class="line-clamp-2 whitespace-pre-line text-[13.5px] leading-relaxed">{{ h.preview }}</p>
          <div class="mt-2 flex flex-wrap items-center gap-3 text-[12px]">
            <span class="font-semibold tabular-nums" style="color: var(--danger)">
              本班 {{ pct(h.classAccuracy) }}%
            </span>
            <span v-if="h.officialCorrectRate != null" class="tabular-nums"
                  style="color: var(--text-subtle)">
              公開 {{ Math.round(h.officialCorrectRate) }}%
            </span>
            <span style="color: var(--text-subtle)">{{ h.students }} 人做過</span>
          </div>
        </motion.div>
      </div>
    </section>

    <section v-if="topicsWithData.length" class="mb-6">
      <h2 class="mb-2.5 text-base font-semibold">各課題</h2>
      <div class="card divide-y p-0" style="border-color: var(--border)">
        <motion.div
          v-for="(t, i) in topicsWithData" :key="t.topicId"
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
          <span class="w-32 text-right text-[12px] tabular-nums" style="color: var(--text-muted)">
            {{ pct(t.accuracy) }}% · {{ t.studentsAttempted }} 人做過
          </span>
        </motion.div>
      </div>
    </section>

    <section v-if="struggling.length">
      <h2 class="mb-2.5 text-base font-semibold">正確率低於一半的學生</h2>
      <div class="card divide-y p-0" style="border-color: var(--border)">
        <div v-for="r in struggling" :key="r.studentId"
             class="flex items-center justify-between px-4 py-3">
          <RouterLink :to="{ name: 'student-profile', params: { id: r.studentId } }"
                      class="text-sm hover:underline">{{ r.displayName }}</RouterLink>
          <div class="flex items-center gap-4 text-[12px] tabular-nums">
            <span :style="{ color: tone(r.accuracy) }">{{ pct(r.accuracy) }}%</span>
            <span style="color: var(--text-muted)">{{ r.answered }} 題</span>
            <span :style="{ color: r.openWrong ? 'var(--danger)' : 'var(--text-subtle)' }">
              待重做 {{ r.openWrong }}
            </span>
          </div>
        </div>
      </div>

      <!-- "Has practised, but not in the last four weeks" is a different
           problem from "never started", and gets lost if they are merged. -->
      <p v-if="quiet.length" class="mt-2.5 rounded-lg px-3 py-2 text-[12px]"
         style="background: var(--bg); color: var(--text-muted)">
        近四週沒有作答記錄：{{ quiet.map((r) => r.displayName).join('、') }}
      </p>
    </section>
  </template>
</template>
