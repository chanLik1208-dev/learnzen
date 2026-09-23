<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { MotionConfig, AnimatePresence, motion } from 'motion-v';
import { user, ready } from './lib/session.js';
import AppShell from './components/AppShell.vue';

const route = useRoute();
const showShell = computed(() => ready.value && user.value && route.name !== 'login');
</script>

<template>
  <!-- reducedMotion="user" drops transforms and layout animation but keeps
       opacity, so someone who asked for less motion is still told the screen
       changed — they just are not moved through it. -->
  <MotionConfig reduced-motion="user">
    <AppShell v-if="showShell">
      <RouterView v-slot="{ Component }">
        <!-- mode="wait" so the outgoing page finishes before the next starts;
             two pages cross-fading in the same scroll container reads as a
             glitch rather than a transition. -->
        <AnimatePresence mode="wait" :initial="false">
          <motion.div
            :key="route.path"
            :initial="{ opacity: 0, y: 8 }"
            :animate="{ opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' } }"
            :exit="{ opacity: 0, y: 4, transition: { duration: 0.15, ease: 'easeIn' } }"
          >
            <component :is="Component" />
          </motion.div>
        </AnimatePresence>
      </RouterView>
    </AppShell>

    <RouterView v-else-if="ready" />

    <div v-else class="grid min-h-screen place-items-center">
      <span class="text-sm" style="color: var(--text-muted)">載入中…</span>
    </div>
  </MotionConfig>
</template>
