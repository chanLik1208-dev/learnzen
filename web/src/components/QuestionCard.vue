<script setup>
import { computed, ref, watch } from 'vue';
import { motion, AnimatePresence } from 'motion-v';

const props = defineProps({
  question: { type: Object, required: true },
  /** Null until answered; then { chosen, isCorrect, correctLabels, explanation }. */
  result: { type: Object, default: null },
});
const emit = defineEmits(['answer']);

const picked = ref([]);
watch(() => props.question.id, () => { picked.value = []; });

const answered = computed(() => props.result !== null);
const multi = computed(() => props.question.type === 'MSQ');
const correctSet = computed(() => new Set(props.result?.correctLabels ?? []));
const chosenSet = computed(() => new Set(
  answered.value ? (props.result.chosen?.split(',') ?? []) : picked.value,
));

const DIFFICULTY = {
  EASY: '容易', EASY_MEDIUM: '偏易', MEDIUM: '中等', MEDIUM_HARD: '偏難', HARD: '困難',
};

function toggle(label) {
  if (answered.value) return;
  if (multi.value) {
    picked.value = picked.value.includes(label)
      ? picked.value.filter((l) => l !== label)
      : [...picked.value, label];
  } else {
    picked.value = [label];
    emit('answer', picked.value);
  }
}

/**
 * Four visual states, each carrying its own colour token rather than an
 * opacity tweak — a half-transparent option would pick up whatever is behind
 * it and lose its contrast against the page.
 */
function styleFor(label) {
  if (!answered.value) {
    return chosenSet.value.has(label)
      ? { background: 'var(--primary-soft)', borderColor: 'var(--primary)', color: 'var(--primary-text)' }
      : { background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' };
  }
  if (correctSet.value.has(label)) {
    return { background: 'var(--success-soft)', borderColor: 'var(--success)', color: 'var(--success)' };
  }
  if (chosenSet.value.has(label)) {
    return { background: 'var(--danger-soft)', borderColor: 'var(--danger)', color: 'var(--danger)' };
  }
  return { background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text-disabled)' };
}
</script>

<template>
  <article class="card p-5 sm:p-6">
    <div class="mb-3 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span v-if="question.source" class="rounded px-1.5 py-0.5"
            style="background: var(--primary-soft); color: var(--primary-text)">
        {{ question.source }} {{ question.examYear }}
      </span>
      <span v-if="question.difficulty" class="rounded px-1.5 py-0.5"
            style="background: var(--bg); color: var(--text-muted)">
        {{ DIFFICULTY[question.difficulty] ?? question.difficulty }}
      </span>
      <span v-if="question.officialCorrectRate != null" class="rounded px-1.5 py-0.5"
            style="background: var(--bg); color: var(--text-muted)">
        公開答對率 {{ Math.round(question.officialCorrectRate) }}%
      </span>
    </div>

    <p class="mb-5 whitespace-pre-line text-[15px] leading-relaxed">{{ question.content }}</p>

    <div class="space-y-2">
      <motion.button
        v-for="option in question.options" :key="option.label"
        type="button"
        class="flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left text-[14px] leading-relaxed"
        :style="{
          ...styleFor(option.label),
          transition: 'background-color .14s ease-out, border-color .14s ease-out, color .14s ease-out, box-shadow .2s ease-out',
          cursor: answered ? 'default' : 'pointer',
        }"
        :while-hover="answered ? {} : { y: -2 }"
        :while-press="answered ? {} : { scale: 0.99 }"
        :transition="{ type: 'spring', visualDuration: 0.18, bounce: 0 }"
        :disabled="answered"
        @click="toggle(option.label)"
      >
        <span
          class="grid h-6 w-6 shrink-0 place-items-center rounded-lg border text-[12px] font-semibold"
          :style="{ borderColor: 'currentColor' }"
        >{{ option.label }}</span>
        <span class="pt-0.5">{{ option.content }}</span>

        <!-- The verdict mark arrives on a spring: it is a thing appearing, not
             a colour changing, so it gets mass. -->
        <motion.span
          v-if="answered && (correctSet.has(option.label) || chosenSet.has(option.label))"
          class="ml-auto pt-0.5"
          :initial="{ scale: 0, opacity: 0 }"
          :animate="{ scale: 1, opacity: 1 }"
          :transition="{ type: 'spring', visualDuration: 0.25, bounce: 0.3 }"
        >
          <svg v-if="correctSet.has(option.label)" width="17" height="17" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="m5 13 4 4L19 7" />
          </svg>
          <svg v-else width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </motion.span>
      </motion.button>
    </div>

    <div v-if="multi && !answered" class="mt-3 flex justify-end">
      <button class="btn btn-primary" :disabled="picked.length === 0" @click="emit('answer', picked)">
        確認作答
      </button>
    </div>

    <!-- Height animates from 0 so the page below is pushed rather than
         jumping; the explanation is long, and a jump loses the reader. -->
    <AnimatePresence>
      <motion.div
        v-if="answered && result.explanation" key="explain"
        :initial="{ opacity: 0, height: 0 }"
        :animate="{ opacity: 1, height: 'auto', transition: { duration: 0.28, ease: 'easeOut' } }"
        :exit="{ opacity: 0, height: 0, transition: { duration: 0.16, ease: 'easeIn' } }"
        class="overflow-hidden"
      >
        <div class="mt-5 rounded-xl p-4" style="background: var(--bg)">
          <div class="mb-1.5 flex items-center gap-1.5 text-xs font-semibold"
               :style="{ color: result.isCorrect ? 'var(--success)' : 'var(--danger)' }">
            {{ result.isCorrect ? '答對了' : `答錯了 · 正確答案 ${result.correctLabels.join('、')}` }}
          </div>
          <p class="whitespace-pre-line text-[13.5px] leading-relaxed" style="color: var(--text-muted)">
            {{ result.explanation }}
          </p>
        </div>
      </motion.div>
    </AnimatePresence>
  </article>
</template>
