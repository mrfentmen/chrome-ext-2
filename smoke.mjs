#!/usr/bin/env node
/*
 * Extension smoke test: opens each loaded extension's popup page in a real
 * Chrome (CDP over WebSocket via the browser target, zero deps), waits for
 * network + rendering, then reports console errors, uncaught exceptions,
 * failed/blocked network requests, key DOM state, and saves a screenshot.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 9222;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SMOKE_BASE || path.join(__dirname, '..');
fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
const EXTS = {
  'random-fact-generator':   { check: (d) => d.factText && d.factText !== 'Loading…' && d.factText !== 'Oops, no fact arrived. Try again.' },
  'image-to-pdf':            { check: (d) => d.dropVisible },
  'where-is-iss':            { check: (d) => /°/.test(d.coord || ''), note: 'coord shows degrees' },
  'wiki-instant':            { check: (d) => true },
  'image-resize-compressor': { check: (d) => d.dropVisible },
  'whiteboard':              { check: (d) => true },
  'internet-radio-player':   { check: (d) => true },
  'hacker-news-reader':      { check: (d) => (d.count || '').includes('stories') },
  'pokemon-price-ticker':    { check: (d) => true },
  'yugioh-price-ticker':     { check: (d) => true },
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

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.sessions = new Map(); // sessionId -> {events:[], listeners:{}}
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
        this.sessions.set(msg.params.sessionId, { events: [], listeners: new Map() });
      }
      if (msg.sessionId && this.sessions.has(msg.sessionId)) {
        const s = this.sessions.get(msg.sessionId);
        s.events.push(msg);
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
    s.listeners.set(method, [...(s.listeners.get(method) || []), fn]);
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  const ver = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false });

  const results = {};
  for (const [name, cfg] of Object.entries(EXTS)) {
    const id = extId(`${BASE}/${name}/ext`);
    const popupUrl = `chrome-extension://${id}/popup.html`;
    const res = { url: popupUrl, consoleErrors: [], exceptions: [], networkFailures: [], warnings: [], dom: {}, ok: false };

    let targetId;
    try {
      const t = await cdp.send('Target.createTarget', { url: popupUrl });
      targetId = t.targetId;
    } catch (e) {
      res.networkFailures.push('createTarget: ' + e.message);
      results[name] = res;
      continue;
    }
    const att = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sid = att.sessionId;
    if (!cdp.sessions.has(sid)) {
      cdp.sessions.set(sid, { events: [], listeners: new Map() });
    }
    const s = cdp.sessions.get(sid);

    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('Log.enable', {}, sid);
    await cdp.send('Network.enable', {}, sid);
    await cdp.send('Page.enable', {}, sid);

    cdp.on(sid, 'Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      res.exceptions.push((d.exception && d.exception.description) || d.text || 'exception');
    });
    cdp.on(sid, 'Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        res.consoleErrors.push((p.args || []).map((a) => a.value || a.description || '').join(' '));
      } else if (p.type === 'warning') {
        res.warnings.push((p.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    });
    cdp.on(sid, 'Log.entryAdded', (p) => {
      const e = p.entry || {};
      if (e.level === 'error') res.consoleErrors.push((e.text || '') + (e.url ? ' @' + e.url : ''));
      else if (e.level === 'warning') res.warnings.push((e.text || '') + (e.url ? ' @' + e.url : ''));
    });
    cdp.on(sid, 'Network.loadingFailed', (p) => {
      if (p.canceled) return;
      res.networkFailures.push(`[${p.type}] ${p.errorText}${p.blockedReason ? ' blocked:' + p.blockedReason : ''}`);
    });

    // wait for the popup document to finish loading
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'document.readyState', returnByValue: true,
      }, sid).catch(() => ({ result: {} }));
      if (r.result && r.result.value === 'complete') { ready = true; break; }
      await sleep(500);
    }
    if (!ready) res.warnings.push('page never reached readyState=complete');
    await sleep(6000); // give async fetches time to finish

    const evalRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const q = (s) => { const el = document.querySelector(s); return el ? el.textContent.trim() : null; };
        return {
          title: document.title,
          factText: q('#fact-text'),
          coord: q('#coord'),
          people: q('#people'),
          count: q('#count-hint'),
          status: q('#status'),
          listItems: document.querySelectorAll('#list > *').length,
          dropVisible: !(document.querySelector('#drop') || {}).hidden,
          emptyHidden: (document.querySelector('#empty') || {}).hidden
        };
      })()`,
      returnByValue: true,
    }, sid);
    if (evalRes.exceptionDetails) {
      res.exceptions.push('evaluate: ' + JSON.stringify(evalRes.exceptionDetails).slice(0, 300));
    } else {
      res.dom = evalRes.result.value;
    }

    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
      fs.writeFileSync(path.join(__dirname, 'shots', `shot-${name}.png`), Buffer.from(shot.data, 'base64'));
    } catch {}

    const unique = (a) => [...new Set(a)];
    res.consoleErrors = unique(res.consoleErrors);
    res.networkFailures = unique(res.networkFailures);
    res.warnings = unique(res.warnings).filter((w) => !/favicon/i.test(w));
    if (name === 'internet-radio-player') {
      // Known benign noise (documented in README): a station server can 402 or
      // ORB-block its favicon; the popup falls back to a radio emoji.
      res.consoleErrors = res.consoleErrors.filter((e) => !/Failed to load resource:.*(icon|favicon)/i.test(e));
      res.networkFailures = res.networkFailures.filter((f) => !(/\[Image\]/.test(f) && /ERR_BLOCKED_BY_ORB/.test(f)));
    }
    res.ok = res.consoleErrors.length === 0 && res.exceptions.length === 0 &&
      res.networkFailures.length === 0 && cfg.check(res.dom);

    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    results[name] = res;
  }

  console.log(JSON.stringify(results, null, 2));
  const allOk = Object.values(results).every((r) => r.ok);
  console.log('\n=== OVERALL:', allOk ? 'ALL PASS' : 'ISSUES FOUND', '===');
  cdp.close();
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('smoke harness failed:', e); process.exit(2); });
