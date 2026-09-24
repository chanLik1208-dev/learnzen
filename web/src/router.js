import { createRouter, createWebHistory } from 'vue-router';
import { user, ready, restore } from './lib/session.js';

const routes = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { anon: true } },
  { path: '/', name: 'dashboard', component: () => import('./views/DashboardView.vue'), meta: { roles: ['STUDENT'] } },
  { path: '/practice', name: 'practice', component: () => import('./views/PracticeHubView.vue'), meta: { roles: ['STUDENT'] } },
  { path: '/practice/session/:id', name: 'practice-session', component: () => import('./views/PracticeSessionView.vue'), meta: { roles: ['STUDENT'] } },
  { path: '/wrongbook', name: 'wrongbook', component: () => import('./views/WrongBookView.vue'), meta: { roles: ['STUDENT'] } },
  { path: '/assignments', name: 'assignments', component: () => import('./views/AssignmentsView.vue'), meta: { roles: ['STUDENT'] } },
  { path: '/live', name: 'live-play', component: () => import('./views/LivePlayView.vue'), meta: { roles: ['STUDENT'] } },
  { path: '/teacher/live', name: 'live-host', component: () => import('./views/LiveHostView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  { path: '/progress', name: 'progress', component: () => import('./views/ProgressView.vue'), meta: { roles: ['STUDENT'] } },
  { path: '/teacher/bank', name: 'question-bank', component: () => import('./views/QuestionBankView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  { path: '/teacher/analytics', name: 'analytics', component: () => import('./views/ClassAnalyticsView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  { path: '/teacher/paper', name: 'create-paper', component: () => import('./views/CreatePaperView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  { path: '/teacher/scores', name: 'scores', component: () => import('./views/ScoresView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  { path: '/teacher/students/:id', name: 'student-profile', component: () => import('./views/StudentProfileView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  { path: '/teacher/topics', name: 'topic-toggle', component: () => import('./views/TopicToggleView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  { path: '/teacher/ai-reports', name: 'ai-reports', component: () => import('./views/AiReportView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  { path: '/teacher/reports', name: 'reports', component: () => import('./views/ReportsView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  { path: '/teacher/fill', name: 'fill-drafts', component: () => import('./views/FillDraftsView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  { path: '/teacher', name: 'teacher', component: () => import('./views/TeacherView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  // Everyone has an account page; the guard only needs them signed in.
  { path: '/account', name: 'account', component: () => import('./views/AccountView.vue') },
  { path: '/staff/accounts', name: 'accounts', component: () => import('./views/AccountsView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  { path: '/staff/throttle', name: 'throttle', component: () => import('./views/ThrottleView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  { path: '/teacher/students', name: 'class-students', component: () => import('./views/ClassStudentsView.vue'), meta: { roles: ['TEACHER', 'ADMIN'] } },
  { path: '/admin', name: 'admin', component: () => import('./views/AdminView.vue'), meta: { roles: ['ADMIN'] } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

/**
 * The guard mirrors the server's rules, but only as a convenience: the API
 * refuses the same things regardless of what the router lets a page render.
 * Route meta is never the thing that protects data.
 */
router.beforeEach(async (to) => {
  if (!ready.value) await restore();

  if (to.meta.anon) return user.value ? { name: homeFor(user.value.role) } : true;
  if (!user.value) return { name: 'login', query: { next: to.fullPath } };

  const allowed = to.meta.roles;
  if (allowed && !allowed.includes(user.value.role)) return { name: homeFor(user.value.role) };
  return true;
});

export const homeFor = (role) => (role === 'STUDENT' ? 'dashboard' : 'teacher');
