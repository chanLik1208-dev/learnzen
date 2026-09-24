<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const classes = ref([]);
const classId = ref('');
const available = ref(false);
const disabledReason = ref('');
const aliases = ref({});
const reports = ref([]);
const loading = ref(true);
const generating = ref(false);
const error = ref('');
const expanded = ref(null);
const facts = ref(null);

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
    const data = await api.get(`/api/teacher/classes/${id}/ai-reports`);
    available.value = data.available;
    disabledReason.value = data.disabledReason ?? '';
    aliases.value = data.aliases;
    reports.value = data.reports;
    error.value = '';
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}, { immediate: true });

async function generate() {
  if (generating.value) return;
  generating.value = true;
  error.value = '';
  try {
    const res = await api.post(`/api/teacher/classes/${classId.value}/ai-report`);
    reports.value = [{ ...res.report, author: '你' }, ...reports.value];
    expanded.value = res.report.id;
  } catch (err) {
    error.value = err.message;
  } finally {
    generating.value = false;
  }
}

async function showFacts(id) {
  facts.value = null;
  try {
    facts.value = await api.get(`/api/teacher/ai-reports/${id}/facts`);
  } catch (err) {
    error.value = err.message;
  }
}

/**
 * The model only ever saw 學生1, 學生2… so the text comes back using them.
 * The names are put back here, where they never left.
 */
function withNames(text) {
  return text.replace(/學生(\d+)/g, (match) => aliases.value[match] ?? match);
}

const fmt = (ms) => new Date(ms).toLocaleString('zh-HK',
  { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const currentClass = computed(() => classes.value.find((c) => c.id === classId.value));
</script>

<template>
  <h1 class="mb-1 text-xl font-semibold">AI 報告</h1>
  <p class="mb-5 text-sm" style="color: var(--text-muted)">
    根據班級的作答數據，產生一份可以直接讀的文字分析
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

    <motion.button
      class="btn btn-primary" :disabled="!available || generating || !classId"
      :while-press="available && !generating ? { scale: 0.97 } : {}"
      :transition="{ type: 'spring', visualDuration: 0.12, bounce: 0 }"
      @click="generate"
    >{{ generating ? '產生中…（約半分鐘）' : '產生報告' }}</motion.button>

    <span v-if="!available" class="text-[12px]" style="color: var(--text-subtle)">
      {{ disabledReason }}
    </span>
  </div>

  <!-- What actually leaves, said before anyone presses the button rather than
       buried in a policy nobody reads. -->
  <div class="mb-5 rounded-xl p-4" style="background: var(--bg)">
    <div class="mb-1 text-xs font-semibold" style="color: var(--text-muted)">會送出什麼</div>
    <p class="text-[13px] leading-relaxed" style="color: var(--text-muted)">
      送出的是課題正確率、作答題數、最常錯的題目這類數字，
      <strong style="color: var(--text)">學生一律以「學生1、學生2」代號出現</strong>，
      真實姓名不會離開這台伺服器——報告產生後才在這裡對映回名字。
      班別名稱（{{ currentClass?.name ?? '—' }}）會一起送出。
    </p>
  </div>

  <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <motion.div
    v-else-if="reports.length === 0"
    :initial="{ opacity: 0, scale: 0.98 }" :animate="{ opacity: 1, scale: 1 }"
    :transition="{ duration: 0.25, ease: 'easeOut' }"
    class="card p-12 text-center"
  >
    <p class="text-sm" style="color: var(--text-muted)">
      {{ available ? '還沒有產生過報告' : '設定 LB_AI_KEY 後就能使用' }}
    </p>
  </motion.div>

  <div v-else class="space-y-3">
    <AnimatePresence :initial="false">
      <motion.article
        v-for="(r, i) in reports" :key="r.id"
        class="card p-5"
        :initial="{ opacity: 0, y: 10 }"
        :animate="{ opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut', delay: i * 0.03 } }"
        :exit="{ opacity: 0, transition: { duration: 0.15 } }"
        layout
      >
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <span style="color: var(--text-subtle)">
            {{ fmt(r.createdAt) }} · {{ r.author }} · {{ r.model }}
          </span>
          <div class="flex gap-2">
            <button class="hover:underline" style="color: var(--text-subtle)"
                    @click="expanded = expanded === r.id ? null : r.id; facts = null">
              {{ expanded === r.id ? '收起' : '展開' }}
            </button>
            <!-- A generated claim is worth only as much as the figures behind
                 it, so those are one click away rather than taken on faith. -->
            <button class="hover:underline" style="color: var(--primary-text)"
                    @click="expanded = r.id; showFacts(r.id)">看原始數據</button>
          </div>
        </div>

        <p
          class="whitespace-pre-line leading-relaxed"
          :class="expanded === r.id ? 'text-[14px]' : 'line-clamp-3 text-[13.5px]'"
        >{{ withNames(r.content) }}</p>

        <AnimatePresence>
          <motion.div
            v-if="expanded === r.id && facts" key="facts"
            :initial="{ opacity: 0, height: 0 }"
            :animate="{ opacity: 1, height: 'auto', transition: { duration: 0.26, ease: 'easeOut' } }"
            :exit="{ opacity: 0, height: 0, transition: { duration: 0.15, ease: 'easeIn' } }"
            class="overflow-hidden"
          >
            <div class="mt-4 rounded-xl p-4" style="background: var(--bg)">
              <div class="mb-2 text-xs font-semibold" style="color: var(--text-muted)">
                產生這份報告時送出的數據
              </div>
              <pre class="max-h-72 overflow-auto whitespace-pre-wrap text-[11.5px] leading-relaxed"
                   style="color: var(--text-muted)">{{ JSON.stringify(facts.facts, null, 2) }}</pre>
            </div>
          </motion.div>
        </AnimatePresence>

        <div v-if="r.usage?.outputTokens" class="mt-3 text-[11px]" style="color: var(--text-subtle)">
          用量：輸入 {{ r.usage.inputTokens ?? '—' }} / 輸出 {{ r.usage.outputTokens }} tokens
        </div>
      </motion.article>
    </AnimatePresence>
  </div>
</template>
