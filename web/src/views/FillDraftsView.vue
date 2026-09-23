<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const LABELS = ['A', 'B', 'C', 'D'];

const topics = ref([]);
const topicId = ref('');
const hintedOnly = ref(true);
const total = ref(0);
const hintedTotal = ref(0);
const queue = ref([]);
const current = ref(null);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const filledThisSession = ref(0);

/** One row per label, kept as a fixed-length array so labels never shift. */
const draft = ref(LABELS.map((label) => ({ label, contentZh: '', isCorrect: false })));
const inputs = ref([]);

const canSave = computed(() => draft.value.filter((o) => o.contentZh.trim()).length >= 2
  && draft.value.some((o) => o.isCorrect && o.contentZh.trim()));

async function loadTopics() {
  try {
    topics.value = (await api.get('/api/topics')).topics;
  } catch { /* the filter is optional */ }
}

async function loadQueue() {
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams({ limit: '20' });
    if (topicId.value) params.set('topicId', topicId.value);
    if (hintedOnly.value) params.set('hinted', 'true');
    const data = await api.get(`/api/teacher/questions/drafts?${params}`);
    total.value = data.total;
    hintedTotal.value = data.hintedTotal;
    queue.value = data.questions;
    take();
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function take() {
  current.value = queue.value.shift() ?? null;
  if (!current.value) return;

  const existing = current.value.options;
  draft.value = LABELS.map((label, i) => ({
    label,
    contentZh: existing[i]?.contentZh ?? '',
    // Pre-select what the explanation implies. It is only a starting point —
    // the evidence is shown beside it so it can be overruled at a glance.
    isCorrect: existing[i]?.isCorrect ?? (current.value.suggestedAnswer === label),
  }));
  nextTick(() => inputs.value[0]?.focus());
}

function pickCorrect(label) {
  for (const o of draft.value) o.isCorrect = o.label === label;
}

async function save() {
  if (!canSave.value || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const res = await api.put(`/api/teacher/questions/${current.value.id}/options`, {
      options: draft.value.filter((o) => o.contentZh.trim()),
    });
    total.value = res.remainingDrafts;
    filledThisSession.value += 1;
    if (queue.value.length === 0) await loadQueue();
    else take();
  } catch (err) {
    error.value = err.message;
  } finally {
    saving.value = false;
  }
}

function skip() {
  if (queue.value.length === 0) loadQueue();
  else take();
}

/** Enter walks down the options; Ctrl/Cmd+Enter commits the whole question. */
function onKey(event, i) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    save();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    inputs.value[i + 1]?.focus();
  }
}

const shortcut = (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
};
onMounted(() => { loadTopics(); loadQueue(); window.addEventListener('keydown', shortcut); });
onUnmounted(() => window.removeEventListener('keydown', shortcut));
watch([topicId, hintedOnly], loadQueue);
</script>

<template>
  <div class="mb-5 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-xl font-semibold">補齊題目選項</h1>
      <p class="text-sm" style="color: var(--text-muted)">
        還有 <span class="font-semibold tabular-nums" style="color: var(--warning)">{{ total }}</span> 題缺選項
        <template v-if="filledThisSession">· 本次已補 {{ filledThisSession }} 題</template>
      </p>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <label class="flex cursor-pointer items-center gap-2 text-sm" style="color: var(--text-muted)">
        <input v-model="hintedOnly" type="checkbox" class="accent-current" />
        只做詳解已給答案的（{{ hintedTotal }} 題）
      </label>
      <select v-model="topicId" class="field !w-auto">
        <option value="">全部課題</option>
        <option v-for="t in topics" :key="t.id" :value="t.id">{{ t.nameZh }}</option>
      </select>
    </div>
  </div>

  <AnimatePresence>
    <motion.p
      v-if="error" key="err"
      :initial="{ opacity: 0, height: 0 }" :animate="{ opacity: 1, height: 'auto' }"
      :exit="{ opacity: 0, height: 0 }"
      class="mb-4 overflow-hidden rounded-lg px-3 py-2 text-sm"
      style="background: var(--danger-soft); color: var(--danger)"
    >{{ error }}</motion.p>
  </AnimatePresence>

  <div v-if="loading" class="py-20 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <!-- A failed load must not fall through to the success state: "nothing came
       back" and "there is nothing left to do" look identical on screen but
       mean opposite things, and only one of them is worth celebrating. -->
  <div v-else-if="error && !current" class="card p-12 text-center">
    <p class="mb-3 text-sm" style="color: var(--text-muted)">載入失敗，無法確認還有多少題待補</p>
    <button class="btn btn-ghost" @click="loadQueue">重試</button>
  </div>

  <motion.div
    v-else-if="!current"
    :initial="{ opacity: 0, scale: 0.98 }" :animate="{ opacity: 1, scale: 1 }"
    :transition="{ duration: 0.25, ease: 'easeOut' }"
    class="card p-12 text-center"
  >
    <div class="mb-2 text-2xl">✅</div>
    <p class="text-sm" style="color: var(--text-muted)">
      {{ topicId ? '這個課題沒有待補的題目了' : '所有題目都補齊了' }}
    </p>
  </motion.div>

  <AnimatePresence v-else mode="wait" :initial="false">
    <motion.div
      :key="current.id"
      :initial="{ opacity: 0, y: 12 }"
      :animate="{ opacity: 1, y: 0, transition: { type: 'spring', visualDuration: 0.28, bounce: 0 } }"
      :exit="{ opacity: 0, y: -8, transition: { duration: 0.14, ease: 'easeIn' } }"
      class="grid gap-4 lg:grid-cols-2"
    >
      <!-- reference ────────────────────────────────────────────────── -->
      <article class="card p-5">
        <div class="mb-3 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span class="rounded px-1.5 py-0.5" style="background: var(--primary-soft); color: var(--primary-text)">
            {{ current.source }} {{ current.examYear }}
          </span>
          <span class="rounded px-1.5 py-0.5" style="background: var(--bg); color: var(--text-muted)">
            #{{ current.id }}
          </span>
          <span v-if="current.figure" class="rounded px-1.5 py-0.5"
                style="background: var(--warning-soft); color: var(--warning)">
            此題有附圖（{{ current.figure }}）
          </span>
        </div>

        <p class="mb-4 whitespace-pre-line text-[15px] leading-relaxed">{{ current.content }}</p>

        <div class="rounded-xl p-4" style="background: var(--bg)">
          <div class="mb-1.5 text-xs font-semibold" style="color: var(--text-muted)">詳解</div>
          <p class="whitespace-pre-line text-[13.5px] leading-relaxed" style="color: var(--text-muted)">
            {{ current.explanation }}
          </p>
        </div>
      </article>

      <!-- entry ────────────────────────────────────────────────────── -->
      <div class="card p-5">
        <div v-if="current.suggestedAnswer" class="mb-4 rounded-lg px-3 py-2 text-[13px]"
             style="background: var(--success-soft); color: var(--success)">
          詳解指向 <strong>{{ current.suggestedAnswer }}</strong>，已預先選好
          <span v-if="current.suggestionEvidence" class="opacity-80">
            —— 「…{{ current.suggestionEvidence }}…」
          </span>
        </div>
        <div v-else class="mb-4 rounded-lg px-3 py-2 text-[13px]"
             style="background: var(--warning-soft); color: var(--warning)">
          詳解沒有明講答案，請自行判斷
        </div>

        <div class="space-y-2">
          <div v-for="(option, i) in draft" :key="option.label" class="flex items-center gap-2">
            <motion.button
              type="button"
              class="grid h-9 w-9 shrink-0 place-items-center rounded-lg border text-[13px] font-semibold"
              :style="option.isCorrect
                ? { background: 'var(--success-soft)', borderColor: 'var(--success)', color: 'var(--success)' }
                : { background: 'var(--surface)', borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }"
              :while-press="{ scale: 0.94 }"
              :transition="{ type: 'spring', visualDuration: 0.12, bounce: 0 }"
              :title="`把 ${option.label} 設為正確答案`"
              @click="pickCorrect(option.label)"
            >{{ option.label }}</motion.button>

            <input
              ref="inputs"
              v-model="option.contentZh"
              class="field"
              :placeholder="`選項 ${option.label} 的文字`"
              @keydown="(e) => onKey(e, i)"
            />
          </div>
        </div>

        <p class="mt-3 text-[11px]" style="color: var(--text-subtle)">
          點左邊的字母設定正確答案 · Enter 跳下一格 · Ctrl+Enter 儲存並下一題
        </p>

        <div class="mt-4 flex justify-between gap-2">
          <button class="btn btn-ghost" @click="skip">略過</button>
          <motion.button
            class="btn btn-primary" :disabled="!canSave || saving"
            :while-press="canSave ? { scale: 0.97 } : {}"
            :transition="{ type: 'spring', visualDuration: 0.12, bounce: 0 }"
            @click="save"
          >{{ saving ? '儲存中…' : '儲存並下一題' }}</motion.button>
        </div>
      </div>
    </motion.div>
  </AnimatePresence>
</template>
