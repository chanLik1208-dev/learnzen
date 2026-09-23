<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { motion } from 'motion-v';
import { user, isStudent, logout } from '../lib/session.js';

const route = useRoute();
const router = useRouter();

const studentNav = [
  { name: 'dashboard', label: '首頁', icon: 'M3 10.5 12 3l9 7.5M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5' },
  { name: 'assignments', label: '作業', icon: 'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM9 8h6M9 12h6M9 16h3' },
  { name: 'practice', label: '練習', icon: 'M12 5v16M20 19a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2l-4 0a5 5 0 0 0-4 2 5 5 0 0 0-4-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4a5 5 0 0 1 4 2 5 5 0 0 1 4-2Z' },
  { name: 'wrongbook', label: '錯題本', icon: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z' },
  { name: 'account', label: '我的', icon: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z' },
];
const teacherNav = [
  { name: 'teacher', label: '總覽', icon: 'M3 10.5 12 3l9 7.5M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5' },
  { name: 'create-paper', label: '組卷', icon: 'M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM9 8h6M9 12h6M9 16h3' },
  { name: 'scores', label: '成績', icon: 'M3 3v16a2 2 0 0 0 2 2h16M7 16l4-5 3 3 5-7' },
  { name: 'fill-drafts', label: '補齊題目', icon: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z' },
  { name: 'class-students', label: '學生', icon: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z' },
  { name: 'topic-toggle', label: '課題開關', icon: 'M16 3H8a5 5 0 0 0 0 10h8a5 5 0 0 0 0-10ZM16 8a3 3 0 1 1 0 .01' },
  { name: 'throttle', label: '連線節流', icon: 'M12 2v4M12 18v4M4.9 4.9l2.9 2.9M16.2 16.2l2.9 2.9M2 12h4M18 12h4M4.9 19.1l2.9-2.9M16.2 7.8l2.9-2.9' },
  { name: 'account', label: '我的', icon: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z' },
];

/** Only an administrator sees the site-wide settings. */
const adminNav = [
  { name: 'admin', label: '系統管理', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z' },
];

const nav = computed(() => {
  if (isStudent.value) return studentNav;
  return user.value?.role === 'ADMIN' ? [...teacherNav, ...adminNav] : teacherNav;
});
/** The phone bar holds five comfortably; anything past that goes to 總覽. */
const barNav = computed(() => nav.value.slice(0, 5));
const CHILD_OF = { practice: ['practice-session'], scores: ['student-profile'] };
const active = (name) => route.name === name || (CHILD_OF[name] ?? []).includes(route.name);

async function signOut() {
  await logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <div class="min-h-screen">
    <header
      class="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between px-4 sm:px-6"
      style="background: var(--surface); border-bottom: 1px solid var(--border); box-shadow: var(--shadow-1)"
    >
      <div class="flex min-w-0 items-center gap-2.5">
        <div class="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style="background: var(--primary)">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5v16M20 19a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2l-4 0a5 5 0 0 0-4 2 5 5 0 0 0-4-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4a5 5 0 0 1 4 2 5 5 0 0 1 4-2Z" />
          </svg>
        </div>
        <span class="truncate font-semibold">LearnZen</span>
      </div>

      <div class="flex items-center gap-3">
        <span class="hidden text-sm sm:inline" style="color: var(--text-muted)">
          {{ user?.displayName }}
        </span>
        <motion.button
          :while-hover="{ y: -1 }"
          :while-press="{ scale: 0.96 }"
          :transition="{ type: 'spring', visualDuration: 0.15, bounce: 0 }"
          class="btn btn-ghost !px-2.5 !py-1.5"
          aria-label="登出"
          @click="signOut"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m16 17 5-5-5-5M21 12H9M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          </svg>
        </motion.button>
      </div>
    </header>

    <aside
      class="fixed bottom-0 left-0 top-14 z-30 hidden w-52 p-3 xl:block"
      style="background: var(--surface); border-right: 1px solid var(--border)"
    >
      <nav class="space-y-1">
        <RouterLink
          v-for="item in nav" :key="item.name" :to="{ name: item.name }"
          class="relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150"
          :style="active(item.name)
            ? { background: 'var(--primary-soft)', color: 'var(--primary-text)' }
            : { color: 'var(--text-muted)' }"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path :d="item.icon" />
          </svg>
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>

    <main class="px-4 pb-24 pt-[4.5rem] sm:px-6 xl:ml-52 xl:pb-8">
      <div class="mx-auto max-w-5xl">
        <slot />
      </div>
    </main>

    <nav
      class="fixed inset-x-0 bottom-0 z-40 flex h-16 items-stretch xl:hidden"
      style="background: var(--surface); border-top: 1px solid var(--border);
             padding-bottom: env(safe-area-inset-bottom)"
    >
      <RouterLink
        v-for="item in barNav" :key="item.name" :to="{ name: item.name }"
        class="flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors duration-150"
        :style="{ color: active(item.name) ? 'var(--primary-text)' : 'var(--text-subtle)' }"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path :d="item.icon" />
        </svg>
        {{ item.label }}
      </RouterLink>
    </nav>
  </div>
</template>
