/**
 * Screenshot the running app through the Chrome DevTools Protocol.
 *
 * `chrome --screenshot` alone is not enough here: it runs under virtual time,
 * which does not reliably advance requestAnimationFrame, so entry animations
 * are captured mid-flight and everything looks half-faded. Driving a real
 * headless session instead lets us log in, wait for the animation to settle,
 * and shoot each page at both desktop and phone widths.
 *
 *   node scripts/shoot.mjs [baseUrl] [--out dir] [--head]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith('http')) ?? 'http://localhost:8787';
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'shots';
const PORT = 9333;

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
];
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) throw new Error('找不到 Chrome');

mkdirSync(outDir, { recursive: true });

const chrome = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--user-data-dir=' + join(process.env.TEMP ?? '/tmp', `lb-shoot-${Date.now()}`),
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function debuggerUrl() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch { await sleep(200); }
  }
  throw new Error('Chrome 沒有開起來');
}

/** Minimal CDP client over the global WebSocket. */
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const sessions = new Set();
  let id = 0;

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });

  const ready = new Promise((resolve) => ws.addEventListener('open', resolve));

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    id += 1;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  return { ready, send, close: () => ws.close(), sessions };
}

const cdp = connect(await debuggerUrl());
await cdp.ready;

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const call = (method, params) => cdp.send(method, params, sessionId);

await call('Page.enable');
await call('Runtime.enable');

async function setViewport(width, height, mobile = false) {
  await call('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: mobile ? 2 : 1, mobile,
  });
}

async function go(path, settle = 1200) {
  await call('Page.navigate', { url: base + path });
  await sleep(settle);
}

const evaluate = async (expression) => (await call('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
})).result?.value;

async function shoot(name) {
  const { data } = await call('Page.captureScreenshot', { format: 'png' });
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('  ', file);
}

// ---------------------------------------------------------------- session --

await setViewport(1280, 900);
await go('/login', 1500);
await shoot('01-login');

// Fill the form through the DOM and dispatch input events, so Vue's v-model
// sees the change — setting .value alone would leave the model empty.
await evaluate(`
  (() => {
    const [u, p] = document.querySelectorAll('input');
    const set = (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(u, 's231003');
    set(p, 'student-1234');
    document.querySelector('form').requestSubmit();
    return true;
  })()
`);
await sleep(2000);

const pages = [
  ['/', '02-dashboard'],
  ['/practice', '03-practice-hub'],
  ['/wrongbook', '04-wrongbook'],
  ['/assignments', '05-assignments'],
];

console.log('桌面版 1280×900');
for (const [path, name] of pages) {
  await go(path, 1400);
  await shoot(name);
}

// A practice session, answered, so the correct/wrong feedback is visible.
console.log('答題流程');
await go('/practice', 1400);
await evaluate(`
  (() => {
    const cards = [...document.querySelectorAll('button')];
    const target = cards.find((b) => /題可練/.test(b.textContent));
    if (target) target.click();
    return !!target;
  })()
`);
await sleep(2200);
await shoot('06-question');

await evaluate(`
  (() => {
    const opt = [...document.querySelectorAll('button')].find((b) => /^\\s*A/.test(b.textContent));
    if (opt) opt.click();
    return !!opt;
  })()
`);
await sleep(1600);
await shoot('07-answered');

console.log('補題介面（教師登入）');
// Log out first: /login redirects to the dashboard while a session is live,
// so without this the teacher form never appears.
await evaluate(`fetch('/api/auth/logout', { method: 'POST' }).then(() => true)`);
await go('/login', 1500);
await evaluate(`
  (() => {
    const [u, p] = document.querySelectorAll('input');
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(u, 'teacher'); set(p, 'teacher-1234');
    document.querySelector('form').requestSubmit();
    return true;
  })()
`);
await sleep(2000);
await go('/teacher/fill', 2000);
await shoot('11-fill-drafts');

for (const [path, name, settle] of [
  ['/teacher', '12-teacher-overview', 1800],
  ['/teacher/paper', '13-create-paper', 2000],
  ['/teacher/scores', '14-scores', 2200],
  ['/teacher/topics', '15-topic-toggle', 1800],
]) {
  await go(path, settle);
  await shoot(name);
}

// The per-question tab of the scores screen.
await go('/teacher/scores', 2200);
await evaluate(`
  (() => {
    const tab = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('逐題分析'));
    if (tab) tab.click();
    return !!tab;
  })()
`);
await sleep(1400);
await shoot('16-analysis');

console.log('管理員頁面');
await evaluate(`fetch('/api/auth/logout', { method: 'POST' }).then(() => true)`);
await go('/login', 1500);
await evaluate(`
  (() => {
    const [u, p] = document.querySelectorAll('input');
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(u, 'admin'); set(p, 'admin-1234');
    document.querySelector('form').requestSubmit();
    return true;
  })()
`);
await sleep(2000);

// Only now, with the session established, burn the login budget so the
// throttle screen has a blocked source to show. Doing this first would
// throttle the sign-in above — which is how this was discovered.
await evaluate(`
  (async () => {
    for (let i = 0; i < 25; i++) {
      await fetch('/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'nobody', password: 'x' }),
      });
    }
    return true;
  })()
`);
await sleep(600);

for (const [path, name] of [
  ['/account', '17-account'],
  ['/staff/throttle', '18-throttle'],
  ['/teacher/students', '19-class-students'],
  ['/admin', '20-admin'],
]) {
  await go(path, 1800);
  await shoot(name);
}

console.log('手機版 390×844');
await setViewport(390, 844, true);
for (const [path, name] of [['/', '08-mobile-dashboard'], ['/practice', '09-mobile-practice']]) {
  await go(path, 1400);
  await shoot(name);
}

console.log('深色主題');
await setViewport(1280, 900);
await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await go('/practice', 1500);
await shoot('10-dark-practice');

cdp.close();
chrome.kill();
console.log('\n完成');
process.exit(0);
