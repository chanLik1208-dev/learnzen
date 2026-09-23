<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { motion, AnimatePresence } from 'motion-v';
import { login } from '../lib/session.js';
import { homeFor } from '../router.js';

const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  if (busy.value) return;
  error.value = '';
  busy.value = true;
  try {
    const me = await login(username.value.trim(), password.value);
    router.push(route.query.next ?? { name: homeFor(me.role) });
  } catch (err) {
    error.value = err.message ?? '登入失敗';
    password.value = '';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="grid min-h-screen place-items-center px-4 py-10">
    <motion.div
      :initial="{ opacity: 0, y: 12 }"
      :animate="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.3, ease: 'easeOut' }"
      class="card w-full max-w-sm p-7"
      style="box-shadow: var(--shadow-3)"
    >
      <div class="mb-6 flex items-center gap-3">
        <div class="grid h-10 w-10 place-items-center rounded-xl" style="background: var(--primary)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v16M20 19a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2l-4 0a5 5 0 0 0-4 2 5 5 0 0 0-4-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4a5 5 0 0 1 4 2 5 5 0 0 1 4-2Z" />
          </svg>
        </div>
        <div>
          <h1 class="text-lg font-semibold leading-tight">LearnZen</h1>
          <p class="text-xs" style="color: var(--text-muted)">登入以繼續</p>
        </div>
      </div>

      <form class="space-y-3.5" @submit.prevent="submit">
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium" style="color: var(--text-muted)">帳號</span>
          <input v-model="username" class="field" autocomplete="username" required autofocus />
        </label>

        <label class="block">
          <span class="mb-1.5 block text-xs font-medium" style="color: var(--text-muted)">密碼</span>
          <input v-model="password" type="password" class="field" autocomplete="current-password" required />
        </label>

        <!-- The error slides in from just above the button so the eye finds it
             without hunting; it leaves faster than it arrived. -->
        <AnimatePresence>
          <motion.p
            v-if="error" key="err"
            :initial="{ opacity: 0, height: 0, y: -4 }"
            :animate="{ opacity: 1, height: 'auto', y: 0, transition: { duration: 0.22, ease: 'easeOut' } }"
            :exit="{ opacity: 0, height: 0, transition: { duration: 0.14, ease: 'easeIn' } }"
            class="overflow-hidden rounded-lg px-3 py-2 text-sm"
            style="background: var(--danger-soft); color: var(--danger)"
          >
            {{ error }}
          </motion.p>
        </AnimatePresence>

        <motion.button
          type="submit" class="btn btn-primary w-full" :disabled="busy"
          :while-press="busy ? {} : { scale: 0.98 }"
          :transition="{ type: 'spring', visualDuration: 0.12, bounce: 0 }"
        >
          {{ busy ? '登入中…' : '登入' }}
        </motion.button>
      </form>
    </motion.div>
  </div>
</template>
