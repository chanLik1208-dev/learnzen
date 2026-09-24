<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { motion, AnimatePresence } from 'motion-v';
import { api } from '../lib/api.js';

const users = ref([]);
const classes = ref([]);
const mayManageStaff = ref(false);
const loading = ref(true);
const error = ref('');
const notice = ref('');

const filters = ref({ role: '', classId: '', q: '' });

/** Which panel is open: nothing, the single form, or the bulk one. */
const panel = ref(null);
const draft = ref({ username: '', displayName: '', password: '', role: 'STUDENT', classId: '' });
const bulk = ref({ classId: '', text: '' });
const bulkResult = ref(null);
const copied = ref(false);
const editing = ref(null);
const busy = ref(false);

const ROLE = { STUDENT: '學生', TEACHER: '教師', ADMIN: '管理員' };

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters.value)) if (v) params.set(k, v);
    const [u, c] = await Promise.all([
      api.get(`/api/staff/users?${params}`),
      api.get('/api/teacher/classes'),
    ]);
    users.value = u.users;
    mayManageStaff.value = u.mayManageStaff;
    classes.value = c.classes;
    if (!draft.value.classId) draft.value.classId = c.classes[0]?.id ?? '';
    if (!bulk.value.classId) bulk.value.classId = c.classes[0]?.id ?? '';
    error.value = '';
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(filters, load, { deep: true });

const classOptions = computed(() => classes.value);
const canSubmitOne = computed(() => draft.value.username.trim().length >= 3
  && draft.value.password.length >= 8
  && (draft.value.role !== 'STUDENT' || draft.value.classId));

/**
 * One student per line: username, name, password. Only the username is
 * required; a row with no password gets a generated one, which comes back in
 * the result so it can be handed over.
 */
const parsed = computed(() => bulk.value.text
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [username, displayName, password] = line.split(/[,\t]/).map((s) => (s ?? '').trim());
    return { username, displayName: displayName || username, password: password || undefined };
  })
  .filter((r) => r.username));

async function createOne() {
  if (!canSubmitOne.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const res = await api.post('/api/staff/users', {
      ...draft.value,
      classId: draft.value.role === 'STUDENT' ? Number(draft.value.classId) : null,
    });
    notice.value = `已建立 ${res.user.username}`;
    draft.value = { ...draft.value, username: '', displayName: '', password: '' };
    panel.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function importMany() {
  if (parsed.value.length === 0 || busy.value) return;
  busy.value = true;
  error.value = '';
  bulkResult.value = null;
  try {
    bulkResult.value = await api.post('/api/staff/users/import', {
      classId: Number(bulk.value.classId),
      students: parsed.value,
    });
    // The list is kept on screen even on success: it holds passwords that
    // exist nowhere else, so clearing the form would throw them away.
    bulk.value.text = '';
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function copyCredentials() {
  // Tab-separated so it pastes straight into a spreadsheet.
  const text = bulkResult.value.created
    .map((c) => [c.username, c.displayName, c.password].join('\t'))
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    error.value = '瀏覽器不允許複製，請手動選取上面的名單';
  }
}

async function saveEdit() {
  busy.value = true;
  error.value = '';
  try {
    const patch = { displayName: editing.value.displayName };
    if (mayManageStaff.value) {
      patch.role = editing.value.role;
      patch.status = editing.value.status;
    }
    if (editing.value.role === 'STUDENT') patch.classId = Number(editing.value.classId) || null;
    await api.patch(`/api/staff/users/${editing.value.id}`, patch);
    notice.value = '已更新';
    editing.value = null;
    await load();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

async function resetPassword(user) {
  const next = window.prompt(`把 ${user.displayName}（${user.username}）的密碼設為：`, '');
  if (!next) return;
  try {
    await api.post(`/api/staff/users/${user.id}/password`, { newPassword: next });
    // Saying this plainly matters: the student is about to be signed out of
    // every device, which is surprising if nobody mentions it.
    notice.value = `${user.username} 的密碼已重設，該帳號所有裝置都已登出`;
  } catch (err) {
    error.value = err.message;
  }
}

const statusTone = (s) => (s === 'ACTIVE'
  ? { background: 'var(--success-soft)', color: 'var(--success)' }
  : { background: 'var(--bg)', color: 'var(--text-disabled)' });
</script>

<template>
  <div class="mb-5 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-xl font-semibold">帳號</h1>
      <p class="text-sm" style="color: var(--text-muted)">
        {{ mayManageStaff ? '全站帳號與角色' : '你任教班別的學生' }}
      </p>
    </div>
    <div class="flex gap-2">
      <button class="btn btn-ghost" @click="panel = panel === 'bulk' ? null : 'bulk'">批次匯入</button>
      <button class="btn btn-primary" @click="panel = panel === 'one' ? null : 'one'">新增帳號</button>
    </div>
  </div>

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

  <!-- create one ───────────────────────────────────────────────────── -->
  <AnimatePresence>
    <motion.section
      v-if="panel === 'one'" key="one"
      :initial="{ opacity: 0, height: 0 }"
      :animate="{ opacity: 1, height: 'auto', transition: { duration: 0.26, ease: 'easeOut' } }"
      :exit="{ opacity: 0, height: 0, transition: { duration: 0.15, ease: 'easeIn' } }"
      class="mb-5 overflow-hidden"
    >
      <div class="card p-5">
        <h2 class="mb-3 text-sm font-semibold">新增帳號</h2>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">帳號</span>
            <input v-model="draft.username" class="field" placeholder="英數字 3–32" />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">姓名</span>
            <input v-model="draft.displayName" class="field" />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">初始密碼（至少 8 字元）</span>
            <input v-model="draft.password" class="field" />
          </label>
          <!-- Only an administrator is offered the other roles: a teacher
               cannot create one, and offering it would just invite a 403. -->
          <label v-if="mayManageStaff" class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">角色</span>
            <select v-model="draft.role" class="field">
              <option value="STUDENT">學生</option>
              <option value="TEACHER">教師</option>
              <option value="ADMIN">管理員</option>
            </select>
          </label>
          <label v-if="draft.role === 'STUDENT'" class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">班別</span>
            <select v-model="draft.classId" class="field">
              <option v-for="c in classOptions" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
        </div>
        <div class="mt-4 flex justify-end gap-2">
          <button class="btn btn-ghost" @click="panel = null">取消</button>
          <button class="btn btn-primary" :disabled="!canSubmitOne || busy" @click="createOne">建立</button>
        </div>
      </div>
    </motion.section>

    <!-- bulk ───────────────────────────────────────────────────────── -->
    <motion.section
      v-else-if="panel === 'bulk'" key="bulk"
      :initial="{ opacity: 0, height: 0 }"
      :animate="{ opacity: 1, height: 'auto', transition: { duration: 0.26, ease: 'easeOut' } }"
      :exit="{ opacity: 0, height: 0, transition: { duration: 0.15, ease: 'easeIn' } }"
      class="mb-5 overflow-hidden"
    >
      <div class="card p-5">
        <h2 class="mb-1 text-sm font-semibold">批次匯入學生</h2>
        <p class="mb-3 text-[12px]" style="color: var(--text-subtle)">
          一行一人：<code>帳號, 姓名, 密碼</code>。姓名和密碼可省略；沒填密碼會自動產生一組，匯入後會列出來讓你發給學生。
        </p>

        <div class="grid gap-3 lg:grid-cols-[14rem_1fr]">
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">匯入到班別</span>
            <select v-model="bulk.classId" class="field">
              <option v-for="c in classOptions" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">
              名單（已辨識 {{ parsed.length }} 人）
            </span>
            <textarea v-model="bulk.text" class="field font-mono text-[13px]" rows="6"
                      placeholder="s101, 陳大文&#10;s102, 李小明, pw-li-12345"></textarea>
          </label>
        </div>

        <AnimatePresence>
          <motion.div
            v-if="bulkResult" key="result"
            :initial="{ opacity: 0, height: 0 }" :animate="{ opacity: 1, height: 'auto' }"
            :exit="{ opacity: 0, height: 0 }"
            class="mt-3 overflow-hidden"
          >
            <div class="rounded-lg p-3 text-[13px]" style="background: var(--bg)">
              建立 {{ bulkResult.createdCount }} 人<template v-if="bulkResult.failedCount">
                ，<span style="color: var(--danger)">失敗 {{ bulkResult.failedCount }} 人</span>
              </template>

              <!-- Shown once and never again: the server stores only a hash,
                   so this is the only moment these passwords exist. -->
              <template v-if="bulkResult.created.length">
                <div class="mt-3 flex items-center justify-between">
                  <span class="font-semibold" style="color: var(--warning)">
                    初始密碼只會顯示這一次，請先複製
                  </span>
                  <button class="btn btn-ghost !px-2 !py-1 !text-[12px]" @click="copyCredentials">
                    {{ copied ? '已複製' : '複製名單' }}
                  </button>
                </div>
                <div class="mt-1.5 max-h-48 overflow-y-auto rounded-md p-2 font-mono text-[12px]"
                     style="background: var(--surface)">
                  <div v-for="c in bulkResult.created" :key="c.id" class="flex gap-3 py-0.5">
                    <span class="w-28 shrink-0">{{ c.username }}</span>
                    <span class="w-24 shrink-0" style="color: var(--text-muted)">{{ c.displayName }}</span>
                    <span :style="{ color: c.generated ? 'var(--primary-text)' : 'var(--text-subtle)' }">
                      {{ c.password }}
                    </span>
                  </div>
                </div>
              </template>

              <!-- The failures are listed individually because the point of
                   importing row by row is knowing which ones to fix. -->
              <ul v-if="bulkResult.failedCount" class="mt-2 space-y-0.5">
                <li v-for="f in bulkResult.failed" :key="f.username" style="color: var(--danger)">
                  <span class="font-mono">{{ f.username }}</span> —— {{ f.reason }}
                </li>
              </ul>
            </div>
          </motion.div>
        </AnimatePresence>

        <div class="mt-4 flex justify-end gap-2">
          <button class="btn btn-ghost" @click="panel = null; bulkResult = null">關閉</button>
          <button class="btn btn-primary" :disabled="parsed.length === 0 || busy" @click="importMany">
            匯入 {{ parsed.length }} 人
          </button>
        </div>
      </div>
    </motion.section>
  </AnimatePresence>

  <!-- filters ──────────────────────────────────────────────────────── -->
  <div class="mb-4 flex flex-wrap gap-2">
    <input v-model="filters.q" class="field !w-auto flex-1" placeholder="搜尋帳號或姓名…" />
    <select v-if="mayManageStaff" v-model="filters.role" class="field !w-auto">
      <option value="">全部角色</option>
      <option value="STUDENT">學生</option>
      <option value="TEACHER">教師</option>
      <option value="ADMIN">管理員</option>
    </select>
    <select v-model="filters.classId" class="field !w-auto">
      <option value="">全部班別</option>
      <option v-for="c in classOptions" :key="c.id" :value="c.id">{{ c.name }}</option>
    </select>
  </div>

  <div v-if="loading" class="py-16 text-center text-sm" style="color: var(--text-muted)">載入中…</div>

  <div v-else-if="users.length === 0" class="card p-10 text-center text-sm" style="color: var(--text-muted)">
    沒有符合的帳號
  </div>

  <div v-else class="card divide-y p-0" style="border-color: var(--border)">
    <motion.div
      v-for="(u, i) in users" :key="u.id"
      class="flex flex-wrap items-center gap-3 px-4 py-3"
      :initial="{ opacity: 0, x: -6 }" :animate="{ opacity: 1, x: 0 }"
      :transition="{ duration: 0.2, ease: 'easeOut', delay: Math.min(i, 20) * 0.02 }"
      layout
    >
      <div class="min-w-0 flex-1">
        <span class="text-sm font-medium"
              :style="{ color: u.status === 'ACTIVE' ? 'var(--text)' : 'var(--text-disabled)' }">
          {{ u.displayName }}
        </span>
        <span class="ml-2 font-mono text-[11px]" style="color: var(--text-subtle)">{{ u.username }}</span>
      </div>

      <span class="rounded-full px-2 py-0.5 text-[11px]"
            style="background: var(--bg); color: var(--text-muted)">{{ ROLE[u.role] }}</span>
      <span v-if="u.className" class="text-[12px]" style="color: var(--text-muted)">{{ u.className }}</span>
      <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold" :style="statusTone(u.status)">
        {{ u.status === 'ACTIVE' ? '啟用' : '停用' }}
      </span>

      <div class="flex gap-1.5">
        <button class="btn btn-ghost !px-2 !py-1 !text-[12px]"
                @click="editing = { ...u, classId: u.classId ?? '' }">編輯</button>
        <button class="btn btn-ghost !px-2 !py-1 !text-[12px]" @click="resetPassword(u)">重設密碼</button>
      </div>
    </motion.div>
  </div>

  <!-- edit ─────────────────────────────────────────────────────────── -->
  <AnimatePresence>
    <motion.div
      v-if="editing" key="edit"
      class="fixed inset-0 z-50 grid place-items-center p-4"
      :initial="{ opacity: 0 }" :animate="{ opacity: 1 }" :exit="{ opacity: 0 }"
      :transition="{ duration: 0.18 }"
      style="background: rgb(0 0 0 / 0.4)"
      @click.self="editing = null"
    >
      <motion.div
        class="card w-full max-w-md p-6"
        style="box-shadow: var(--shadow-4)"
        :initial="{ scale: 0.97, y: 8 }" :animate="{ scale: 1, y: 0 }" :exit="{ scale: 0.98, opacity: 0 }"
        :transition="{ type: 'spring', visualDuration: 0.25, bounce: 0 }"
      >
        <h2 class="mb-4 text-base font-semibold">
          編輯 <span class="font-mono text-sm" style="color: var(--text-muted)">{{ editing.username }}</span>
        </h2>

        <div class="space-y-3">
          <label class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">姓名</span>
            <input v-model="editing.displayName" class="field" />
          </label>
          <label v-if="editing.role === 'STUDENT'" class="block">
            <span class="mb-1 block text-xs" style="color: var(--text-muted)">班別</span>
            <select v-model="editing.classId" class="field">
              <option v-for="c in classOptions" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
          <template v-if="mayManageStaff">
            <label class="block">
              <span class="mb-1 block text-xs" style="color: var(--text-muted)">角色</span>
              <select v-model="editing.role" class="field">
                <option value="STUDENT">學生</option>
                <option value="TEACHER">教師</option>
                <option value="ADMIN">管理員</option>
              </select>
            </label>
            <label class="block">
              <span class="mb-1 block text-xs" style="color: var(--text-muted)">狀態</span>
              <select v-model="editing.status" class="field">
                <option value="ACTIVE">啟用</option>
                <option value="DISABLED">停用</option>
              </select>
            </label>
            <p class="rounded-lg px-2.5 py-1.5 text-[11px]"
               style="background: var(--warning-soft); color: var(--warning)">
              變更角色或停用會立刻結束該帳號的所有登入。帳號不會被刪除——刪掉會連同他的作答和成績一起消失。
            </p>
          </template>
        </div>

        <div class="mt-5 flex justify-end gap-2">
          <button class="btn btn-ghost" @click="editing = null">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="saveEdit">儲存</button>
        </div>
      </motion.div>
    </motion.div>
  </AnimatePresence>
</template>
