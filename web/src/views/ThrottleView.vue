<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const state = ref(null);
const auditLog = ref([]);
const loading = ref(true);
const error = ref('');
const notice = ref('');
const busy = ref(null);

/** The adjustment form, opened against one key at a time. */
const editing = ref(null);
const form = ref({ max: 0, minutes: 60, reason: '' });

let poll = null;

async function load() {
  try {
    const [s, a] = await Promise.all([
      api.get('/api/staff/ratelimit'),
      api.get('/api/staff/ratelimit/audit?limit=20'),
    ]);
    state.value = s;
    auditLog.value = a.entries;
    error.value = '';
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
  // Counters move on their own, so a stale screen would show someone as stuck
  // long after their window expired.
  poll = setInterval(load, 15_000);
});
onUnmounted(() => clearInterval(poll));

const may = computed(() => state.value?.may ?? {});
const throttled = computed(() => (state.value?.buckets ?? []).filter((b) => b.throttled));
const busiest = computed(() => (state.value?.buckets ?? []).filter((b) => !b.throttled).slice(0, 12));

const POLICY = {
  login: '登入', loginPerUser: '登入（單一帳號）', refresh: '續期',
  password: '改密碼', write: '寫入', read: '讀取',
};

async function clear(key) {
  busy.value = key;
  notice.value = '';
  try {
    const reason = window.prompt('解除原因（會記入稽核紀錄）', '整班同時登入');
    if (reason === null) return;
    const res = await api.post('/api/staff/ratelimit/clear', { key, reason });
    notice.value = `已解除 ${key}，本小時還可解除 ${res.clearsLeftThisHour} 次`;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = null;
  }
}

function openAdjust(bucket) {
  editing.value = bucket.key;
  const base = state.value.policies[bucket.policy]?.max ?? 100;
  // Default to a loosening, because that is what this screen is usually for.
  form.value = { max: base * 3, minutes: 60, reason: '' };
}

async function submitAdjust() {
  if (!form.value.reason.trim()) return;
  busy.value = editing.value;
  try {
    await api.post('/api/staff/ratelimit/override', {
      key: editing.value,
      max: Number(form.value.max),
      minutes: Number(form.value.minutes),
      reason: form.value.reason.trim(),
    });
    notice.value = `已為 ${editing.value} 設定臨時上限`;
    editing.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = null;
  }
}

async function removeOverride(key) {
  busy.value = key;
  try {
    await api.del('/api/staff/ratelimit/override', { key });
    notice.value = `已取消 ${key} 的臨時設定`;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = null;
  }
}

const fmtTime = (ms) => new Date(ms).toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' });
const minutesLeft = (ms) => Math.max(0, Math.round((ms - Date.now()) / 60000));

const ACTION = {
  'ratelimit.clear': '解除', 'ratelimit.relax': '放寬',
  'ratelimit.override': '調整', 'ratelimit.override_removed': '取消調整',
};
</script>

<template>
  <h1 class="mb-1 text-xl font-semibold">連線節流</h1>
  <p class="mb-5 text-sm" style="color: var(--text-muted)">
    整校常常共用一個對外位址，所以全班同時登入看起來會像同一台機器在猜密碼。卡住的話在這裡解除。
  </p>

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

  <template v-else-if="state">
    <!-- blocked right now ────────────────────────────────────────────── -->
    <section class="mb-6">
      <h2 class="mb-2.5 text-base font-semibold">
        目前被擋住
        <span v-if="throttled.length" class="ml-1 rounded-full px-2 py-0.5 text-[11px]"
              style="background: var(--danger-soft); color: var(--danger)">{{ throttled.length }}</span>
      </h2>

      <motion.div
        v-if="throttled.length === 0"
        :initial="{ opacity: 0 }" :animate="{ opacity: 1 }"
        class="card p-8 text-center text-sm" style="color: var(--text-muted)"
      >沒有人被擋住</motion.div>

      <div v-else class="space-y-2">
        <AnimatePresence :initial="false">
          <motion.div
            v-for="b in throttled" :key="b.key"
            class="card flex flex-wrap items-center justify-between gap-3 p-4"
            style="border-color: var(--danger)"
            :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
            :exit="{ opacity: 0, x: -12, transition: { duration: 0.15, ease: 'easeIn' } }"
            layout
          >
            <div class="min-w-0">
              <div class="font-mono text-sm">{{ b.key.split(':').slice(1).join(':') }}</div>
              <div class="text-[11px]" style="color: var(--text-subtle)">
                {{ POLICY[b.policy] ?? b.policy }} · {{ b.count }}/{{ b.max }} 次 ·
                {{ fmtTime(b.resetAt) }} 自動恢復
              </div>
            </div>

            <div class="flex gap-2">
              <button v-if="may.clear" class="btn btn-ghost !py-1.5 !text-[13px]"
                      :disabled="busy === b.key" @click="clear(b.key)">解除</button>
              <button v-if="may.relax" class="btn btn-primary !py-1.5 !text-[13px]"
                      :disabled="busy === b.key" @click="openAdjust(b)">臨時放寬</button>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </section>

    <!-- adjustment form ──────────────────────────────────────────────── -->
    <AnimatePresence>
      <motion.section
        v-if="editing" key="adjust"
        :initial="{ opacity: 0, height: 0 }"
        :animate="{ opacity: 1, height: 'auto', transition: { duration: 0.26, ease: 'easeOut' } }"
        :exit="{ opacity: 0, height: 0, transition: { duration: 0.15, ease: 'easeIn' } }"
        class="mb-6 overflow-hidden"
      >
        <div class="card p-5">
          <h3 class="mb-3 text-sm font-semibold">臨時調整 <span class="font-mono">{{ editing }}</span></h3>
          <div class="grid gap-3 sm:grid-cols-3">
            <label class="block">
              <span class="mb-1 block text-xs" style="color: var(--text-muted)">新上限</span>
              <input v-model="form.max" type="number" min="0" class="field" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs" style="color: var(--text-muted)">維持幾分鐘</span>
              <input v-model="form.minutes" type="number" min="1" class="field" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs" style="color: var(--text-muted)">原因（必填）</span>
              <input v-model="form.reason" class="field" placeholder="例如 S4 下午全班考試" />
            </label>
          </div>

          <p class="mt-3 text-[11px]" style="color: var(--text-subtle)">
            最多放寬到原本的 {{ state.limits.relaxMaxFactor }} 倍、{{ state.limits.relaxMaxHours }} 小時。
            <template v-if="!may.override">調低上限或封鎖來源只有管理員可以做。</template>
          </p>

          <div class="mt-4 flex justify-end gap-2">
            <button class="btn btn-ghost" @click="editing = null">取消</button>
            <button class="btn btn-primary" :disabled="!form.reason.trim() || busy" @click="submitAdjust">
              套用
            </button>
          </div>
        </div>
      </motion.section>
    </AnimatePresence>

    <!-- live overrides ───────────────────────────────────────────────── -->
    <section v-if="state.overrides.length" class="mb-6">
      <h2 class="mb-2.5 text-base font-semibold">生效中的臨時設定</h2>
      <div class="space-y-2">
        <div v-for="o in state.overrides" :key="o.key"
             class="card flex items-center justify-between p-4">
          <div>
            <div class="font-mono text-sm">{{ o.key }}</div>
            <div class="text-[11px]" style="color: var(--text-subtle)">
              上限 {{ o.max }} · 還有 {{ minutesLeft(o.expiresAt) }} 分鐘 · {{ o.reason }}
            </div>
          </div>
          <button v-if="may.relax" class="btn btn-ghost !py-1.5 !text-[13px]"
                  @click="removeOverride(o.key)">取消</button>
        </div>
      </div>
    </section>

    <!-- counting, but fine ───────────────────────────────────────────── -->
    <section class="mb-6">
      <h2 class="mb-2.5 text-base font-semibold">正在計數</h2>
      <div v-if="busiest.length === 0" class="card p-8 text-center text-sm"
           style="color: var(--text-muted)">目前沒有流量</div>
      <div v-else class="card divide-y p-0" style="border-color: var(--border)">
        <div v-for="b in busiest" :key="b.key" class="flex items-center gap-3 px-4 py-2.5">
          <span class="w-20 shrink-0 text-[12px]" style="color: var(--text-muted)">
            {{ POLICY[b.policy] ?? b.policy }}
          </span>
          <span class="min-w-0 flex-1 truncate font-mono text-[12px]">
            {{ b.key.split(':').slice(1).join(':') }}
          </span>
          <div class="h-1.5 w-28 overflow-hidden rounded-full" style="background: var(--border)">
            <motion.div
              class="h-full origin-left rounded-full"
              :style="{ background: b.count / b.max > 0.8 ? 'var(--warning)' : 'var(--success)' }"
              :initial="false" :animate="{ scaleX: Math.min(1, b.count / (b.max || 1)) }"
              :transition="{ type: 'spring', visualDuration: 0.3, bounce: 0 }"
            />
          </div>
          <span class="w-16 text-right text-[11px] tabular-nums" style="color: var(--text-subtle)">
            {{ b.count }}/{{ b.max }}
          </span>
        </div>
      </div>
    </section>

    <!-- who did what ─────────────────────────────────────────────────── -->
    <section>
      <h2 class="mb-1 text-base font-semibold">稽核紀錄</h2>
      <p class="mb-2.5 text-[12px]" style="color: var(--text-subtle)">
        解除節流正是攻擊者會想做的事，所以每一次都留下誰做的和為什麼。
      </p>

      <div v-if="auditLog.length === 0" class="card p-8 text-center text-sm"
           style="color: var(--text-muted)">還沒有人動過節流設定</div>

      <div v-else class="card divide-y p-0" style="border-color: var(--border)">
        <div v-for="(e, i) in auditLog" :key="i" class="px-4 py-2.5 text-[12px]">
          <span style="color: var(--text-subtle)">{{ fmtTime(e.at) }}</span>
          <span class="mx-2 font-medium">{{ e.actor }}</span>
          <span class="rounded px-1.5 py-0.5 text-[11px]"
                style="background: var(--bg); color: var(--text-muted)">
            {{ ACTION[e.action] ?? e.action }}
          </span>
          <span class="ml-2 font-mono" style="color: var(--text-muted)">{{ e.target }}</span>
          <span v-if="e.detail?.reason" style="color: var(--text-subtle)"> —— {{ e.detail.reason }}</span>
        </div>
      </div>
    </section>
  </template>
</template>
