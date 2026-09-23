<script setup>
import { computed, onMounted, ref } from 'vue';
import { motion } from 'motion-v';
import { api } from '../lib/api.js';

const classes = ref([]);
const assignments = ref([]);
const draftCount = ref(null);
const activeCount = ref(null);
const loading = ref(true);
const error = ref('');

onMounted(async () => {
  const [c, a, d, bank] = await Promise.allSettled([
    api.get('/api/teacher/classes'),
    api.get('/api/teacher/assignments'),
    api.get('/api/teacher/questions/drafts?limit=1'),
    api.get('/api/teacher/questions?status=ACTIVE&limit=1'),
  ]);
  if (c.status === 'fulfilled') classes.value = c.value.classes;
  else error.value = c.reason.message;
  if (a.status === 'fulfilled') assignments.value = a.value.assignments;
  if (d.status === 'fulfilled') draftCount.value = d.value.total;
  if (bank.status === 'fulfilled') activeCount.value = bank.value.total;
  loading.value = false;
});

const needsAttention = computed(() => assignments.value.filter(
  (a) => a.status === 'PUBLISHED' && a.submittedCount < a.studentCount,
));

const fmt = (ms) => (ms == null ? '無截止' : new Date(ms).toLocaleDateString('zh-HK',
  { month: 'numeric', day: 'numeric' }));

const STATUS = { PUBLISHED: '已發佈', DRAFT: '草稿', CLOSED: '已結束' };
</script>

<template>
  <h1 class="mb-5 text-xl font-semibold">教師端</h1>

  <p v-if="error" class="mb-4 rounded-lg px-3 py-2 text-sm"
     style="background: var(--danger-soft); color: var(--danger)">{{ error }}</p>

  <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <template v-else>
    <div class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <motion.div
        v-for="(s, i) in [
          { label: '班別', value: classes.length, unit: ' 班' },
          { label: '已發佈作業', value: assignments.filter((a) => a.status === 'PUBLISHED').length, unit: ' 份' },
          { label: '可出卷題目', value: activeCount, unit: ' 題', tone: 'var(--success)' },
          { label: '待補選項', value: draftCount, unit: ' 題', tone: 'var(--warning)' },
        ]" :key="s.label"
        class="card p-4"
        :initial="{ opacity: 0, y: 10 }" :animate="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.25, ease: 'easeOut', delay: i * 0.04 }"
      >
        <div class="text-[11px]" style="color: var(--text-muted)">{{ s.label }}</div>
        <div class="mt-1 text-2xl font-bold tabular-nums" :style="{ color: s.tone ?? 'var(--text)' }">
          <span v-if="s.value === null" class="text-sm font-normal" style="color: var(--text-subtle)">
            讀取失敗
          </span>
          <template v-else>{{ s.value }}<span class="text-sm font-medium">{{ s.unit }}</span></template>
        </div>
      </motion.div>
    </div>

    <div class="mb-6 grid gap-3 sm:grid-cols-3">
      <RouterLink
        v-for="(link, i) in [
          { to: 'create-paper', title: '組卷', desc: '從題庫挑題發佈給班別' },
          { to: 'fill-drafts', title: '補齊題目', desc: draftCount ? `還有 ${draftCount} 題缺選項` : '題庫已補齊' },
          { to: 'topic-toggle', title: '課題開關', desc: '控制各班能練哪些課題' },
        ]" :key="link.to" :to="{ name: link.to }"
      >
        <motion.div
          class="card card-interactive h-full p-4"
          :initial="{ opacity: 0, y: 10 }" :animate="{ opacity: 1, y: 0 }"
          :transition="{ duration: 0.25, ease: 'easeOut', delay: 0.15 + i * 0.04 }"
          :while-hover="{ y: -3 }"
        >
          <div class="text-sm font-semibold">{{ link.title }}</div>
          <div class="mt-0.5 text-[11px]" style="color: var(--text-subtle)">{{ link.desc }}</div>
        </motion.div>
      </RouterLink>
    </div>

    <section class="mb-6">
      <div class="mb-2.5 flex items-center justify-between">
        <h2 class="text-base font-semibold">作業</h2>
        <RouterLink :to="{ name: 'scores' }" class="text-xs hover:underline"
                    style="color: var(--primary-text)">看成績 →</RouterLink>
      </div>

      <div v-if="assignments.length === 0" class="card p-8 text-center text-sm"
           style="color: var(--text-muted)">尚未建立作業</div>

      <div v-else class="space-y-2.5">
        <RouterLink
          v-for="(a, i) in assignments" :key="a.id"
          :to="{ name: 'scores', query: { id: a.id } }"
        >
          <motion.div
            class="card card-interactive flex items-center justify-between p-4"
            :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }"
            :transition="{ duration: 0.22, ease: 'easeOut', delay: 0.2 + i * 0.03 }"
            :while-hover="{ y: -2 }"
          >
            <div>
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium">{{ a.title }}</span>
                <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                      :style="a.status === 'PUBLISHED'
                        ? { background: 'var(--success-soft)', color: 'var(--success)' }
                        : { background: 'var(--bg)', color: 'var(--text-muted)' }">
                  {{ STATUS[a.status] }}
                </span>
              </div>
              <div class="mt-0.5 text-[11px]" style="color: var(--text-subtle)">
                {{ a.code }} · 滿分 {{ a.maxScore }} · 截止 {{ fmt(a.dueAt) }}
              </div>
            </div>

            <div class="text-right">
              <div class="text-sm tabular-nums" style="color: var(--text-muted)">
                {{ a.submittedCount }}/{{ a.studentCount }}
              </div>
              <div class="text-[10px]" style="color: var(--text-subtle)">已交</div>
            </div>
          </motion.div>
        </RouterLink>
      </div>
    </section>

    <section v-if="needsAttention.length">
      <h2 class="mb-2.5 text-base font-semibold">尚有學生未交</h2>
      <div class="card p-4">
        <p v-for="a in needsAttention" :key="a.id" class="py-1 text-sm">
          <span class="font-medium">{{ a.title }}</span>
          <span style="color: var(--text-muted)">
            —— {{ a.studentCount - a.submittedCount }} 人未交，截止 {{ fmt(a.dueAt) }}
          </span>
        </p>
      </div>
    </section>
  </template>
</template>
