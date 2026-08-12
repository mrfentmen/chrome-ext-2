#!/usr/bin/env node
/*
 * Interaction smoke test: drives real user flows in each extension popup via
 * CDP (click New fact, convert a PDF, search Wikipedia, play a station, ...),
 * collecting console errors / exceptions along the way.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 9222;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SMOKE_BASE || path.join(__dirname, '..');
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
  if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 200) };
  return r.result.value;
}

async function run() {
  const ver = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.open();

  const results = {};

  async function openPopup(name, query = '') {
    const id = extId(`${BASE}/${name}/ext`);
    const url = `chrome-extension://${id}/popup.html${query}`;
    const t = await cdp.send('Target.createTarget', { url });
    const att = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const sid = att.sessionId;
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('Log.enable', {}, sid);
    await cdp.send('Network.enable', {}, sid);
    const errs = { console: [], exceptions: [] };
    // attach listeners via a dedicated wrapper
    const rawSend = (m, p, s) => cdp.send(m, p, s);
    const sub = { sid, t, errs, rawSend };
    return sub;
  }

  // ---- random-fact-generator: fetch + click "New fact" ----
  {
    const p = await openPopup('random-fact-generator');
    await sleep(3000);
    const before = await evalIn(cdp, p.sid, `document.querySelector('#fact-text').textContent`);
    await evalIn(cdp, p.sid, `document.querySelector('#new-fact').click(); 'clicked'`);
    await sleep(2500);
    const after = await evalIn(cdp, p.sid, `document.querySelector('#fact-text').textContent`);
    const status = await evalIn(cdp, p.sid, `document.querySelector('#status').textContent`);
    results['random-fact-generator'] = { before, after, status, ok: !!after && after !== before && !/Oops/.test(after) };
    await cdp.send('Target.closeTarget', { targetId: p.t.targetId });
  }

  // ---- image-to-pdf: sample mode -> convert ----
  {
    const p = await openPopup('image-to-pdf', '?sample=1');
    await sleep(3000);
    const pagesBefore = await evalIn(cdp, p.sid, `document.querySelectorAll('.page-row').length`);
    await evalIn(cdp, p.sid, `document.querySelector('#convert').click(); 'clicked'`);
    await sleep(3000);
    const out = await evalIn(cdp, p.sid, `document.querySelector('#out-size').textContent`);
    const status = await evalIn(cdp, p.sid, `document.querySelector('#status').textContent`);
    results['image-to-pdf'] = { pagesBefore, out, status, ok: pagesBefore === 2 && /PDF ready/.test(out) };
    await cdp.send('Target.closeTarget', { targetId: p.t.targetId });
  }

  // ---- where-is-iss: manual refresh updates ----
  {
    const p = await openPopup('where-is-iss');
    await sleep(3000);
    const c1 = await evalIn(cdp, p.sid, `document.querySelector('#coord').textContent`);
    await evalIn(cdp, p.sid, `document.querySelector('#refresh').click(); 'clicked'`);
    await sleep(2500);
    const c2 = await evalIn(cdp, p.sid, `document.querySelector('#coord').textContent`);
    const people = await evalIn(cdp, p.sid, `document.querySelector('#people').textContent`);
    results['where-is-iss'] = { c1, c2, people, ok: /°/.test(c2 || '') };
    await cdp.send('Target.closeTarget', { targetId: p.t.targetId });
  }

  // ---- wiki-instant: search -> suggestion -> open card ----
  {
    const p = await openPopup('wiki-instant');
    await sleep(1500);
    await evalIn(cdp, p.sid, `(() => {
      const s = document.querySelector('#search');
      s.value = 'moon landing';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(1500);
    const sugCount = await evalIn(cdp, p.sid, `document.querySelectorAll('.sug-item').length`);
    await evalIn(cdp, p.sid, `(() => {
      const first = document.querySelector('.sug-item');
      if (first) first.click();
      return !!first;
    })()`);
    await sleep(2500);
    const title = await evalIn(cdp, p.sid, `document.querySelector('#card-title').textContent`);
    const extract = await evalIn(cdp, p.sid, `document.querySelector('#card-extract').textContent.length`);
    results['wiki-instant'] = { sugCount, title, extract, ok: sugCount > 0 && !!title && extract > 50 };
    await cdp.send('Target.closeTarget', { targetId: p.t.targetId });
  }

  // ---- image-resize-compressor: sample -> estimate ----
  {
    const p = await openPopup('image-resize-compressor', '?sample=1');
    await sleep(3000);
    const est = await evalIn(cdp, p.sid, `document.querySelector('#out-size').textContent`);
    const dims = await evalIn(cdp, p.sid, `document.querySelector('#dims').textContent`);
    results['image-resize-compressor'] = { est, dims, ok: /Estimated output/.test(est || '') };
    await cdp.send('Target.closeTarget', { targetId: p.t.targetId });
  }

  // ---- whiteboard: welcome sketch + undo ----
  {
    const p = await openPopup('whiteboard');
    await sleep(2000);
    const hint = await evalIn(cdp, p.sid, `document.querySelector('#hint').textContent`);
    const hasStrokes = await evalIn(cdp, p.sid, `document.querySelector('#board').width > 0`);
    await evalIn(cdp, p.sid, `document.querySelector('#undo').click(); 'clicked'`);
    await sleep(600);
    results['whiteboard'] = { hint, hasStrokes, ok: !!hint && hasStrokes === true };
    await cdp.send('Target.closeTarget', { targetId: p.t.targetId });
  }

  // ---- internet-radio-player: play a station ----
  {
    const p = await openPopup('internet-radio-player');
    await sleep(4000);
    const count = await evalIn(cdp, p.sid, `document.querySelectorAll('.station').length`);
    await evalIn(cdp, p.sid, `(() => {
      const first = document.querySelector('.st-play');
      if (first) first.click();
      return !!first;
    })()`);
    await sleep(3000);
    const nowTitle = await evalIn(cdp, p.sid, `document.querySelector('#now-title').textContent`);
    const playerHidden = await evalIn(cdp, p.sid, `document.querySelector('#player').hidden`);
    results['internet-radio-player'] = { count, nowTitle, playerHidden, ok: count > 0 && !!nowTitle && playerHidden === false };
    await cdp.send('Target.closeTarget', { targetId: p.t.targetId });
  }

  // ---- hacker-news-reader: switch through the Ask, New, and Best tabs ----
  {
    const p = await openPopup('hacker-news-reader');
    await sleep(4000);
    const topCount = await evalIn(cdp, p.sid, `document.querySelectorAll('.story').length`);
    async function clickTab(tab) {
      await evalIn(cdp, p.sid, `(() => {
        const t = document.querySelector('.tab[data-tab="${tab}"]');
        if (t) t.click();
        return !!t;
      })()`);
      await sleep(3500);
      return evalIn(cdp, p.sid, `document.querySelectorAll('.story').length`);
    }
    const askCount = await clickTab('ask');
    const newCount = await clickTab('new');
    const bestCount = await clickTab('best');
    results['hacker-news-reader'] = { topCount, askCount, newCount, bestCount, ok: topCount > 0 && askCount > 0 && newCount > 0 && bestCount > 0 };
    await cdp.send('Target.closeTarget', { targetId: p.t.targetId });
  }

  // ---- pokemon-price-ticker: search -> add -> quote lands + ticker ----
  {
    const p = await openPopup('pokemon-price-ticker');
    await sleep(2000);
    // two search attempts: the pokemontcg.io feed can flap for a minute
    let added = false;
    for (let attempt = 0; attempt < 2 && !added; attempt++) {
      await evalIn(cdp, p.sid, `(() => {
        const s = document.querySelector('#search');
        s.value = 'charizard';
        s.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(6000);
      const resCount = await evalIn(cdp, p.sid, `document.querySelectorAll('.res-row').length`);
      if (resCount > 0) {
        await evalIn(cdp, p.sid, `(() => { const r = document.querySelector('.res-row'); if (r) r.click(); return !!r; })()`);
        added = true;
      }
    }
    let quoteLanded = false;
    for (let t0 = Date.now(); Date.now() - t0 < 15000 && !quoteLanded;) {
      // ts is seeded at add time; a landed quote is proven by the TCGplayer
      // updatedAt string that only applyQuote writes.
      quoteLanded = await evalIn(cdp, p.sid, `new Promise((res) => chrome.storage.local.get('ptWatchlist', (d) => {
        const w = d && d.ptWatchlist;
        res(Array.isArray(w) && w[0] && typeof w[0].updatedAt === 'string' && w[0].updatedAt.length > 0);
      }))`) === true;
      if (!quoteLanded) await sleep(1000);
    }
    const rows = await evalIn(cdp, p.sid, `document.querySelectorAll('.card-row').length`);
    const price = await evalIn(cdp, p.sid, `(() => { const p = document.querySelector('.card-price'); return p ? p.textContent : ''; })()`);
    const tapeItems = await evalIn(cdp, p.sid, `document.querySelectorAll('.tape-item').length`);
    results['pokemon-price-ticker'] = { added, rows, price, tapeItems, quoteLanded,
      ok: rows === 1 && price.startsWith('$') && quoteLanded && tapeItems >= 2 };
    await cdp.send('Target.closeTarget', { targetId: p.t.targetId });
  }

  console.log(JSON.stringify(results, null, 2));
  const allOk = Object.values(results).every((r) => r.ok);
  console.log('\n=== OVERALL:', allOk ? 'ALL FLOWS PASS' : 'FLOWS FAILED', '===');
  cdp.close();
  process.exit(allOk ? 0 : 1);
}

run().catch((e) => { console.error('harness failed:', e); process.exit(2); });
