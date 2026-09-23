<script setup>
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { motion } from 'motion-v';
import { api } from '../lib/api.js';

const route = useRoute();
const data = ref(null);
const loading = ref(true);
const error = ref('');

onMounted(async () => {
  try {
    data.value = await api.get(`/api/teacher/students/${route.params.id}/profile`);
  } catch (err) {
    // 403 here is the class-scope check refusing a student who is not yours.
    error.value = err.status === 403 ? '這名學生不在你任教的班別' : err.message;
  } finally {
    loading.value = false;
  }
});

const pct = (n) => Math.round(n * 100);
const fmt = (ms) => new Date(ms).toLocaleDateString('zh-HK', { month: 'numeric', day: 'numeric' });
</script>

<template>
  <RouterLink :to="{ name: 'scores' }" class="btn btn-ghost mb-4 !py-1.5 !text-[13px]">← 返回</RouterLink>

  <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <div v-else-if="error" class="card p-10 text-center text-sm" style="color: var(--danger)">
    {{ error }}
  </div>

  <template v-else>
    <h1 class="text-xl font-semibold">{{ data.student.displayName }}</h1>
    <p class="mb-5 text-sm" style="color: var(--text-muted)">
      {{ data.student.username }} · 待重做 {{ data.openWrongCount }} 題
    </p>

    <section class="mb-6">
      <h2 class="mb-2.5 text-base font-semibold">各課題掌握度</h2>
      <div v-if="data.topics.length === 0" class="card p-8 text-center text-sm"
           style="color: var(--text-muted)">這名學生還沒作答過任何題目</div>

      <div v-else class="card divide-y p-0" style="border-color: var(--border)">
        <motion.div
          v-for="(t, i) in data.topics" :key="t.topicId"
          class="flex items-center gap-3 px-4 py-3"
          :initial="{ opacity: 0, x: -8 }" :animate="{ opacity: 1, x: 0 }"
          :transition="{ duration: 0.22, ease: 'easeOut', delay: i * 0.03 }"
        >
          <span class="w-24 shrink-0 text-sm">{{ t.name }}</span>
          <div class="h-1.5 flex-1 overflow-hidden rounded-full" style="background: var(--border)">
            <motion.div
              class="h-full origin-left rounded-full"
              :style="{ background: t.accuracy >= 0.6 ? 'var(--success)' : 'var(--danger)' }"
              :initial="{ scaleX: 0 }" :animate="{ scaleX: t.accuracy ?? 0 }"
              :transition="{ type: 'spring', visualDuration: 0.5, bounce: 0, delay: 0.1 + i * 0.03 }"
            />
          </div>
          <span class="w-24 text-right text-[12px] tabular-nums" style="color: var(--text-muted)">
            {{ t.accuracy === null ? '未作答' : `${pct(t.accuracy)}%（${t.answered} 題）` }}
          </span>
        </motion.div>
      </div>
    </section>

    <section>
      <h2 class="mb-2.5 text-base font-semibold">作業記錄</h2>
      <div v-if="data.recentSubmissions.length === 0" class="card p-8 text-center text-sm"
           style="color: var(--text-muted)">沒有已提交的作業</div>

      <div v-else class="space-y-2">
        <motion.div
          v-for="(s, i) in data.recentSubmissions" :key="s.assignmentId"
          class="card flex items-center justify-between p-4"
          :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.22, ease: 'easeOut', delay: 0.1 + i * 0.03 }"
        >
          <div>
            <div class="text-sm font-medium">{{ s.title }}</div>
            <div class="text-[11px]" style="color: var(--text-subtle)">
              {{ s.code }} · {{ fmt(s.submittedAt) }}
              <span v-if="s.late" style="color: var(--warning)">· 遲交</span>
            </div>
          </div>
          <div class="text-right tabular-nums">
            <span class="text-base font-bold">{{ s.score }}</span>
            <span class="text-xs" style="color: var(--text-subtle)">/{{ s.maxScore }}</span>
          </div>
        </motion.div>
      </div>
    </section>
  </template>
</template>
