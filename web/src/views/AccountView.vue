<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';
import { user, logout } from '../lib/session.js';

const router = useRouter();

const sessions = ref([]);
const loadingSessions = ref(true);
/** Fetched rather than taken from the cached session: a role or class change
 *  made since sign-in should show here, not the state at login time. */
const me = ref(null);
const myReports = ref([]);
const form = ref({ currentPassword: '', newPassword: '', confirm: '' });
const busy = ref(false);
const error = ref('');
const done = ref(false);

const ROLE = { STUDENT: '學生', TEACHER: '教師', ADMIN: '管理員' };

const problem = computed(() => {
  const { newPassword, confirm } = form.value;
  if (newPassword && newPassword.length < 8) return '新密碼至少 8 個字元';
  if (confirm && newPassword !== confirm) return '兩次輸入的新密碼不一樣';
  return null;
});
const ready = computed(() => form.value.currentPassword
  && form.value.newPassword.length >= 8
  && form.value.newPassword === form.value.confirm);

onMounted(async () => {
  const [m, s, r] = await Promise.allSettled([
    api.get('/api/auth/me'),
    api.get('/api/auth/sessions'),
    api.get('/api/me/reports'),
  ]);
  if (m.status === 'fulfilled') me.value = m.value.user;
  if (s.status === 'fulfilled') sessions.value = s.value.sessions;
  else error.value = s.reason.message;
  // Staff have no reports of their own; a 403 here is ordinary, not an error.
  if (r.status === 'fulfilled') myReports.value = r.value.reports;
  loadingSessions.value = false;
});

const profile = computed(() => me.value ?? user.value);

async function changePassword() {
  if (!ready.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.post('/api/auth/password', {
      currentPassword: form.value.currentPassword,
      newPassword: form.value.newPassword,
    });
    // The server invalidates every session on a password change, including
    // this one. Saying so and sending them to the login screen is honest;
    // leaving them on a page whose next request will 401 is not.
    done.value = true;
    setTimeout(async () => {
      await logout();
      router.push({ name: 'login' });
    }, 2200);
  } catch (err) {
    error.value = err.message;
    form.value.currentPassword = '';
  } finally {
    busy.value = false;
  }
}

const fmt = (ms) => new Date(ms).toLocaleString('zh-HK',
  { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const REPORT_STATUS = {
  OPEN: { label: '等老師處理', tone: 'var(--warning)', soft: 'var(--warning-soft)' },
  ACCEPTED: { label: '已受理', tone: 'var(--success)', soft: 'var(--success-soft)' },
  REJECTED: { label: '已駁回', tone: 'var(--text-muted)', soft: 'var(--bg)' },
};
</script>

<template>
  <h1 class="mb-1 text-xl font-semibold">我的帳號</h1>
  <p class="mb-5 text-sm" style="color: var(--text-muted)">
    {{ profile?.displayName }} · {{ profile?.username }} · {{ ROLE[profile?.role] }}
  </p>

  <div class="grid gap-4 lg:grid-cols-2">
    <section class="card p-5">
      <h2 class="mb-1 text-base font-semibold">更改密碼</h2>
      <p class="mb-4 text-[12px]" style="color: var(--text-subtle)">
        改完之後所有裝置都會登出，包括這一台。
      </p>

      <AnimatePresence mode="wait">
        <motion.div
          v-if="done" key="done"
          :initial="{ opacity: 0, scale: 0.97 }" :animate="{ opacity: 1, scale: 1 }"
          :transition="{ type: 'spring', visualDuration: 0.3, bounce: 0 }"
          class="rounded-xl p-5 text-center text-sm"
          style="background: var(--success-soft); color: var(--success)"
        >
          密碼已更新，正在登出…
        </motion.div>

        <form v-else key="form" class="space-y-3" @submit.prevent="changePassword">
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">目前密碼</span>
            <input v-model="form.currentPassword" type="password" class="field"
                   autocomplete="current-password" />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">新密碼</span>
            <input v-model="form.newPassword" type="password" class="field"
                   autocomplete="new-password" />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">再輸入一次</span>
            <input v-model="form.confirm" type="password" class="field"
                   autocomplete="new-password" />
          </label>

          <!-- Said while typing, not after submitting: a rule the form could
               have mentioned earlier should not arrive as a server error. -->
          <AnimatePresence>
            <motion.p
              v-if="problem || error" key="msg"
              :initial="{ opacity: 0, height: 0 }"
              :animate="{ opacity: 1, height: 'auto' }"
              :exit="{ opacity: 0, height: 0 }"
              class="overflow-hidden rounded-lg px-3 py-2 text-[13px]"
              :style="error
                ? { background: 'var(--danger-soft)', color: 'var(--danger)' }
                : { background: 'var(--warning-soft)', color: 'var(--warning)' }"
            >{{ error || problem }}</motion.p>
          </AnimatePresence>

          <motion.button
            type="submit" class="btn btn-primary w-full" :disabled="!ready || busy"
            :while-press="ready ? { scale: 0.98 } : {}"
            :transition="{ type: 'spring', visualDuration: 0.12, bounce: 0 }"
          >{{ busy ? '更新中…' : '更改密碼' }}</motion.button>
        </form>
      </AnimatePresence>
    </section>

    <section class="card p-5">
      <h2 class="mb-1 text-base font-semibold">登入中的裝置</h2>
      <p class="mb-4 text-[12px]" style="color: var(--text-subtle)">
        每一條是一次登入。改密碼會把全部作廢。
      </p>

      <div v-if="loadingSessions" class="py-8 text-center text-sm" style="color: var(--text-muted)">
        載入中…
      </div>
      <div v-else-if="sessions.length === 0" class="py-8 text-center text-sm"
           style="color: var(--text-muted)">沒有記錄</div>

      <div v-else class="space-y-2">
        <motion.div
          v-for="(s, i) in sessions" :key="s.familyId"
          class="flex items-center justify-between rounded-lg px-3 py-2.5"
          style="background: var(--bg)"
          :initial="{ opacity: 0, x: -8 }" :animate="{ opacity: 1, x: 0 }"
          :transition="{ duration: 0.22, ease: 'easeOut', delay: i * 0.03 }"
        >
          <div class="text-[12px]">
            <div>{{ fmt(s.issuedAt) }} 登入</div>
            <div style="color: var(--text-subtle)">到期 {{ fmt(s.expiresAt) }}</div>
          </div>
          <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                :style="s.active
                  ? { background: 'var(--success-soft)', color: 'var(--success)' }
                  : { background: 'var(--bg)', color: 'var(--text-subtle)' }">
            {{ s.active ? '使用中' : '已結束' }}
          </span>
        </motion.div>
      </div>
    </section>
  </div>

  <!-- What came of the questions they flagged. Raising an objection and never
       hearing back is worse than not offering the option at all. -->
  <section v-if="myReports.length" class="mt-4">
    <h2 class="mb-2.5 text-base font-semibold">我回報過的題目</h2>
    <div class="card divide-y p-0" style="border-color: var(--border)">
      <div v-for="r in myReports" :key="r.id" class="px-4 py-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                :style="{ background: REPORT_STATUS[r.status].soft, color: REPORT_STATUS[r.status].tone }">
            {{ REPORT_STATUS[r.status].label }}
          </span>
          <span class="text-[12px]" style="color: var(--text-subtle)">
            題目 #{{ r.questionId }} · {{ fmt(r.createdAt) }}
          </span>
        </div>
        <p class="mt-1 line-clamp-1 text-[13px]">{{ r.preview }}</p>
        <p v-if="r.resolution" class="mt-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px]"
           style="background: var(--bg); color: var(--text-muted)">
          老師回覆：{{ r.resolution }}
        </p>
      </div>
    </div>
  </section>
</template>
