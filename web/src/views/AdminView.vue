<script setup>
import { onMounted, ref } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const topics = ref([]);
const auditLog = ref([]);
const loading = ref(true);
const error = ref('');
const pending = ref(new Set());
const tab = ref('topics');

async function load() {
  const [t, a] = await Promise.allSettled([
    api.get('/api/admin/topics'),
    api.get('/api/admin/audit?limit=100'),
  ]);
  if (t.status === 'fulfilled') topics.value = t.value.topics;
  else error.value = t.reason.message;
  if (a.status === 'fulfilled') auditLog.value = a.value.entries;
  loading.value = false;
}
onMounted(load);

/**
 * Disabling a topic here hides it everywhere, for every class — unlike the
 * per-class switch on the teacher side. Saying which is which matters,
 * because the two screens look alike and only one of them is global.
 */
async function toggle(topic) {
  if (pending.value.has(topic.id)) return;
  const next = !topic.enabled;
  topic.enabled = next;
  pending.value = new Set(pending.value).add(topic.id);
  try {
    await api.patch(`/api/admin/topics/${topic.id}`, { enabled: next });
  } catch (err) {
    topic.enabled = !next;
    error.value = err.message;
  } finally {
    const copy = new Set(pending.value);
    copy.delete(topic.id);
    pending.value = copy;
  }
}

const fmt = (ms) => new Date(ms).toLocaleString('zh-HK',
  { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const ACTION = {
  'auth.login': '登入', 'auth.logout': '登出', 'auth.password_changed': '改密碼',
  'refresh.reuse_detected': '偵測到 token 重放', 'assignment.start': '開始作答',
  'assignment.submit': '交卷', 'assignment.create': '建立作業',
  'assignment.publish': '發佈作業', 'question.create': '新增題目',
  'question.options_filled': '補齊題目', 'topic.toggle': '課題開關',
  'class.topic_toggle': '班別課題開關', 'ratelimit.clear': '解除節流',
  'ratelimit.relax': '放寬節流', 'ratelimit.override': '調整節流',
  'ratelimit.override_removed': '取消節流調整',
};

/** Things worth noticing in a log that is mostly routine. */
const NOTABLE = new Set(['refresh.reuse_detected', 'ratelimit.override', 'auth.password_changed']);
</script>

<template>
  <h1 class="mb-1 text-xl font-semibold">系統管理</h1>
  <p class="mb-5 text-sm" style="color: var(--text-muted)">全站課題開關與稽核紀錄</p>

  <AnimatePresence>
    <motion.p
      v-if="error" key="err"
      :initial="{ opacity: 0, height: 0 }" :animate="{ opacity: 1, height: 'auto' }"
      :exit="{ opacity: 0, height: 0 }"
      class="mb-4 overflow-hidden rounded-lg px-3 py-2 text-sm"
      style="background: var(--danger-soft); color: var(--danger)"
    >{{ error }}</motion.p>
  </AnimatePresence>

  <div class="mb-4 flex gap-1 rounded-lg p-1" style="background: var(--bg); width: fit-content">
    <button
      v-for="t in [['topics', '課題'], ['audit', '稽核紀錄']]" :key="t[0]"
      class="rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors duration-150"
      :style="tab === t[0]
        ? { background: 'var(--surface)', color: 'var(--text)', boxShadow: 'var(--shadow-1)' }
        : { color: 'var(--text-muted)' }"
      @click="tab = t[0]"
    >{{ t[1] }}</button>
  </div>

  <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <AnimatePresence v-else mode="wait" :initial="false">
    <!-- topics ─────────────────────────────────────────────────────── -->
    <motion.div
      v-if="tab === 'topics'" key="topics"
      :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
      :exit="{ opacity: 0, transition: { duration: 0.12 } }"
      :transition="{ duration: 0.22, ease: 'easeOut' }"
    >
      <p class="mb-3 rounded-lg px-3 py-2 text-[12px]"
         style="background: var(--warning-soft); color: var(--warning)">
        這裡關掉的課題，<strong>所有班別</strong>都看不到。只想關某一班請用教師端的「課題開關」。
      </p>

      <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        <motion.div
          v-for="(t, i) in topics" :key="t.id"
          class="card flex items-center justify-between p-4"
          :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.2, ease: 'easeOut', delay: Math.min(i, 20) * 0.02 }"
        >
          <div class="min-w-0">
            <div class="truncate text-sm font-medium"
                 :style="{ color: t.enabled ? 'var(--text)' : 'var(--text-disabled)' }">
              {{ t.nameZh }}
            </div>
            <div class="text-[11px]" style="color: var(--text-subtle)">{{ t.code }} · #{{ t.id }}</div>
          </div>

          <button
            type="button"
            class="relative h-6 w-11 shrink-0 rounded-full transition-colors duration-150"
            :style="{ background: t.enabled ? 'var(--success)' : 'var(--border-strong)' }"
            :aria-pressed="t.enabled"
            :aria-label="`${t.nameZh} ${t.enabled ? '啟用' : '停用'}`"
            @click="toggle(t)"
          >
            <motion.span
              class="absolute top-0.5 block h-5 w-5 rounded-full bg-white"
              style="box-shadow: var(--shadow-1)"
              :initial="false" :animate="{ x: t.enabled ? 22 : 2 }"
              :transition="{ type: 'spring', visualDuration: 0.2, bounce: 0.2 }"
            />
          </button>
        </motion.div>
      </div>
    </motion.div>

    <!-- audit ──────────────────────────────────────────────────────── -->
    <motion.div
      v-else key="audit"
      :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
      :exit="{ opacity: 0, transition: { duration: 0.12 } }"
      :transition="{ duration: 0.22, ease: 'easeOut' }"
    >
      <div v-if="auditLog.length === 0" class="card p-10 text-center text-sm"
           style="color: var(--text-muted)">還沒有紀錄</div>

      <div v-else class="card divide-y p-0" style="border-color: var(--border)">
        <div
          v-for="e in auditLog" :key="e.id"
          class="flex flex-wrap items-baseline gap-x-2 px-4 py-2.5 text-[12px]"
          :style="NOTABLE.has(e.action) ? { background: 'var(--warning-soft)' } : {}"
        >
          <span class="w-24 shrink-0 tabular-nums" style="color: var(--text-subtle)">
            {{ fmt(e.at) }}
          </span>
          <span class="rounded px-1.5 py-0.5"
                :style="NOTABLE.has(e.action)
                  ? { background: 'var(--warning)', color: '#fff' }
                  : { background: 'var(--bg)', color: 'var(--text-muted)' }">
            {{ ACTION[e.action] ?? e.action }}
          </span>
          <span style="color: var(--text-muted)">#{{ e.actor_id ?? '—' }}</span>
          <span v-if="e.target" class="font-mono" style="color: var(--text-subtle)">{{ e.target }}</span>
          <span v-if="e.ip" style="color: var(--text-subtle)">{{ e.ip }}</span>
          <span v-if="e.detail" class="truncate" style="color: var(--text-subtle)">{{ e.detail }}</span>
        </div>
      </div>
    </motion.div>
  </AnimatePresence>
</template>
