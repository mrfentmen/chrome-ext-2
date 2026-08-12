#!/usr/bin/env node
/*
 * E2E for the corner-drag resize grips on the three viewer popups:
 *  - where-is-iss:      map canvas height (resolution + display, redraw)
 *  - hacker-news-reader: story list height
 *  - wiki-instant:      article text height (card open via ?query)
 * Verifies drag math (+100px), keyboard (ArrowUp +10), persistence across
 * reload, and zero console errors / network failures on every page.
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
  await page.send('Log.enable');
  await page.send('Network.enable');
  const errs = { console: [], exceptions: [], net: [] };
  page.__events = (m) => {
    if (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.type === 'error') {
      errs.console.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      errs.exceptions.push((d.exception && d.exception.description) || d.text || 'exception');
    }
    if (m.method === 'Log.entryAdded' && m.params && m.params.entry && m.params.entry.level === 'error') {
      errs.console.push((m.params.entry.text || '') + (m.params.entry.url ? ' @' + m.params.entry.url : ''));
    }
    if (m.method === 'Network.loadingFailed' && m.params && !m.params.canceled) {
      errs.net.push(`[${m.params.type}] ${m.params.errorText}`);
    }
  };
  const orig = page.ws.onmessage;
  page.ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) { orig(ev); } else { page.__events(m); }
  };
  return { page, targetId: t.targetId, errs };
}

async function drag(page, from, to, steps = 12) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await sleep(18);
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function gripPos(page) {
  return evalIn(page, `(() => { const r = document.getElementById('resize-grip').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
}
async function key(page, key) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
  await sleep(150);
}

async function main() {
  const ver = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.open();
  const issId = extId(`${BASE}/where-is-iss/ext`);
  const hnId = extId(`${BASE}/hacker-news-reader/ext`);
  const wikiId = extId(`${BASE}/wiki-instant/ext`);
  const results = {};

  // ================= where-is-iss: map canvas =================
  {
    const p = await openPage(cdp, `chrome-extension://${issId}/popup.html`);
    await sleep(3000);
    const before = await evalIn(p.page, `document.getElementById('map').height`);
    await drag(p.page, await gripPos(p.page), { ...(await gripPos(p.page)), y: (await gripPos(p.page)).y + 100 });
    await sleep(400);
    const after = await evalIn(p.page, `(() => ({
      h: document.getElementById('map').height,
      styleH: document.getElementById('map').style.height,
      stored: null
    }))()`);
    const stored = await evalIn(p.page, `new Promise((res) => chrome.storage.local.get('issMapH', (d) => res(d.issMapH)))`);
    // keyboard: ArrowUp on the focused grip -> +10
    await evalIn(p.page, `document.getElementById('resize-grip').focus(); true`);
    await key(p.page, 'ArrowUp');
    const afterKey = await evalIn(p.page, `document.getElementById('map').height`);
    results.iss = { before, after: after.h, styleH: after.styleH, stored, afterKey };
    results.issOk = before === 250 && after.h === 350 && after.styleH === '350px' && stored === 350 && afterKey === 360;
    results.issErrors = p.errs;
    await cdp.send('Target.closeTarget', { targetId: p.targetId });
    p.page.close();

    // persistence: fresh popup restores 360
    const p2 = await openPage(cdp, `chrome-extension://${issId}/popup.html`);
    await sleep(2000);
    results.issPersist = await evalIn(p2.page, `document.getElementById('map').height`);
    results.issPersistOk = results.issPersist === 360;
    await cdp.send('Target.closeTarget', { targetId: p2.targetId });
    p2.page.close();
  }

  // ================= hacker-news-reader: story list =================
  {
    const p = await openPage(cdp, `chrome-extension://${hnId}/popup.html`);
    await sleep(5000);
    const before = await evalIn(p.page, `document.getElementById('list').offsetHeight`);
    await drag(p.page, await gripPos(p.page), { ...(await gripPos(p.page)), y: (await gripPos(p.page)).y + 100 });
    await sleep(400);
    const after = await evalIn(p.page, `(() => ({
      maxH: document.getElementById('list').style.maxHeight,
      offsetH: document.getElementById('list').offsetHeight,
      stories: document.querySelectorAll('.story').length
    }))()`);
    const stored = await evalIn(p.page, `new Promise((res) => chrome.storage.local.get('hnListH', (d) => res(d.hnListH)))`);
    results.hn = { before, maxH: after.maxH, offsetH: after.offsetH, stories: after.stories, stored };
    results.hnOk = after.maxH === '400px' && after.offsetH === 400 && stored === 400 && after.stories >= 10;
    results.hnErrors = p.errs;
    await cdp.send('Target.closeTarget', { targetId: p.targetId });
    p.page.close();

    const p2 = await openPage(cdp, `chrome-extension://${hnId}/popup.html`);
    await sleep(2500);
    results.hnPersist = await evalIn(p2.page, `document.getElementById('list').style.maxHeight`);
    results.hnPersistOk = results.hnPersist === '400px';
    await cdp.send('Target.closeTarget', { targetId: p2.targetId });
    p2.page.close();
  }

  // ================= wiki-instant: article text =================
  {
    const p = await openPage(cdp, `chrome-extension://${wikiId}/popup.html?Moon`);
    let cardOpen = false;
    for (let i = 0; i < 20; i++) {
      cardOpen = await evalIn(p.page, `!document.getElementById('card').hidden`);
      if (cardOpen) break;
      await sleep(400);
    }
    await sleep(1000);
    const before = await evalIn(p.page, `document.getElementById('card-extract').offsetHeight`);
    await drag(p.page, await gripPos(p.page), { ...(await gripPos(p.page)), y: (await gripPos(p.page)).y + 100 });
    await sleep(400);
    const after = await evalIn(p.page, `(() => ({
      maxH: document.getElementById('card-extract').style.maxHeight,
      offsetH: document.getElementById('card-extract').offsetHeight,
      title: document.getElementById('card-title').textContent
    }))()`);
    const stored = await evalIn(p.page, `new Promise((res) => chrome.storage.local.get('wikiCardH', (d) => res(d.wikiCardH)))`);
    results.wiki = { cardOpen, before, maxH: after.maxH, offsetH: after.offsetH, title: after.title, stored };
    results.wikiOk = cardOpen && after.maxH === '310px' && after.offsetH > before && stored === 310 && !!after.title;
    results.wikiErrors = p.errs;
    await cdp.send('Target.closeTarget', { targetId: p.targetId });
    p.page.close();

    const p2 = await openPage(cdp, `chrome-extension://${wikiId}/popup.html?Moon`);
    for (let i = 0; i < 20; i++) {
      const open = await evalIn(p2.page, `!document.getElementById('card').hidden`);
      if (open) break;
      await sleep(400);
    }
    await sleep(800);
    results.wikiPersist = await evalIn(p2.page, `document.getElementById('card-extract').style.maxHeight`);
    results.wikiPersistOk = results.wikiPersist === '310px';
    await cdp.send('Target.closeTarget', { targetId: p2.targetId });
    p2.page.close();
  }

  // ================= keyboard page zoom (Ctrl/Cmd + - 0) =================
  {
    const keyCombo = async (page, key, code, modifiers) => {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
      await sleep(120);
    };

    // where-is-iss: zoom to 1.2, then verify the grip is zoom-aware
    // (120 screen px at zoom 1.2 == 100 layout px) and Ctrl+0 resets
    {
      const p = await openPage(cdp, `chrome-extension://${issId}/popup.html`);
      await sleep(2500);
      await keyCombo(p.page, '=', 'Equal', 2);
      await keyCombo(p.page, '=', 'Equal', 2);
      const zoomed = await evalIn(p.page, `document.body.style.zoom`);
      const toast1 = await evalIn(p.page, `(() => { const t = document.getElementById('zoom-toast'); return { text: t.textContent, hidden: t.hidden, show: t.classList.contains('show') }; })()`);
      const beforeH = await evalIn(p.page, `document.getElementById('map').height`); // 360 from the earlier section
      await drag(p.page, await gripPos(p.page), { ...(await gripPos(p.page)), y: (await gripPos(p.page)).y + 120 });
      await sleep(400);
      const afterDrag = await evalIn(p.page, `(() => ({
        h: document.getElementById('map').height,
        hint: document.getElementById('status').textContent
      }))()`);
      await keyCombo(p.page, '0', 'Digit0', 2);
      const toast2 = await evalIn(p.page, `(() => { const t = document.getElementById('zoom-toast'); return { text: t.textContent, hidden: t.hidden }; })()`);
      const reset = await evalIn(p.page, `document.body.style.zoom`);
      await sleep(1300);
      const toastGone = await evalIn(p.page, `document.getElementById('zoom-toast').hidden`);
      results.zoomIss = { zoomed, toast1, toast2, toastGone, beforeH, afterDragH: afterDrag.h, reset };
      results.zoomIssOk = zoomed === '1.2' && toast1.text === '120%' && !toast1.hidden && toast1.show &&
        toast2.text === '100%' && !toast2.hidden && afterDrag.h === beforeH + 100 && reset === '' && toastGone === true;
      results.zoomIssErrors = p.errs;
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
      p.page.close();
    }

    // hacker-news-reader: zoom in, reset
    {
      const p = await openPage(cdp, `chrome-extension://${hnId}/popup.html`);
      await sleep(2500);
      await keyCombo(p.page, '=', 'Equal', 2);
      const zoomed = await evalIn(p.page, `document.body.style.zoom`);
      const toast1 = await evalIn(p.page, `(() => { const t = document.getElementById('zoom-toast'); return { text: t.textContent, hidden: t.hidden }; })()`);
      await keyCombo(p.page, '0', 'Digit0', 2);
      const reset = await evalIn(p.page, `document.body.style.zoom`);
      await sleep(1300);
      const toastGone = await evalIn(p.page, `document.getElementById('zoom-toast').hidden`);
      results.zoomHn = { zoomed, toast1, toastGone, reset };
      results.zoomHnOk = zoomed === '1.1' && toast1.text === '110%' && !toast1.hidden && reset === '' && toastGone === true;
      results.zoomHnErrors = p.errs;
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
      p.page.close();
    }

    // wiki-instant: zoom in, reset (card open)
    {
      const p = await openPage(cdp, `chrome-extension://${wikiId}/popup.html?Moon`);
      for (let i = 0; i < 20; i++) {
        const open = await evalIn(p.page, `!document.getElementById('card').hidden`);
        if (open) break;
        await sleep(400);
      }
      await sleep(800);
      await keyCombo(p.page, '-', 'Minus', 2);
      await keyCombo(p.page, '-', 'Minus', 2);
      const zoomed = await evalIn(p.page, `document.body.style.zoom`);
      const toast1 = await evalIn(p.page, `(() => { const t = document.getElementById('zoom-toast'); return { text: t.textContent, hidden: t.hidden }; })()`);
      await keyCombo(p.page, '0', 'Digit0', 4); // Meta+0 resets too
      const reset = await evalIn(p.page, `document.body.style.zoom`);
      await sleep(1300);
      const toastGone = await evalIn(p.page, `document.getElementById('zoom-toast').hidden`);
      results.zoomWiki = { zoomed, toast1, toastGone, reset };
      results.zoomWikiOk = zoomed === '0.8' && toast1.text === '80%' && !toast1.hidden && reset === '' && toastGone === true;
      results.zoomWikiErrors = p.errs;
      await cdp.send('Target.closeTarget', { targetId: p.targetId });
      p.page.close();
    }
  }

  const summarize = (e) => ({ console: [...new Set(e.console)], exceptions: [...new Set(e.exceptions)], net: [...new Set(e.net)] });
  results.issErrors = summarize(results.issErrors);
  results.hnErrors = summarize(results.hnErrors);
  results.wikiErrors = summarize(results.wikiErrors);
  results.zoomIssErrors = summarize(results.zoomIssErrors);
  results.zoomHnErrors = summarize(results.zoomHnErrors);
  results.zoomWikiErrors = summarize(results.zoomWikiErrors);
  const clean = (e) => e.console.length === 0 && e.exceptions.length === 0 && e.net.length === 0;

  const allOk = results.issOk && results.issPersistOk && results.hnOk && results.hnPersistOk &&
    results.wikiOk && results.wikiPersistOk && results.zoomIssOk && results.zoomHnOk && results.zoomWikiOk &&
    clean(results.issErrors) && clean(results.hnErrors) && clean(results.wikiErrors) &&
    clean(results.zoomIssErrors) && clean(results.zoomHnErrors) && clean(results.zoomWikiErrors);

  console.log(JSON.stringify(results, null, 2));
  console.log('\n=== OVERALL:', allOk ? 'ALL GRIP TESTS PASS' : 'GRIP TESTS FAILED', '===');
  cdp.close();
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('harness failed:', e); process.exit(2); });
