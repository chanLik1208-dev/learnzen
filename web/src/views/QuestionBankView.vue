<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const LABELS = ['A', 'B', 'C', 'D'];
const DIFFICULTY = [
  ['EASY', '容易'], ['EASY_MEDIUM', '偏易'], ['MEDIUM', '中等'],
  ['MEDIUM_HARD', '偏難'], ['HARD', '困難'],
];
const STATUS = {
  ACTIVE: { label: '已啟用', tone: 'var(--success)', soft: 'var(--success-soft)' },
  DRAFT: { label: '草稿', tone: 'var(--warning)', soft: 'var(--warning-soft)' },
  RETIRED: { label: '已停用', tone: 'var(--text-disabled)', soft: 'var(--bg)' },
};

const questions = ref([]);
const topics = ref([]);
const total = ref(0);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const busy = ref(false);

const filters = ref({ q: '', topicId: '', status: '' });
/** Null when browsing; an object while writing or editing one. */
const editing = ref(null);

const blank = () => ({
  id: null,
  contentZh: '',
  explanationZh: '',
  topicId: topics.value[0]?.id ?? '',
  difficulty: 'MEDIUM',
  source: '',
  examYear: '',
  status: 'DRAFT',
  options: LABELS.map((label) => ({ label, contentZh: '', isCorrect: false })),
});

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ limit: '50' });
    for (const [k, v] of Object.entries(filters.value)) if (v) params.set(k, v);
    const [q, t] = await Promise.all([
      api.get(`/api/teacher/questions?${params}`),
      api.get('/api/topics'),
    ]);
    questions.value = q.questions;
    total.value = q.total;
    topics.value = t.topics;
    error.value = '';
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(filters, load, { deep: true });

const topicName = (id) => topics.value.find((t) => t.id === id)?.nameZh ?? '未分類';

const filled = computed(() => (editing.value?.options ?? []).filter((o) => o.contentZh.trim()));
const hasKey = computed(() => filled.value.some((o) => o.isCorrect));
const canSave = computed(() => editing.value?.contentZh.trim()
  && filled.value.length >= 2 && hasKey.value);

function startNew() {
  editing.value = blank();
}

function startEdit(q) {
  editing.value = {
    id: q.id,
    contentZh: q.content,
    explanationZh: q.explanation ?? '',
    topicId: q.topicId ?? '',
    difficulty: q.difficulty ?? 'MEDIUM',
    source: q.source ?? '',
    examYear: q.examYear ?? '',
    status: q.status,
    options: LABELS.map((label) => {
      const found = q.options.find((o) => o.label === label);
      return { label, contentZh: found?.content ?? '', isCorrect: found?.isCorrect ?? false };
    }),
  };
}

function pickCorrect(label) {
  for (const o of editing.value.options) o.isCorrect = o.label === label;
}

async function save() {
  if (!canSave.value || busy.value) return;
  busy.value = true;
  error.value = '';
  const e = editing.value;
  const payload = {
    contentZh: e.contentZh.trim(),
    explanationZh: e.explanationZh.trim() || null,
    topicId: e.topicId || null,
    difficulty: e.difficulty,
    source: e.source.trim() || null,
    examYear: e.examYear.trim() || null,
  };
  try {
    if (e.id == null) {
      // New: the options go in with it, and it starts as a draft so nothing
      // reaches a student before someone has looked at it.
      const res = await api.post('/api/teacher/questions', {
        ...payload, options: filled.value, status: 'DRAFT',
      });
      notice.value = `已建立題目 #${res.question.id}，狀態為草稿`;
    } else {
      // Editing: text and options are separate calls because only the options
      // endpoint can make a question servable.
      await api.patch(`/api/teacher/questions/${e.id}`, payload);
      await api.put(`/api/teacher/questions/${e.id}/options`, { options: filled.value });
      notice.value = `已更新題目 #${e.id}`;
    }
    editing.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function setStatus(q, status) {
  try {
    await api.patch(`/api/teacher/questions/${q.id}`, { status });
    notice.value = `題目 #${q.id} → ${STATUS[status].label}`;
    await load();
  } catch (err) {
    error.value = err.message;
  }
}
</script>

<template>
  <div class="mb-5 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-xl font-semibold">題庫</h1>
      <p class="text-sm" style="color: var(--text-muted)">共 {{ total }} 題</p>
    </div>
    <div class="flex gap-2">
      <RouterLink :to="{ name: 'fill-drafts' }" class="btn btn-ghost">批次補選項</RouterLink>
      <button class="btn btn-primary" @click="startNew">新增題目</button>
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
    <motion.p
      v-else-if="notice" key="ok"
      :initial="{ opacity: 0, height: 0 }" :animate="{ opacity: 1, height: 'auto' }"
      :exit="{ opacity: 0, height: 0 }"
      class="mb-4 overflow-hidden rounded-lg px-3 py-2 text-sm"
      style="background: var(--success-soft); color: var(--success)"
    >{{ notice }}</motion.p>
  </AnimatePresence>

  <div class="mb-4 flex flex-wrap gap-2">
    <input v-model="filters.q" class="field !w-auto flex-1" placeholder="搜尋題幹…" />
    <select v-model="filters.topicId" class="field !w-auto">
      <option value="">全部課題</option>
      <option v-for="t in topics" :key="t.id" :value="t.id">{{ t.nameZh }}</option>
    </select>
    <select v-model="filters.status" class="field !w-auto">
      <option value="">全部狀態</option>
      <option value="ACTIVE">已啟用</option>
      <option value="DRAFT">草稿</option>
    </select>
  </div>

  <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <div v-else-if="questions.length === 0" class="card p-10 text-center text-sm"
       style="color: var(--text-muted)">沒有符合的題目</div>

  <div v-else class="space-y-2">
    <motion.article
      v-for="(q, i) in questions" :key="q.id"
      class="card card-interactive p-4"
      :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.2, ease: 'easeOut', delay: Math.min(i, 20) * 0.02 }"
      :while-hover="{ y: -2 }"
      layout
    >
      <div class="mb-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span class="rounded-full px-2 py-0.5 font-semibold"
              :style="{ background: STATUS[q.status].soft, color: STATUS[q.status].tone }">
          {{ STATUS[q.status].label }}
        </span>
        <span class="rounded px-1.5 py-0.5" style="background: var(--bg); color: var(--text-muted)">
          #{{ q.id }}
        </span>
        <span class="rounded px-1.5 py-0.5" style="background: var(--bg); color: var(--text-muted)">
          {{ topicName(q.topicId) }}
        </span>
        <span v-if="q.source" class="rounded px-1.5 py-0.5"
              style="background: var(--primary-soft); color: var(--primary-text)">
          {{ q.source }} {{ q.examYear }}
        </span>
        <!-- No key means it cannot be graded, so it can never be served —
             worth saying on the card rather than only inside the editor. -->
        <span v-if="!q.correctLabels?.length" class="rounded px-1.5 py-0.5"
              style="background: var(--danger-soft); color: var(--danger)">
          缺正確答案
        </span>
        <span v-else class="rounded px-1.5 py-0.5"
              style="background: var(--success-soft); color: var(--success)">
          答案 {{ q.correctLabels.join('、') }}
        </span>
      </div>

      <p class="line-clamp-2 whitespace-pre-line text-[13.5px] leading-relaxed">{{ q.content }}</p>

      <div class="mt-3 flex flex-wrap gap-1.5">
        <button class="btn btn-ghost !px-2 !py-1 !text-[12px]" @click="startEdit(q)">編輯</button>
        <button v-if="q.status === 'DRAFT' && q.correctLabels?.length"
                class="btn btn-ghost !px-2 !py-1 !text-[12px]" @click="setStatus(q, 'ACTIVE')">啟用</button>
        <button v-if="q.status === 'ACTIVE'"
                class="btn btn-ghost !px-2 !py-1 !text-[12px]" @click="setStatus(q, 'RETIRED')">停用</button>
        <button v-if="q.status === 'RETIRED'"
                class="btn btn-ghost !px-2 !py-1 !text-[12px]" @click="setStatus(q, 'ACTIVE')">恢復</button>
      </div>
    </motion.article>
  </div>

  <!-- editor ───────────────────────────────────────────────────────── -->
  <AnimatePresence>
    <motion.div
      v-if="editing" key="editor"
      class="fixed inset-0 z-50 overflow-y-auto p-4"
      :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }"
      :transition="{ duration: 0.18 }"
      style="background: rgb(0 0 0 / 0.45)"
      @click.self="editing = null"
    >
      <motion.div
        class="card mx-auto my-4 w-full max-w-2xl p-6"
        style="box-shadow: var(--shadow-4)"
        :initial="{ scale: 0.97, y: 10 }" :animate="{ scale: 1, y: 0 }" :exit="{ scale: 0.98, opacity: 0 }"
        :transition="{ type: 'spring', visualDuration: 0.28, bounce: 0 }"
      >
        <h2 class="mb-4 text-base font-semibold">
          {{ editing.id == null ? '新增題目' : `編輯題目 #${editing.id}` }}
        </h2>

        <div class="space-y-3">
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">題幹</span>
            <textarea v-model="editing.contentZh" class="field" rows="4"
                      placeholder="可以換行，學生端會照樣顯示"></textarea>
          </label>

          <div class="grid gap-3 sm:grid-cols-4">
            <label class="block">
              <span class="mb-1 block text-xs" style="color: var(--text-muted)">課題</span>
              <select v-model="editing.topicId" class="field">
                <option value="">未分類</option>
                <option v-for="t in topics" :key="t.id" :value="t.id">{{ t.nameZh }}</option>
              </select>
            </label>
            <label class="block">
              <span class="mb-1 block text-xs" style="color: var(--text-muted)">難度</span>
              <select v-model="editing.difficulty" class="field">
                <option v-for="[v, l] in DIFFICULTY" :key="v" :value="v">{{ l }}</option>
              </select>
            </label>
            <label class="block">
              <span class="mb-1 block text-xs" style="color: var(--text-muted)">來源</span>
              <input v-model="editing.source" class="field" placeholder="DSE" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs" style="color: var(--text-muted)">年份</span>
              <input v-model="editing.examYear" class="field" placeholder="2026" />
            </label>
          </div>

          <div>
            <span class="mb-1.5 block text-xs" style="color: var(--text-muted)">
              選項（點左邊字母設為正確答案，留白的選項不會儲存）
            </span>
            <div class="space-y-2">
              <div v-for="option in editing.options" :key="option.label" class="flex items-center gap-2">
                <motion.button
                  type="button"
                  class="grid h-9 w-9 shrink-0 place-items-center rounded-lg border text-[13px] font-semibold"
                  :style="option.isCorrect
                    ? { background: 'var(--success-soft)', borderColor: 'var(--success)', color: 'var(--success)' }
                    : { background: 'var(--surface)', borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }"
                  :while-press="{ scale: 0.94 }"
                  :transition="{ type: 'spring', visualDuration: 0.12, bounce: 0 }"
                  @click="pickCorrect(option.label)"
                >{{ option.label }}</motion.button>
                <input v-model="option.contentZh" class="field" :placeholder="`選項 ${option.label}`" />
              </div>
            </div>
            <p v-if="filled.length >= 2 && !hasKey" class="mt-2 rounded-lg px-2.5 py-1.5 text-[11px]"
               style="background: var(--warning-soft); color: var(--warning)">
              還沒指定正確答案。沒有答案的題目會留在草稿，不會派給學生。
            </p>
          </div>

          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">詳解（選填）</span>
            <textarea v-model="editing.explanationZh" class="field" rows="3"></textarea>
          </label>
        </div>

        <div class="mt-5 flex justify-end gap-2">
          <button class="btn btn-ghost" @click="editing = null">取消</button>
          <button class="btn btn-primary" :disabled="!canSave || busy" @click="save">
            {{ busy ? '儲存中…' : '儲存' }}
          </button>
        </div>
      </motion.div>
    </motion.div>
  </AnimatePresence>
</template>
