#!/usr/bin/env node
/* Regenerate the store screenshot from the live popup + check header fits. */
import crypto from 'node:crypto';
import fs from 'node:fs';
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
  send(method, params = {}) {
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
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function evalIn(page, expression) {
  const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 300) };
  return r.result.value;
}

async function openPage(cdp, url) {
  const t = await cdp.send('Target.createTarget', { url });
  let wsUrl = null;
  for (let i = 0; i < 20 && !wsUrl; i++) {
    const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
    const hit = list.find((x) => x.id === t.targetId || x.url === url);
    if (hit) wsUrl = hit.webSocketDebuggerUrl;
    else await sleep(300);
  }
  const page = new CDP(wsUrl);
  await page.open();
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  return { page, targetId: t.targetId };
}

async function main() {
  const ver = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.open();
  const id = extId(EXT_PATH);
  const results = {};

  // header fit check on the real popup
  {
    const p = await openPage(cdp, `chrome-extension://${id}/popup.html`);
    await sleep(1500);
    results.header = await evalIn(p.page, `(() => {
      const body = document.body;
      const hdr = document.querySelector('.app-header');
      const btn = document.getElementById('new-tab');
      const br = btn.getBoundingClientRect();
      const hr = hdr.getBoundingClientRect();
      return {
        bodyScrollW: body.scrollWidth,
        bodyClientW: body.clientWidth,
        newTabRight: Math.round(br.right),
        headerRight: Math.round(hr.right),
        fits: br.right <= hr.right + 1,
        subtitleH: Math.round(document.querySelector('.subtitle').getBoundingClientRect().height)
      };
    })()`);
    results.headerFits = results.header.fits && results.header.bodyScrollW <= results.header.bodyClientW + 1;
    await cdp.send('Target.closeTarget', { targetId: p.targetId });
    p.page.close();
  }

  // regenerate the store screenshot from the live harness
  {
    const p = await openPage(cdp, `chrome-extension://${id}/store/screenshot.html`);
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const r = await evalIn(p.page, `window.__storeReady === true`);
      if (r === true) { ready = true; break; }
      await sleep(500);
    }
    results.storeReady = ready;
    await sleep(1200);
    const shot = await p.page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${EXT_PATH}/store/screenshot.png`, Buffer.from(shot.data, 'base64'));
    results.screenshotBytes = fs.statSync(`${EXT_PATH}/store/screenshot.png`).size;
    await cdp.send('Target.closeTarget', { targetId: p.targetId });
    p.page.close();
  }

  console.log(JSON.stringify(results, null, 2));
  const ok = results.headerFits === true && results.storeReady === true && results.screenshotBytes > 50000;
  console.log('\n=== OVERALL:', ok ? 'OK' : 'PROBLEM', '===');
  cdp.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('harness failed:', e); process.exit(2); });
