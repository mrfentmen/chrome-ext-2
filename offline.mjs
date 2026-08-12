#!/usr/bin/env node
/*
 * offline.mjs — permanent two-phase offline-fallback regression.
 *
 * Phase 1 (online):  open each cache-backed popup, wait for real data to
 *                    render, assert it did. This persists the cache into the
 *                    Chrome profile.
 * Phase 2 (offline): intercept and fail every request to the extension's API
 *                    hosts (Fetch.failRequest → InternetDisconnected), reload
 *                    the popup, and assert the saved copy still renders with
 *                    an "Offline — saved …" status and no uncaught
 *                    exceptions.
 *
 * Covers the three cache-backed extensions:
 *   - hacker-news-reader    (last-good stories per tab)
 *   - wiki-instant          (last opened article)
 *   - internet-radio-player (last station list)
 *
 * The Chrome profile must persist across the whole run (see run-offline.sh)
 * so the phase-1 cache is readable in phase 2. Exit 0 = all phases pass.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 9222;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SMOKE_BASE || path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-extension test plan. `block` are Fetch urlPatterns for the API hosts;
// `online` / `offline` describe each phase.
const EXTS = {
  'where-is-iss': {
    block: ['*api.open-notify.org*'],
    online: { waitMs: 4000, check: (d) => /°/.test(d.coord || ''), label: 'live fix renders' },
    offline: {
      waitMs: 8000, check: (d) => /°/.test(d.coord || '') && /Offline/.test(d.status) && d.liveLabel === 'STALE',
      label: 'stale fix + Offline status + STALE badge',
    },
  },
  'hacker-news-reader': {
    block: ['*hacker-news.firebaseio.com*'],
    online: { waitMs: 6000, check: (d) => d.stories >= 15, label: 'story list renders' },
    offline: {
      waitMs: 8000, check: (d) => d.stories >= 15 && /Offline/.test(d.status),
      label: 'cached stories + Offline status',
    },
  },
  'wiki-instant': {
    block: ['*en.wikipedia.org*'],
    online: {
      waitMs: 3500, check: (d) => !!d.title && d.extract >= 50, label: 'article card renders',
      steps: [
        { after: 1500, run: `(() => {
            const s = document.querySelector('#search');
            s.value = 'moon landing';
            s.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          })()` },
        { waitFor: `document.querySelectorAll('.sug-item').length > 0`, run: `(() => {
            const first = document.querySelector('.sug-item');
            if (first) first.click();
            return !!first;
          })()` },
      ],
    },
    offline: {
      waitMs: 5000, check: (d) => !!d.title && d.extract >= 50 && /Offline/.test(d.status),
      label: 'cached card + Offline status',
      steps: [
        { after: 800, run: `(() => {
            const s = document.querySelector('#search');
            s.value = 'moon landing';
            s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            return true;
          })()` },
      ],
    },
  },
  'internet-radio-player': {
    block: ['*radio-browser.info*'],
    online: { waitMs: 5000, check: (d) => d.stations >= 10, label: 'station list renders' },
    offline: {
      waitMs: 8000, check: (d) => d.stations >= 10 && /Offline/.test(d.status),
      label: 'cached stations + Offline status',
    },
  },
};

function extId(absPath) {
  const hash = crypto.createHash('sha256').update(absPath).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    const b = hash[i];
    id += String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15));
  }
  return id;
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.sessions = new Map();
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('ws connect failed'));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Target.attachedToTarget' && msg.params && msg.params.sessionId) {
        this.sessions.set(msg.params.sessionId, { listeners: new Map() });
      }
      if (msg.sessionId && this.sessions.has(msg.sessionId)) {
        const s = this.sessions.get(msg.sessionId);
        (s.listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(sessionId, method, fn) {
    const s = this.sessions.get(sessionId);
    if (s) s.listeners.set(method, [...(s.listeners.get(method) || []), fn]);
  }
  close() { try { this.ws.close(); } catch {} }
}

async function evalIn(cdp, sid, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 200) };
  return r.result.value;
}

async function waitReady(cdp, sid, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalIn(cdp, sid, 'document.readyState');
    if (r === 'complete') return true;
    await sleep(300);
  }
  return false;
}

async function waitFor(cdp, sid, expression, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await evalIn(cdp, sid, expression);
    if (r && r.__err) return false;
    if (r === true) return true;
    await sleep(300);
  }
  return false;
}

// Run a phase's ordered steps: `{ after }` waits a fixed delay, `{ waitFor }`
// polls until the condition holds (or its waitForMs budget elapses).
async function runSteps(cdp, sid, steps) {
  for (const step of steps || []) {
    if (step.waitFor) {
      await waitFor(cdp, sid, step.waitFor, step.waitForMs || 4000);
    } else {
      await sleep(step.after || 0);
    }
    if (step.run) await evalIn(cdp, sid, step.run);
  }
}

function snapshotExpr(name) {
  if (name === 'where-is-iss') {
    return `(() => {
      const s = document.querySelector('#status');
      const l = document.querySelector('#live-label');
      return {
        coord: (document.querySelector('#coord') || {}).textContent || '',
        status: s ? s.textContent.trim() : '',
        liveLabel: l ? l.textContent.trim() : '',
      };
    })()`;
  }
  if (name === 'hacker-news-reader') {
    return `(() => {
      const s = document.querySelector('#status');
      return { stories: document.querySelectorAll('.story').length, status: s ? s.textContent.trim() : '' };
    })()`;
  }
  if (name === 'wiki-instant') {
    return `(() => {
      const s = document.querySelector('#status');
      const t = document.querySelector('#card-title');
      const e = document.querySelector('#card-extract');
      return {
        title: t ? t.textContent.trim() : '',
        extract: e ? e.textContent.trim().length : 0,
        status: s ? s.textContent.trim() : '',
      };
    })()`;
  }
  return `(() => {
    const s = document.querySelector('#status');
    return { stations: document.querySelectorAll('.station').length, status: s ? s.textContent.trim() : '' };
  })()`;
}

async function run() {
  const ver = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.open();

  const results = {};

  async function openPopup(name, opts) {
    const id = extId(`${BASE}/${name}/ext`);
    const t = await cdp.send('Target.createTarget', { url: `chrome-extension://${id}/popup.html` });
    const att = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const sid = att.sessionId;
    if (!cdp.sessions.has(sid)) cdp.sessions.set(sid, { listeners: new Map() });
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('Page.enable', {}, sid);
    const ctx = { sid, targetId: t.targetId, exceptions: [] };
    cdp.on(sid, 'Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      ctx.exceptions.push((d.exception && d.exception.description) || d.text || 'exception');
    });
    await waitReady(cdp, sid);
    if (opts.block) {
      // Phase 2: fail every request to the API hosts (offline simulation).
      await cdp.send('Fetch.enable', { patterns: opts.block.map((urlPattern) => ({ urlPattern })) }, sid);
      cdp.on(sid, 'Fetch.requestPaused', (p) => {
        cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'InternetDisconnected' }, sid).catch(() => {});
      });
      await cdp.send('Page.reload', {}, sid);
      await waitReady(cdp, sid);
    }
    return ctx;
  }

  for (const [name, cfg] of Object.entries(EXTS)) {
    const res = {};
    // ---- Phase 1: online ----
    {
      const p = await openPopup(name, {});
      await runSteps(cdp, p.sid, cfg.online.steps);
      await sleep(cfg.online.waitMs);
      const d = await evalIn(cdp, p.sid, snapshotExpr(name));
      res.online = { ...d, exceptions: p.exceptions, ok: cfg.online.check(d) && p.exceptions.length === 0 };
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
    }
    // ---- Phase 2: offline ----
    {
      const p = await openPopup(name, { block: cfg.block });
      const t0 = Date.now();
      await runSteps(cdp, p.sid, cfg.offline.steps);
      // wait for the offline status to appear (or the allotted budget to elapse)
      await waitFor(cdp, p.sid,
        `(() => { const s = document.querySelector('#status'); return !!(s && /Offline/.test(s.textContent)); })()`,
        Math.max(1000, cfg.offline.waitMs - (Date.now() - t0)));
      await sleep(400);
      const d = await evalIn(cdp, p.sid, snapshotExpr(name));
      res.offline = { ...d, exceptions: p.exceptions, ok: cfg.offline.check(d) && p.exceptions.length === 0 };
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
    }
    results[name] = res;
  }

  console.log(JSON.stringify(results, null, 2));
  const allOk = Object.values(results).every((r) => r.online.ok && r.offline.ok);
  console.log('\n=== OVERALL:', allOk ? 'ALL OFFLINE PHASES PASS' : 'OFFLINE TEST FAILED', '===');
  cdp.close();
  process.exit(allOk ? 0 : 1);
}

run().catch((e) => { console.error('offline harness failed:', e); process.exit(2); });
