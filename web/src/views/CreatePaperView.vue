<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const router = useRouter();

const classes = ref([]);
const topics = ref([]);
const bank = ref([]);
const bankTotal = ref(0);
const loadingBank = ref(false);
const error = ref('');
const creating = ref(false);

const filters = ref({ topicId: '', q: '', examYear: '' });
/** Chosen questions, in the order they will appear on the paper. */
const picked = ref([]);

const paper = ref({
  title: '',
  code: '',
  classId: '',
  kind: 'HOMEWORK',
  dueAt: '',
  timeLimitMinutes: '',
  maxAttempts: 1,
  scoreStrategy: 'LAST',
  reveal: 'AFTER_SUBMIT',
  shuffle: false,
  allowLate: false,
  pointsPerQuestion: 1,
});

const pickedIds = computed(() => new Set(picked.value.map((q) => q.id)));
const maxScore = computed(() => picked.value.length * Number(paper.value.pointsPerQuestion || 1));
const ready = computed(() => paper.value.title.trim() && paper.value.classId && picked.value.length > 0);

onMounted(async () => {
  const [c, t] = await Promise.allSettled([api.get('/api/teacher/classes'), api.get('/api/topics')]);
  if (c.status === 'fulfilled') {
    classes.value = c.value.classes;
    if (classes.value.length === 1) paper.value.classId = classes.value[0].id;
  }
  if (t.status === 'fulfilled') topics.value = t.value.topics;
  loadBank();
});

async function loadBank() {
  loadingBank.value = true;
  try {
    // ACTIVE only: a draft has no answer key, so it cannot be graded and must
    // not reach a paper.
    const params = new URLSearchParams({ status: 'ACTIVE', limit: '50' });
    if (filters.value.topicId) params.set('topicId', filters.value.topicId);
    if (filters.value.q) params.set('q', filters.value.q);
    if (filters.value.examYear) params.set('examYear', filters.value.examYear);
    const data = await api.get(`/api/teacher/questions?${params}`);
    bank.value = data.questions;
    bankTotal.value = data.total;
  } catch (err) {
    error.value = err.message;
  } finally {
    loadingBank.value = false;
  }
}
watch(filters, loadBank, { deep: true });

function toggle(q) {
  picked.value = pickedIds.value.has(q.id)
    ? picked.value.filter((x) => x.id !== q.id)
    : [...picked.value, q];
}

function move(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= picked.value.length) return;
  const copy = [...picked.value];
  [copy[index], copy[next]] = [copy[next], copy[index]];
  picked.value = copy;
}

/**
 * A datetime-local value is wall-clock text with no zone. Converting through
 * Date here turns it into the epoch millisecond the server stores, so the
 * deadline means the same instant whatever timezone the browser is set to.
 */
const toEpoch = (local) => (local ? new Date(local).getTime() : null);

async function create(publish) {
  if (!ready.value || creating.value) return;
  creating.value = true;
  error.value = '';
  try {
    const { assignment } = await api.post('/api/teacher/assignments', {
      title: paper.value.title.trim(),
      code: paper.value.code.trim() || undefined,
      classId: Number(paper.value.classId),
      kind: paper.value.kind,
      dueAt: toEpoch(paper.value.dueAt),
      timeLimitSeconds: paper.value.timeLimitMinutes
        ? Number(paper.value.timeLimitMinutes) * 60 : null,
      maxAttempts: Number(paper.value.maxAttempts),
      scoreStrategy: paper.value.scoreStrategy,
      reveal: paper.value.reveal,
      shuffle: paper.value.shuffle,
      allowLate: paper.value.allowLate,
      pointsPerQuestion: Number(paper.value.pointsPerQuestion),
      questionIds: picked.value.map((q) => q.id),
    });
    if (publish) await api.post(`/api/teacher/assignments/${assignment.id}/publish`);
    router.push({ name: 'scores', query: { id: assignment.id } });
  } catch (err) {
    error.value = err.message;
  } finally {
    creating.value = false;
  }
}

const topicName = (id) => topics.value.find((t) => t.id === id)?.nameZh ?? '—';
</script>

<template>
  <h1 class="mb-1 text-xl font-semibold">組卷</h1>
  <p class="mb-5 text-sm" style="color: var(--text-muted)">
    從題庫挑題，設定規則後發佈給班別
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

  <div class="grid gap-4 lg:grid-cols-[1fr_22rem]">
    <!-- bank ─────────────────────────────────────────────────────────── -->
    <section class="card p-5">
      <div class="mb-4 flex flex-wrap gap-2">
        <input v-model="filters.q" class="field !w-auto flex-1" placeholder="搜尋題幹…" />
        <select v-model="filters.topicId" class="field !w-auto">
          <option value="">全部課題</option>
          <option v-for="t in topics" :key="t.id" :value="t.id">{{ t.nameZh }}</option>
        </select>
      </div>

      <p class="mb-3 text-xs" style="color: var(--text-subtle)">
        可用題目 {{ bankTotal }} 題（只顯示已有答案的）
      </p>

      <div v-if="loadingBank" class="py-12 text-center text-sm" style="color: var(--text-muted)">
        載入中…
      </div>
      <div v-else-if="bank.length === 0" class="py-12 text-center text-sm" style="color: var(--text-muted)">
        沒有符合的題目。題庫裡多數題目還缺選項，先去「補齊題目」。
      </div>

      <div v-else class="space-y-2">
        <motion.button
          v-for="q in bank" :key="q.id"
          type="button"
          class="flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left"
          :style="pickedIds.has(q.id)
            ? { background: 'var(--primary-soft)', borderColor: 'var(--primary)' }
            : { background: 'var(--surface)', borderColor: 'var(--border)' }"
          :while-hover="{ y: -2 }"
          :while-press="{ scale: 0.99 }"
          :transition="{ type: 'spring', visualDuration: 0.18, bounce: 0 }"
          @click="toggle(q)"
        >
          <span
            class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border text-[11px]"
            :style="pickedIds.has(q.id)
              ? { background: 'var(--primary)', borderColor: 'var(--primary)', color: '#fff' }
              : { borderColor: 'var(--border-strong)' }"
          >{{ pickedIds.has(q.id) ? '✓' : '' }}</span>

          <span class="min-w-0 flex-1">
            <span class="mb-1 flex flex-wrap gap-1.5 text-[10px]">
              <span class="rounded px-1.5 py-0.5"
                    style="background: var(--bg); color: var(--text-muted)">
                {{ q.source }} {{ q.examYear }}
              </span>
              <span class="rounded px-1.5 py-0.5"
                    style="background: var(--bg); color: var(--text-muted)">
                {{ topicName(q.topicId) }}
              </span>
              <span class="rounded px-1.5 py-0.5"
                    style="background: var(--success-soft); color: var(--success)">
                答案 {{ q.correctLabels?.join('、') }}
              </span>
            </span>
            <span class="line-clamp-2 block whitespace-pre-line text-[13.5px] leading-relaxed">
              {{ q.content }}
            </span>
          </span>
        </motion.button>
      </div>
    </section>

    <!-- paper ────────────────────────────────────────────────────────── -->
    <aside class="space-y-4">
      <section class="card p-5">
        <h2 class="mb-3 text-sm font-semibold">
          已選 {{ picked.length }} 題 · 滿分 {{ maxScore }}
        </h2>

        <div v-if="picked.length === 0" class="rounded-lg p-4 text-center text-[13px]"
             style="background: var(--bg); color: var(--text-subtle)">
          左邊點題目加入
        </div>

        <div v-else class="max-h-64 space-y-1.5 overflow-y-auto">
          <!-- `layout` lets a reordered row slide to its new position instead
               of teleporting, so the move stays legible. -->
          <motion.div
            v-for="(q, i) in picked" :key="q.id"
            layout
            :transition="{ type: 'spring', visualDuration: 0.25, bounce: 0 }"
            class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px]"
            style="background: var(--bg)"
          >
            <span class="w-5 shrink-0 tabular-nums" style="color: var(--text-subtle)">{{ i + 1 }}</span>
            <span class="line-clamp-1 flex-1">{{ q.content }}</span>
            <button class="px-1" style="color: var(--text-subtle)" :disabled="i === 0"
                    @click="move(i, -1)">↑</button>
            <button class="px-1" style="color: var(--text-subtle)"
                    :disabled="i === picked.length - 1" @click="move(i, 1)">↓</button>
            <button class="px-1" style="color: var(--danger)" @click="toggle(q)">×</button>
          </motion.div>
        </div>
      </section>

      <section class="card space-y-3 p-5">
        <h2 class="text-sm font-semibold">卷面設定</h2>

        <label class="block">
          <span class="mb-1 block text-xs" style="color: var(--text-muted)">標題</span>
          <input v-model="paper.title" class="field" placeholder="例如 A-CH2-HW1" />
        </label>

        <label class="block">
          <span class="mb-1 block text-xs" style="color: var(--text-muted)">班別</span>
          <select v-model="paper.classId" class="field">
            <option value="">請選擇</option>
            <option v-for="c in classes" :key="c.id" :value="c.id">
              {{ c.name }}（{{ c.studentCount }} 人）
            </option>
          </select>
        </label>

        <div class="grid grid-cols-2 gap-2">
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">類型</span>
            <select v-model="paper.kind" class="field">
              <option value="HOMEWORK">作業</option>
              <option value="TEST">測驗</option>
            </select>
          </label>
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">每題分數</span>
            <input v-model="paper.pointsPerQuestion" type="number" min="0.5" step="0.5" class="field" />
          </label>
        </div>

        <label class="block">
          <span class="mb-1 block text-xs" style="color: var(--text-muted)">截止時間</span>
          <input v-model="paper.dueAt" type="datetime-local" class="field" />
        </label>

        <div class="grid grid-cols-2 gap-2">
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">限時（分鐘）</span>
            <input v-model="paper.timeLimitMinutes" type="number" min="1" class="field" placeholder="不限" />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">可作答次數</span>
            <input v-model="paper.maxAttempts" type="number" min="1" class="field" />
          </label>
        </div>

        <!-- Only meaningful with more than one attempt; the database refuses
             the contradictory combination, so the field disappears instead of
             offering a setting that would be rejected. -->
        <label v-if="Number(paper.maxAttempts) > 1" class="block">
          <span class="mb-1 block text-xs" style="color: var(--text-muted)">計分方式</span>
          <select v-model="paper.scoreStrategy" class="field">
            <option value="LAST">取最後一次</option>
            <option value="BEST">取最高分</option>
            <option value="FIRST">取第一次</option>
          </select>
        </label>

        <label class="block">
          <span class="mb-1 block text-xs" style="color: var(--text-muted)">何時公開答案</span>
          <select v-model="paper.reveal" class="field">
            <option value="AFTER_SUBMIT">交卷後立即</option>
            <option value="AFTER_DUE">截止後</option>
            <option value="NEVER">不公開</option>
          </select>
        </label>
        <p v-if="paper.reveal === 'AFTER_DUE' && !paper.dueAt"
           class="rounded-lg px-2.5 py-1.5 text-[11px]"
           style="background: var(--warning-soft); color: var(--warning)">
          選「截止後公開」就必須設截止時間
        </p>

        <label class="flex items-center gap-2 text-[13px]" style="color: var(--text-muted)">
          <input v-model="paper.shuffle" type="checkbox" class="accent-current" /> 打亂題目順序
        </label>
        <label class="flex items-center gap-2 text-[13px]" style="color: var(--text-muted)">
          <input v-model="paper.allowLate" type="checkbox" class="accent-current" /> 允許遲交
        </label>

        <div class="flex gap-2 pt-1">
          <button class="btn btn-ghost flex-1" :disabled="!ready || creating" @click="create(false)">
            存為草稿
          </button>
          <motion.button
            class="btn btn-primary flex-1" :disabled="!ready || creating"
            :while-press="ready ? { scale: 0.97 } : {}"
            :transition="{ type: 'spring', visualDuration: 0.12, bounce: 0 }"
            @click="create(true)"
          >{{ creating ? '建立中…' : '發佈' }}</motion.button>
        </div>
      </section>
    </aside>
  </div>
</template>
