<script setup>
import { computed, onUnmounted, ref } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api, currentToken } from '../lib/api.js';
import { openStream } from '../lib/sse.js';

const code = ref('');
const state = ref(null);
const connection = ref('idle');
const error = ref('');
const chosen = ref(null);
const sending = ref(false);
const remaining = ref(null);

let stop = null;
let ticker = null;
/** Difference between this device's clock and the server's, measured once. */
let drift = 0;

onUnmounted(() => { stop?.(); clearInterval(ticker); });

async function join() {
  const entered = code.value.trim().toUpperCase();
  if (!entered) return;
  error.value = '';
  try {
    const res = await api.post(`/api/live/${entered}/join`);
    apply(res.session);
    listen(entered);
  } catch (err) {
    error.value = err.message;
  }
}

function listen(room) {
  stop?.();
  connection.value = 'connecting';
  stop = openStream(`/api/live/${room}/stream`, {
    getToken: currentToken,
    onEvent: (name, payload) => { if (name === 'state') apply(payload); },
    onStatus: (status, detail) => {
      connection.value = status;
      if (status === 'refused') error.value = detail;
    },
  });
}

function apply(next) {
  const previous = state.value;
  state.value = next;
  // Everything is timed against the server's clock, so this device's idea of
  // "now" never buys or costs anyone seconds.
  drift = Date.now() - next.serverTime;

  if (previous?.seq !== next.seq) chosen.value = next.myAnswer?.chosen ?? null;
  startClock();
}

function startClock() {
  clearInterval(ticker);
  if (state.value?.status !== 'QUESTION' || !state.value.deadlineAt) {
    remaining.value = null;
    return;
  }
  const tick = () => {
    remaining.value = Math.max(0, state.value.deadlineAt - (Date.now() - drift));
    if (remaining.value <= 0) clearInterval(ticker);
  };
  tick();
  ticker = setInterval(tick, 200);
}

async function answer(label) {
  if (chosen.value || sending.value || state.value?.status !== 'QUESTION') return;
  sending.value = true;
  chosen.value = label;
  try {
    await api.post(`/api/live/${state.value.code}/answer`, { chosen: label });
  } catch (err) {
    error.value = err.message;
    chosen.value = null;
  } finally {
    sending.value = false;
  }
}

function leave() {
  stop?.();
  clearInterval(ticker);
  state.value = null;
  connection.value = 'idle';
  code.value = '';
}

const seconds = computed(() => (remaining.value == null ? null : Math.ceil(remaining.value / 1000)));
const urgent = computed(() => seconds.value != null && seconds.value <= 5);
const myResult = computed(() => state.value?.myAnswer ?? null);
const revealed = computed(() => state.value?.status === 'REVEAL');
const correctSet = computed(() => new Set(state.value?.breakdown?.correctLabels ?? []));
</script>

<template>
  <!-- lobby ─────────────────────────────────────────────────────────── -->
  <div v-if="!state" class="mx-auto max-w-sm pt-8">
    <h1 class="mb-1 text-xl font-semibold">加入即時測驗</h1>
    <p class="mb-5 text-sm" style="color: var(--text-muted)">輸入老師給的房間代碼</p>

    <form class="card space-y-3 p-5" @submit.prevent="join">
      <input
        v-model="code" class="field text-center font-mono text-2xl tracking-[0.3em]"
        maxlength="5" placeholder="ABCDE" autofocus
        @input="code = code.toUpperCase()"
      />
      <button class="btn btn-primary w-full" :disabled="code.trim().length < 5">加入</button>
    </form>

    <AnimatePresence>
      <motion.p
        v-if="error" key="err"
        :initial="{ opacity: 0, y: -4 }" :animate="{ opacity: 1, y: 0 }" :exit="{ opacity: 0 }"
        class="mt-3 rounded-lg px-3 py-2 text-sm"
        style="background: var(--danger-soft); color: var(--danger)"
      >{{ error }}</motion.p>
    </AnimatePresence>
  </div>

  <!-- in the room ───────────────────────────────────────────────────── -->
  <div v-else>
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="text-lg font-semibold">{{ state.title }}</h1>
        <p class="text-[12px]" style="color: var(--text-subtle)">
          房間 {{ state.code }} · {{ state.participants }} 人
          <template v-if="state.seq"> · 第 {{ state.seq }}/{{ state.questionCount }} 題</template>
        </p>
      </div>

      <div class="flex items-center gap-2">
        <!-- Said plainly, because a frozen screen during a quiz is alarming
             and the usual guess is that you have been disconnected. -->
        <span
          v-if="connection !== 'open'"
          class="rounded-full px-2 py-0.5 text-[11px]"
          style="background: var(--warning-soft); color: var(--warning)"
        >{{ connection === 'reconnecting' ? '連線中斷，重連中…' : '連線中…' }}</span>
        <button class="btn btn-ghost !py-1.5 !text-[13px]" @click="leave">離開</button>
      </div>
    </div>

    <AnimatePresence mode="wait" :initial="false">
      <!-- waiting ─────────────────────────────────────────────────── -->
      <motion.div
        v-if="state.status === 'LOBBY'" key="lobby"
        :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }" :exit="{ opacity: 0 }"
        :transition="{ duration: 0.25, ease: 'easeOut' }"
        class="card p-12 text-center"
      >
        <motion.div
          class="mb-3 text-3xl"
          :animate="{ scale: [1, 1.08, 1] }"
          :transition="{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }"
        >⏳</motion.div>
        <p class="text-sm" style="color: var(--text-muted)">已加入，等老師開始</p>
      </motion.div>

      <!-- question ────────────────────────────────────────────────── -->
      <motion.div
        v-else-if="state.question" :key="`q${state.seq}-${state.status}`"
        :initial="{ opacity: 0, x: 24 }"
        :animate="{ opacity: 1, x: 0, transition: { type: 'spring', visualDuration: 0.3, bounce: 0 } }"
        :exit="{ opacity: 0, x: -16, transition: { duration: 0.15, ease: 'easeIn' } }"
      >
        <div v-if="state.status === 'QUESTION'" class="mb-4">
          <div class="mb-1.5 flex items-baseline justify-between">
            <span class="text-sm" style="color: var(--text-muted)">
              {{ chosen ? '已作答，等其他人' : '選一個答案' }}
            </span>
            <motion.span
              class="text-lg font-bold tabular-nums"
              :style="{ color: urgent ? 'var(--danger)' : 'var(--text-muted)' }"
              :animate="urgent ? { scale: [1, 1.12, 1] } : { scale: 1 }"
              :transition="urgent ? { duration: 1, repeat: Infinity } : { duration: 0.2 }"
            >{{ seconds ?? '—' }}</motion.span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full" style="background: var(--border)">
            <div
              class="h-full origin-left rounded-full transition-none"
              :style="{
                background: urgent ? 'var(--danger)' : 'var(--primary)',
                transform: `scaleX(${Math.max(0, (remaining ?? 0) / (state.seconds * 1000))})`,
              }"
            />
          </div>
        </div>

        <article class="card p-5 sm:p-6">
          <p class="mb-5 whitespace-pre-line text-[15px] leading-relaxed">{{ state.question.content }}</p>

          <div class="space-y-2">
            <motion.button
              v-for="option in state.question.options" :key="option.label"
              type="button"
              class="flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left text-[14px]"
              :style="{
                ...(revealed
                  ? correctSet.has(option.label)
                    ? { background: 'var(--success-soft)', borderColor: 'var(--success)', color: 'var(--success)' }
                    : chosen === option.label
                      ? { background: 'var(--danger-soft)', borderColor: 'var(--danger)', color: 'var(--danger)' }
                      : { background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text-disabled)' }
                  : chosen === option.label
                    ? { background: 'var(--primary-soft)', borderColor: 'var(--primary)', color: 'var(--primary-text)' }
                    : { background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }),
                transition: 'background-color .14s ease-out, border-color .14s ease-out, color .14s ease-out',
                cursor: chosen || revealed ? 'default' : 'pointer',
              }"
              :while-hover="chosen || revealed ? {} : { y: -2 }"
              :while-press="chosen || revealed ? {} : { scale: 0.99 }"
              :transition="{ type: 'spring', visualDuration: 0.18, bounce: 0 }"
              :disabled="!!chosen || revealed || seconds === 0"
              @click="answer(option.label)"
            >
              <span class="grid h-6 w-6 shrink-0 place-items-center rounded-lg border text-[12px] font-semibold"
                    style="border-color: currentColor">{{ option.label }}</span>
              <span class="pt-0.5">{{ option.content }}</span>
              <span v-if="revealed && state.breakdown" class="ml-auto pt-0.5 text-[12px] tabular-nums">
                {{ state.breakdown.options.find((o) => o.label === option.label)?.count ?? 0 }} 人
              </span>
            </motion.button>
          </div>
        </article>

        <AnimatePresence>
          <motion.div
            v-if="revealed && myResult" key="result"
            :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }" :exit="{ opacity: 0 }"
            :transition="{ type: 'spring', visualDuration: 0.3, bounce: 0.2 }"
            class="card mt-3 p-4 text-center"
          >
            <div class="text-sm font-semibold"
                 :style="{ color: myResult.is_correct ? 'var(--success)' : 'var(--danger)' }">
              {{ myResult.is_correct ? `答對，+${myResult.points} 分` : '答錯了' }}
            </div>
          </motion.div>
          <motion.div
            v-else-if="revealed" key="noresult"
            :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }"
            class="card mt-3 p-4 text-center text-sm" style="color: var(--text-muted)"
          >這題你沒有作答</motion.div>
        </AnimatePresence>
      </motion.div>

      <!-- finished ────────────────────────────────────────────────── -->
      <motion.div
        v-else key="ended"
        :initial="{ opacity: 0, scale: 0.97 }" :animate="{ opacity: 1, scale: 1 }"
        :transition="{ type: 'spring', visualDuration: 0.35, bounce: 0 }"
        class="card p-6 text-center"
      >
        <div class="mb-1 text-2xl font-bold">測驗結束</div>
        <p class="text-sm" style="color: var(--text-muted)">謝謝參與</p>
      </motion.div>
    </AnimatePresence>

    <!-- leaderboard ───────────────────────────────────────────────── -->
    <AnimatePresence>
      <motion.section
        v-if="state.leaderboard?.length" key="board"
        :initial="{ opacity: 0, height: 0 }"
        :animate="{ opacity: 1, height: 'auto', transition: { duration: 0.3, ease: 'easeOut' } }"
        :exit="{ opacity: 0, height: 0, transition: { duration: 0.16, ease: 'easeIn' } }"
        class="mt-4 overflow-hidden"
      >
        <h2 class="mb-2 text-sm font-semibold">排行</h2>
        <div class="card divide-y p-0" style="border-color: var(--border)">
          <motion.div
            v-for="row in state.leaderboard" :key="row.userId"
            class="flex items-center gap-3 px-4 py-2.5 text-[13px]"
            layout
            :transition="{ type: 'spring', visualDuration: 0.3, bounce: 0 }"
          >
            <span class="w-6 shrink-0 font-semibold tabular-nums"
                  :style="{ color: row.rank <= 3 ? 'var(--warning)' : 'var(--text-subtle)' }">
              {{ row.rank }}
            </span>
            <span class="flex-1">{{ row.displayName }}</span>
            <span class="tabular-nums" style="color: var(--text-muted)">{{ row.points }}</span>
          </motion.div>
        </div>
      </motion.section>
    </AnimatePresence>
  </div>
</template>
