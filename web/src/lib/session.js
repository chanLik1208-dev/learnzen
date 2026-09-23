import { reactive, computed } from 'vue';
import { api, setToken, clearToken, sessionExpired } from './api.js';

const state = reactive({
  user: null,
  /** Null until the first restore attempt settles, so guards can wait. */
  ready: false,
});

export const user = computed(() => state.user);
export const ready = computed(() => state.ready);
export const isStudent = computed(() => state.user?.role === 'STUDENT');
export const isTeacher = computed(() => ['TEACHER', 'ADMIN'].includes(state.user?.role));

/**
 * Called once at boot. A failure here is the ordinary "not logged in" case,
 * not an error worth showing — the refresh cookie simply is not there.
 */
export async function restore() {
  try {
    state.user = await api.refresh();
  } catch {
    state.user = null;
  } finally {
    state.ready = true;
  }
  return state.user;
}

export async function login(username, password) {
  const data = await api.post('/api/auth/login', { username, password }, { auth: false });
  setToken(data.accessToken);
  state.user = data.user;
  return data.user;
}

export async function logout() {
  try {
    await api.post('/api/auth/logout', {}, { auth: false });
  } finally {
    clearToken();
    state.user = null;
    sessionExpired.value = false;
  }
}

export { sessionExpired };
