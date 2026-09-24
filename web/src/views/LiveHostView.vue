<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api, currentToken } from '../lib/api.js';
import { openStream } from '../lib/sse.js';

const rooms = ref([]);
const classes = ref([]);
const bank = ref([]);
const loading = ref(true);
const error = ref('');
const connection = ref('idle');

/** Null when picking questions; the running room once started. */
const live = ref(null);
const monitor = ref(null);
const picked = ref([]);
const setup = ref({ title: '', classId: '', seconds: 30 });
const busy = ref(false);
const remaining = ref(null);

let stop = null;
let ticker = null;
let monitorTimer = null;
let drift = 0;

onMounted(async () => {
  const [r, c, q] = await Promise.allSettled([
    api.get('/api/teacher/live'),
    api.get('/api/teacher/classes'),
    api.get('/api/teacher/questions?status=ACTIVE&limit=50'),
  ]);
  if (r.status === 'fulfilled') rooms.value = r.value.sessions;
  if (c.status === 'fulfilled') {
    classes.value = c.value.classes;
    setup.value.classId = c.value.classes[0]?.id ?? '';
  }
  if (q.status === 'fulfilled') bank.value = q.value.questions;
  else error.value = q.reason.message;
  loading.value = false;
});

onUnmounted(() => { stop?.(); clearInterval(ticker); clearInterval(monitorTimer); });

const pickedIds = computed(() => new Set(picked.value.map((q) => q.id)));
const canStart = computed(() => picked.value.length > 0);

function toggle(q) {
  picked.value = pickedIds.value.has(q.id)
    ? picked.value.filter((x) => x.id !== q.id)
    : [...picked.value, q];
}

async function create() {
  if (!canStart.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const res = await api.post('/api/teacher/live', {
      title: setup.value.title.trim() || '即時測驗',
      classId: setup.value.classId || null,
      seconds: Number(setup.value.seconds),
      questionIds: picked.value.map((q) => q.id),
    });
    enter(res.session);
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

function enter(session) {
  live.value = session;
  drift = Date.now() - session.serverTime;
  stop?.();
  connection.value = 'connecting';
  stop = openStream(`/api/teacher/live/${session.sessionId}/stream`, {
    getToken: currentToken,
    onEvent: (name, payload) => {
      if (name !== 'host') return;
      live.value = payload;
      drift = Date.now() - payload.serverTime;
      startClock();
    },
    onStatus: (status, detail) => {
      connection.value = status;
      if (status === 'refused') error.value = detail;
    },
  });
  startClock();
  clearInterval(monitorTimer);
  monitorTimer = setInterval(refreshMonitor, 4000);
  refreshMonitor();
}

async function refreshMonitor() {
  if (!live.value) return;
  try {
    monitor.value = await api.get(`/api/teacher/live/${live.value.sessionId}/monitor`);
  } catch { /* the room may have just ended */ }
}

function startClock() {
  clearInterval(ticker);
  if (live.value?.status !== 'QUESTION' || !live.value.deadlineAt) {
    remaining.value = null;
    return;
  }
  const tick = () => {
    remaining.value = Math.max(0, live.value.deadlineAt - (Date.now() - drift));
    if (remaining.value <= 0) clearInterval(ticker);
  };
  tick();
  ticker = setInterval(tick, 200);
}

/**
 * Each control posts to a literal path rather than one built from a variable:
 * a path assembled at runtime cannot be checked against the route table, and
 * an endpoint nothing provably calls is indistinguishable from a typo.
 */
async function send(request) {
  busy.value = true;
  try {
    const res = await request();
    live.value = res.session;
    startClock();
    await refreshMonitor();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

const advance = () => send(() => api.post(`/api/teacher/live/${live.value.sessionId}/next`));
const reveal = () => send(() => api.post(`/api/teacher/live/${live.value.sessionId}/reveal`));
const finish = () => send(() => api.post(`/api/teacher/live/${live.value.sessionId}/end`));

function close() {
  stop?.();
  clearInterval(ticker);
  clearInterval(monitorTimer);
  live.value = null;
  monitor.value = null;
  picked.value = [];
  api.get('/api/teacher/live').then((r) => { rooms.value = r.sessions; }).catch(() => {});
}

const seconds = computed(() => (remaining.value == null ? null : Math.ceil(remaining.value / 1000)));
const answeredNow = computed(() => live.value?.tally?.answered ?? 0);
const waiting = computed(() => (monitor.value?.participants ?? []).filter((p) => !p.answeredCurrent));
</script>

<template>
  <AnimatePresence>
    <motion.p
      v-if="error" key="err"
      :initial="{ opacity: 0, height: 0 }" :animate="{ opacity: 1, height: 'auto' }"
      :exit="{ opacity: 0, height: 0 }"
      class="mb-4 overflow-hidden rounded-lg px-3 py-2 text-sm"
      style="background: var(--danger-soft); color: var(--danger)"
    >{{ error }}</motion.p>
  </AnimatePresence>

  <!-- setup ─────────────────────────────────────────────────────────── -->
  <template v-if="!live">
    <h1 class="mb-1 text-xl font-semibold">即時測驗</h1>
    <p class="mb-5 text-sm" style="color: var(--text-muted)">
      選題後開房，學生用代碼加入，你控制節奏
    </p>

    <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

    <div v-else class="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <section class="card p-5">
        <h2 class="mb-3 text-sm font-semibold">選題（已選 {{ picked.length }}）</h2>
        <div v-if="bank.length === 0" class="py-8 text-center text-sm" style="color: var(--text-muted)">
          題庫裡沒有可用的題目
        </div>
        <div v-else class="max-h-[28rem] space-y-2 overflow-y-auto">
          <motion.button
            v-for="q in bank" :key="q.id"
            type="button"
            class="flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left"
            :style="pickedIds.has(q.id)
              ? { background: 'var(--primary-soft)', borderColor: 'var(--primary)' }
              : { background: 'var(--surface)', borderColor: 'var(--border)' }"
            :while-hover="{ y: -2 }" :while-press="{ scale: 0.99 }"
            :transition="{ type: 'spring', visualDuration: 0.18, bounce: 0 }"
            @click="toggle(q)"
          >
            <span class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded border text-[11px]"
                  :style="pickedIds.has(q.id)
                    ? { background: 'var(--primary)', borderColor: 'var(--primary)', color: '#fff' }
                    : { borderColor: 'var(--border-strong)' }">
              {{ pickedIds.has(q.id) ? '✓' : '' }}
            </span>
            <span class="line-clamp-2 flex-1 whitespace-pre-line text-[13.5px] leading-relaxed">
              {{ q.content }}
            </span>
          </motion.button>
        </div>
      </section>

      <aside class="space-y-4">
        <section class="card space-y-3 p-5">
          <h2 class="text-sm font-semibold">房間設定</h2>
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">標題</span>
            <input v-model="setup.title" class="field" placeholder="即時測驗" />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">限定班別</span>
            <select v-model="setup.classId" class="field">
              <option value="">不限（有代碼就能進）</option>
              <option v-for="c in classes" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">每題秒數</span>
            <input v-model="setup.seconds" type="number" min="5" max="300" class="field" />
          </label>
          <button class="btn btn-primary w-full" :disabled="!canStart || busy" @click="create">
            開房
          </button>
        </section>

        <section v-if="rooms.length" class="card p-5">
          <h2 class="mb-2 text-sm font-semibold">之前的場次</h2>
          <div v-for="r in rooms" :key="r.id" class="flex items-center justify-between py-1 text-[12px]">
            <span>{{ r.title }}</span>
            <span style="color: var(--text-subtle)">
              {{ r.participants }} 人 · {{ r.status === 'ENDED' ? '已結束' : r.code }}
            </span>
          </div>
        </section>
      </aside>
    </div>
  </template>

  <!-- running ───────────────────────────────────────────────────────── -->
  <template v-else>
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold">{{ live.title }}</h1>
        <p class="text-[12px]" style="color: var(--text-subtle)">
          {{ live.participants }} 人已加入
          <template v-if="live.seq"> · 第 {{ live.seq }}/{{ live.questionCount }} 題</template>
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="connection !== 'open'" class="rounded-full px-2 py-0.5 text-[11px]"
              style="background: var(--warning-soft); color: var(--warning)">
          {{ connection === 'reconnecting' ? '重連中…' : '連線中…' }}
        </span>
        <button class="btn btn-ghost !py-1.5 !text-[13px]" @click="close">離開</button>
      </div>
    </div>

    <!-- The code, big, because thirty people are copying it off a screen. -->
    <motion.div
      v-if="live.status === 'LOBBY'"
      class="card mb-5 p-8 text-center"
      :initial="{ opacity: 0, scale: 0.97 }" :animate="{ opacity: 1, scale: 1 }"
      :transition="{ type: 'spring', visualDuration: 0.35, bounce: 0 }"
    >
      <div class="mb-1 text-xs" style="color: var(--text-muted)">房間代碼</div>
      <div class="font-mono text-6xl font-bold tracking-[0.2em]" style="color: var(--primary)">
        {{ live.code }}
      </div>
      <p class="mt-3 text-sm" style="color: var(--text-muted)">
        學生到「即時測驗」輸入代碼加入
      </p>
    </motion.div>

    <div v-else class="card mb-4 p-4">
      <div class="flex items-center justify-between text-sm">
        <span style="color: var(--text-muted)">
          已作答 <span class="font-semibold tabular-nums" style="color: var(--text)">{{ answeredNow }}</span>
          / {{ live.participants }}
        </span>
        <span v-if="seconds != null" class="text-lg font-bold tabular-nums"
              :style="{ color: seconds <= 5 ? 'var(--danger)' : 'var(--text-muted)' }">{{ seconds }}</span>
        <span v-else class="text-sm" style="color: var(--success)">已公開答案</span>
      </div>
      <div class="mt-2 h-1.5 overflow-hidden rounded-full" style="background: var(--border)">
        <motion.div
          class="h-full origin-left rounded-full" style="background: var(--primary)"
          :initial="false"
          :animate="{ scaleX: live.participants ? answeredNow / live.participants : 0 }"
          :transition="{ type: 'spring', visualDuration: 0.3, bounce: 0 }"
        />
      </div>
    </div>

    <article v-if="live.question" class="card mb-4 p-5">
      <p class="mb-4 whitespace-pre-line text-[15px] leading-relaxed">{{ live.question.content }}</p>
      <div class="space-y-2">
        <div
          v-for="option in live.question.options" :key="option.label"
          class="flex items-center gap-3 rounded-xl border px-3.5 py-2.5 text-[14px]"
          :style="live.status === 'REVEAL' && option.isCorrect
            ? { background: 'var(--success-soft)', borderColor: 'var(--success)', color: 'var(--success)' }
            : { borderColor: 'var(--border)', color: 'var(--text)' }"
        >
          <span class="grid h-6 w-6 shrink-0 place-items-center rounded-lg border text-[12px] font-semibold"
                style="border-color: currentColor">{{ option.label }}</span>
          <span class="flex-1">{{ option.content }}</span>
          <div v-if="live.breakdown" class="flex w-32 items-center gap-2">
            <div class="h-1.5 flex-1 overflow-hidden rounded-full" style="background: var(--border)">
              <motion.div
                class="h-full origin-left rounded-full"
                :style="{ background: option.isCorrect ? 'var(--success)' : 'var(--danger)' }"
                :initial="{ scaleX: 0 }"
                :animate="{ scaleX: live.participants
                  ? (live.breakdown.options.find((o) => o.label === option.label)?.count ?? 0) / live.participants
                  : 0 }"
                :transition="{ type: 'spring', visualDuration: 0.4, bounce: 0 }"
              />
            </div>
            <span class="w-8 text-right text-[11px] tabular-nums" style="color: var(--text-subtle)">
              {{ live.breakdown.options.find((o) => o.label === option.label)?.count ?? 0 }}
            </span>
          </div>
        </div>
      </div>
    </article>

    <div class="mb-5 flex flex-wrap justify-end gap-2">
      <button v-if="live.status !== 'ENDED'" class="btn btn-ghost" :disabled="busy" @click="finish">
        結束
      </button>
      <button v-if="live.status === 'QUESTION'" class="btn btn-ghost" :disabled="busy" @click="reveal">
        公開答案
      </button>
      <motion.button
        v-if="live.status !== 'ENDED'"
        class="btn btn-primary" :disabled="busy"
        :while-press="{ scale: 0.97 }"
        :transition="{ type: 'spring', visualDuration: 0.12, bounce: 0 }"
        @click="advance"
      >
        {{ live.status === 'LOBBY' ? '開始' : live.seq >= live.questionCount ? '結束並看結果' : '下一題' }}
      </motion.button>
    </div>

    <!-- Who is still thinking — the thing a teacher walking the room wants. -->
    <section v-if="monitor && live.status === 'QUESTION' && waiting.length" class="mb-5">
      <h2 class="mb-2 text-sm font-semibold">還沒作答（{{ waiting.length }}）</h2>
      <div class="card p-4 text-[13px]" style="color: var(--text-muted)">
        {{ waiting.map((p) => p.displayName).join('、') }}
      </div>
    </section>

    <AnimatePresence>
      <motion.section
        v-if="live.leaderboard?.length" key="board"
        :initial="{ opacity: 0, height: 0 }"
        :animate="{ opacity: 1, height: 'auto', transition: { duration: 0.3, ease: 'easeOut' } }"
        :exit="{ opacity: 0, height: 0, transition: { duration: 0.16, ease: 'easeIn' } }"
        class="overflow-hidden"
      >
        <h2 class="mb-2 text-sm font-semibold">排行</h2>
        <div class="card divide-y p-0" style="border-color: var(--border)">
          <motion.div
            v-for="row in live.leaderboard" :key="row.userId"
            class="flex items-center gap-3 px-4 py-2.5 text-[13px]"
            layout :transition="{ type: 'spring', visualDuration: 0.3, bounce: 0 }"
          >
            <span class="w-6 shrink-0 font-semibold tabular-nums"
                  :style="{ color: row.rank <= 3 ? 'var(--warning)' : 'var(--text-subtle)' }">
              {{ row.rank }}
            </span>
            <span class="flex-1">{{ row.displayName }}</span>
            <span style="color: var(--text-subtle)">{{ row.correct }}/{{ row.answered }} 對</span>
            <span class="w-14 text-right tabular-nums font-medium">{{ row.points }}</span>
          </motion.div>
        </div>
      </motion.section>
    </AnimatePresence>
  </template>
</template>
