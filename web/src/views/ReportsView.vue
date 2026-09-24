<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const REASON = {
  WRONG_ANSWER: '正確答案有誤', AMBIGUOUS: '題目有歧義', TYPO: '錯字或排版',
  MISSING_FIGURE: '缺附圖', OTHER: '其他',
};
const STATUS = {
  OPEN: { label: '待處理', tone: 'var(--warning)', soft: 'var(--warning-soft)' },
  ACCEPTED: { label: '已受理', tone: 'var(--success)', soft: 'var(--success-soft)' },
  REJECTED: { label: '已駁回', tone: 'var(--text-muted)', soft: 'var(--bg)' },
};

const reports = ref([]);
const openCount = ref(0);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const filter = ref('OPEN');

/** The report currently being decided, with the note being written for it. */
const deciding = ref(null);
const resolution = ref('');
const accept = ref(true);
const busy = ref(false);

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams();
    if (filter.value) params.set('status', filter.value);
    const data = await api.get(`/api/teacher/reports?${params}`);
    reports.value = data.reports;
    openCount.value = data.openCount;
    error.value = '';
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(filter, load);

function open(report, isAccept) {
  deciding.value = report;
  accept.value = isAccept;
  resolution.value = '';
}

async function resolve() {
  if (!resolution.value.trim() || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const res = await api.post(`/api/teacher/reports/${deciding.value.id}/resolve`, {
      accept: accept.value, resolution: resolution.value.trim(),
    });
    notice.value = res.questionRetired
      ? `已受理，題目 #${deciding.value.questionId} 已下架，不會再派給學生`
      : '已駁回，題目維持原狀';
    deciding.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

const fmt = (ms) => new Date(ms).toLocaleString('zh-HK',
  { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const title = computed(() => (accept.value ? '受理這則回報' : '駁回這則回報'));
</script>

<template>
  <div class="mb-5 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-xl font-semibold">爭議審核</h1>
      <p class="text-sm" style="color: var(--text-muted)">
        學生對題目提出的疑問。<template v-if="openCount">目前 {{ openCount }} 則待處理。</template>
      </p>
    </div>
    <select v-model="filter" class="field !w-auto">
      <option value="OPEN">待處理</option>
      <option value="ACCEPTED">已受理</option>
      <option value="REJECTED">已駁回</option>
      <option value="">全部</option>
    </select>
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

  <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <motion.div
    v-else-if="reports.length === 0"
    :initial="{ opacity: 0, scale: 0.98 }" :animate="{ opacity: 1, scale: 1 }"
    :transition="{ duration: 0.25, ease: 'easeOut' }"
    class="card p-12 text-center"
  >
    <div class="mb-2 text-2xl">✅</div>
    <p class="text-sm" style="color: var(--text-muted)">
      {{ filter === 'OPEN' ? '沒有待處理的回報' : '這個分類沒有紀錄' }}
    </p>
  </motion.div>

  <div v-else class="space-y-3">
    <AnimatePresence :initial="false">
      <motion.article
        v-for="(r, i) in reports" :key="r.id"
        class="card p-5"
        :initial="{ opacity: 0, y: 10 }"
        :animate="{ opacity: 1, y: 0, transition: { duration: 0.22, ease: 'easeOut', delay: i * 0.03 } }"
        :exit="{ opacity: 0, x: -12, transition: { duration: 0.15, ease: 'easeIn' } }"
        layout
      >
        <div class="mb-3 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span class="rounded-full px-2 py-0.5 font-semibold"
                :style="{ background: STATUS[r.status].soft, color: STATUS[r.status].tone }">
            {{ STATUS[r.status].label }}
          </span>
          <span class="rounded px-1.5 py-0.5"
                style="background: var(--danger-soft); color: var(--danger)">
            {{ REASON[r.reason] }}
          </span>
          <span class="rounded px-1.5 py-0.5" style="background: var(--bg); color: var(--text-muted)">
            題目 #{{ r.questionId }}
          </span>
          <span v-if="r.questionStatus === 'RETIRED'" class="rounded px-1.5 py-0.5"
                style="background: var(--bg); color: var(--text-disabled)">已下架</span>
          <span style="color: var(--text-subtle)">
            {{ r.reporter }} · {{ fmt(r.createdAt) }}
          </span>
        </div>

        <p v-if="r.detail" class="mb-3 rounded-lg px-3 py-2 text-[13.5px] leading-relaxed"
           style="background: var(--bg)">{{ r.detail }}</p>

        <p class="mb-3 whitespace-pre-line text-[14px] leading-relaxed">{{ r.content }}</p>

        <!-- The key is shown because deciding "the answer is wrong" without
             seeing it is not possible. -->
        <div class="mb-3 space-y-1">
          <div
            v-for="o in r.options" :key="o.label"
            class="flex items-start gap-2 rounded-lg px-3 py-1.5 text-[13px]"
            :style="o.isCorrect
              ? { background: 'var(--success-soft)', color: 'var(--success)' }
              : { color: 'var(--text-muted)' }"
          >
            <span class="w-4 shrink-0 font-semibold">{{ o.label }}</span>
            <span>{{ o.content }}</span>
          </div>
        </div>

        <details v-if="r.explanation" class="mb-3">
          <summary class="cursor-pointer text-[12px]" style="color: var(--text-subtle)">詳解</summary>
          <p class="mt-1.5 whitespace-pre-line text-[13px] leading-relaxed" style="color: var(--text-muted)">
            {{ r.explanation }}
          </p>
        </details>

        <div v-if="r.status === 'OPEN'" class="flex justify-end gap-2">
          <button class="btn btn-ghost !py-1.5 !text-[13px]" @click="open(r, false)">駁回</button>
          <button class="btn btn-primary !py-1.5 !text-[13px]" @click="open(r, true)">受理並下架</button>
        </div>
        <div v-else class="rounded-lg px-3 py-2 text-[13px]" style="background: var(--bg)">
          <span style="color: var(--text-subtle)">{{ fmt(r.resolvedAt) }} 處理：</span>
          {{ r.resolution }}
        </div>
      </motion.article>
    </AnimatePresence>
  </div>

  <!-- decision ─────────────────────────────────────────────────────── -->
  <AnimatePresence>
    <motion.div
      v-if="deciding" key="decide"
      class="fixed inset-0 z-50 grid place-items-center p-4"
      :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }"
      :transition="{ duration: 0.18 }"
      style="background: rgb(0 0 0 / 0.45)"
      @click.self="deciding = null"
    >
      <motion.div
        class="card w-full max-w-lg p-6" style="box-shadow: var(--shadow-4)"
        :initial="{ scale: 0.97, y: 8 }" :animate="{ scale: 1, y: 0 }" :exit="{ scale: 0.98, opacity: 0 }"
        :transition="{ type: 'spring', visualDuration: 0.25, bounce: 0 }"
      >
        <h2 class="mb-1 text-base font-semibold">{{ title }}</h2>
        <p class="mb-4 text-[12px]" style="color: var(--text-subtle)">
          <template v-if="accept">
            受理會把題目 #{{ deciding.questionId }} 下架，之後不會再派給任何學生。
            已經作答過的成績維持不變。
          </template>
          <template v-else>駁回不會改動題目。</template>
          回報的學生會看到你寫的說明。
        </p>

        <textarea v-model="resolution" class="field" rows="3"
                  :placeholder="accept ? '例如：確認答案鍵標錯，已下架待修正' : '例如：題目沒有問題，(3) 的敘述在題目情境下不成立'"></textarea>

        <div class="mt-4 flex justify-end gap-2">
          <button class="btn btn-ghost" @click="deciding = null">取消</button>
          <button class="btn btn-primary" :disabled="!resolution.trim() || busy" @click="resolve">
            {{ busy ? '處理中…' : '確認' }}
          </button>
        </div>
      </motion.div>
    </motion.div>
  </AnimatePresence>
</template>
