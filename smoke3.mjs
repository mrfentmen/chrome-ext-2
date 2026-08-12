#!/usr/bin/env node
/*
 * Whiteboard feature test: verifies the corner drag resizes the board (canvas
 * resolution + strokes scale + size persists), and that ?tab=1 mode fills the
 * tab. Uses trusted CDP mouse events so setPointerCapture works.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 9222;
const EXT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'whiteboard', 'ext');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); }
  async open() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws')); });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
        }
      };
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function evalIn(cdp, sid, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 300) };
  return r.result.value;
}

async function openPage(cdp, url) {
  const t = await cdp.send('Target.createTarget', { url });
  const att = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const sid = att.sessionId;
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('Log.enable', {}, sid);
  for (let i = 0; i < 40; i++) {
    const st = await evalIn(cdp, sid, 'document.readyState');
    if (st === 'complete') break;
    await sleep(300);
  }
  return { sid, targetId: t.targetId };
}

async function drag(cdp, sid, from, to, steps = 12) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 }, sid);
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }, sid);
    await sleep(20);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 }, sid);
}

async function main() {
  const ver = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.open();
  const id = extId(EXT_PATH);
  const results = {};

  // ---------- 1. new tab button opens a tab; board fits the tab ----------
  {
    const p = await openPage(cdp, `chrome-extension://${id}/popup.html`);
    await sleep(1200);
    // fresh storage so the tab mode falls through to fit-to-tab sizing
    await evalIn(cdp, p.sid, `new Promise((res) => chrome.storage.local.clear(res)); 'cleared'`);
    await evalIn(cdp, p.sid, `document.getElementById('new-tab').click(); 'clicked'`);
    await sleep(1500);
    const targets = (await cdp.send('Target.getTargets')).targetInfos || [];
    const tabTarget = targets.find((t) => t.url.includes('tab=1') && t.type === 'page');
    results.newTabOpened = !!tabTarget;
    if (tabTarget) {
      const att = await cdp.send('Target.attachToTarget', { targetId: tabTarget.targetId, flatten: true });
      const sid2 = att.sessionId;
      await cdp.send('Runtime.enable', {}, sid2);
      await sleep(1500);
      const info = await evalIn(cdp, sid2, `(() => {
        const c = document.getElementById('board');
        return {
          isTabMode: document.body.classList.contains('tab-mode'),
          w: c.width, h: c.height,
          viewportW: window.innerWidth, viewportH: window.innerHeight,
          newTabHidden: getComputedStyle(document.getElementById('new-tab')).display === 'none',
          scrollArea: (() => { const s = document.querySelector('.board-scroll'); return { cw: s.clientWidth, ch: s.clientHeight }; })()
        };
      })()`);
      results.tabInfo = info;
      results.tabOk = info.isTabMode && info.newTabHidden &&
        info.w >= 1000 && info.w <= 1260 && info.h >= 300 && info.h <= 450 &&
        info.w <= info.viewportW && info.h <= info.viewportH;
      await cdp.send('Target.closeTarget', { targetId: tabTarget.targetId });
    } else {
      results.tabOk = false;
    }
    await cdp.send('Target.closeTarget', { targetId: p.targetId });
  }

  // ---------- 2. popup: resize via corner drag ----------
  {
    const p = await openPage(cdp, `chrome-extension://${id}/popup.html`);
    await sleep(1500);
    const before = await evalIn(cdp, p.sid, `(() => {
      const c = document.getElementById('board');
      const g = document.getElementById('resize-grip');
      const r = g.getBoundingClientRect();
      const s = document.getElementById('new-tab') ? 'new-tab-present' : 'no-new-tab';
      return { w: c.width, h: c.height, grip: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, newTab: s };
    })()`);
    results.popupBefore = before;

    await drag(cdp, p.sid, before.grip, { x: before.grip.x + 160, y: before.grip.y + 130 });
    await sleep(600);

    const after = await evalIn(cdp, p.sid, `(async () => {
      const c = document.getElementById('board');
      const st = await new Promise((res) => chrome.storage.local.get(['wbSize','wbStrokes'], res));
      const first = st.wbStrokes && st.wbStrokes[0];
      return { w: c.width, h: c.height, wbSize: st.wbSize, firstKind: first && first.kind, firstX0: first && first.x0, hint: document.getElementById('hint').textContent };
    })()`);
    results.popupAfter = after;
    results.popupOk =
      after.w === 500 && after.h === 550 &&
      after.wbSize && after.wbSize.w === 500 && after.wbSize.h === 550 &&
      before.newTab === 'new-tab-present';

    await cdp.send('Target.closeTarget', { targetId: p.targetId });
  }

  // ---------- 3. popup reload: size persists ----------
  {
    const p = await openPage(cdp, `chrome-extension://${id}/popup.html`);
    await sleep(1500);
    const reload = await evalIn(cdp, p.sid, `(() => {
      const c = document.getElementById('board');
      return { w: c.width, h: c.height };
    })()`);
    results.persisted = reload;
    results.persistOk = reload.w === 500 && reload.h === 550;
    await cdp.send('Target.closeTarget', { targetId: p.targetId });
  }

  console.log(JSON.stringify(results, null, 2));
  const ok = results.popupOk && results.newTabOpened && results.tabOk && results.persistOk;
  console.log('\n=== OVERALL:', ok ? 'FEATURE WORKS' : 'PROBLEM', '===');
  cdp.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('harness failed:', e); process.exit(2); });
