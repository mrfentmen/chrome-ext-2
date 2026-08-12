#!/usr/bin/env node
/*
 * E2E for the new features:
 *  - whiteboard: zoom slider / 100% / Fit, exact size inputs, zoom-aware grip
 *    drag, tab-mode auto-fit, persistence
 *  - image-to-pdf + image-resize-compressor: editor corner-grip resize
 * All pages are watched for console errors / exceptions.
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
  page.__ws = page.ws;
  // tap into onmessage by wrapping
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

async function setSlider(page, id, value) {
  return evalIn(page, `(() => { const el = document.getElementById('${id}'); el.value = ${value}; el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`);
}
async function click(page, id) {
  return evalIn(page, `(() => { const el = document.getElementById('${id}'); if (!el) return 'missing'; el.click(); return 'clicked'; })()`);
}

async function main() {
  const ver = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.open();
  const wbId = extId(`${BASE}/whiteboard/ext`);
  const pdfId = extId(`${BASE}/image-to-pdf/ext`);
  const resId = extId(`${BASE}/image-resize-compressor/ext`);
  const results = {};

  // ================= whiteboard =================
  {
    const p = await openPage(cdp, `chrome-extension://${wbId}/popup.html`);
    await sleep(1500);
    const fresh = await evalIn(p.page, `new Promise((res) => chrome.storage.local.clear(res)).then(() => { const c = document.getElementById('board'); return { w: c.width, h: c.height }; })`);
    await sleep(400);

    // 1. zoom slider to 50%
    await setSlider(p.page, 'zoom', 50);
    await sleep(200);
    results.zoom50 = await evalIn(p.page, `(() => ({
      dispW: document.getElementById('board').style.width,
      dispH: document.getElementById('board').style.height,
      label: document.getElementById('zoom-label').textContent
    }))()`);
    results.zoom50ok = results.zoom50.dispW === '170px' && results.zoom50.dispH === '210px' && results.zoom50.label === '50%';

    // 2. back to 100%
    await click(p.page, 'zoom-100');
    await sleep(200);
    results.zoom100 = await evalIn(p.page, `(() => ({ dispW: document.getElementById('board').style.width, label: document.getElementById('zoom-label').textContent }))()`);
    results.zoom100ok = results.zoom100.dispW === '340px' && results.zoom100.label === '100%';

    // 3. exact size inputs -> 600x500
    await evalIn(p.page, `(() => { document.getElementById('size-w').value = '600'; document.getElementById('size-h').value = '500'; })()`);
    await click(p.page, 'size-apply');
    await sleep(500);
    const sized = await evalIn(p.page, `(async () => {
      const c = document.getElementById('board');
      const st = await new Promise((res) => chrome.storage.local.get(['wbSize','wbStrokes'], res));
      return { w: c.width, h: c.height, size: st.wbSize, firstX0: st.wbStrokes && st.wbStrokes[0] && st.wbStrokes[0].x0 };
    })()`);
    results.sized = sized;
    results.sizedOk = sized.w === 600 && sized.h === 500 && sized.size.w === 600 && sized.size.h === 500 && sized.firstX0 === 92; // 52 * 600/340

    // 4. zoom-aware grip drag: at 50% zoom, +100,+80 screen -> +200,+160 size
    await setSlider(p.page, 'zoom', 50);
    await sleep(200);
    const gripPos = await evalIn(p.page, `(() => { const r = document.getElementById('resize-grip').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await drag(p.page, gripPos, { x: gripPos.x + 100, y: gripPos.y + 80 });
    await sleep(500);
    results.gripZoom = await evalIn(p.page, `(() => { const c = document.getElementById('board'); return { w: c.width, h: c.height }; })()`);
    results.gripZoomOk = results.gripZoom.w === 800 && results.gripZoom.h === 660; // 600+200, 500+160

    // 5. exact size -> 1400x1100, then Fit (< 100% in tab viewport)
    await click(p.page, 'zoom-100');
    await evalIn(p.page, `(() => { document.getElementById('size-w').value = '1400'; document.getElementById('size-h').value = '1100'; })()`);
    await click(p.page, 'size-apply');
    await sleep(400);
    await click(p.page, 'zoom-fit');
    await sleep(300);
    results.fit = await evalIn(p.page, `(() => ({
      zoom: document.getElementById('zoom').value,
      label: document.getElementById('zoom-label').textContent,
      dispW: Math.round(document.getElementById('board').getBoundingClientRect().width),
      scrollW: document.querySelector('.board-scroll').clientWidth
    }))()`);
    results.fitOk = Number(results.fit.zoom) < 100 && Number(results.fit.zoom) > 10 &&
      results.fit.dispW <= results.fit.scrollW;

    results.wbErrors = p.errs;
    await cdp.send('Target.closeTarget', { targetId: p.targetId });
    p.page.close();
  }

  // ================= whiteboard keyboard zoom =================
  {
    const p = await openPage(cdp, `chrome-extension://${wbId}/popup.html`);
    await sleep(1500);
    // storage has wbSize 1400x1100 from the section above; zoom starts at 1
    const keyCombo = async (key, code, modifiers) => {
      await p.page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
      await p.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
      await sleep(120);
    };
    // Ctrl+= x3 -> 130%
    for (let i = 0; i < 3; i++) await keyCombo('=', 'Equal', 2);
    const afterPlus = await evalIn(p.page, `(() => ({
      label: document.getElementById('zoom-label').textContent,
      dispW: Math.round(document.getElementById('board').getBoundingClientRect().width)
    }))()`);
    const toast1 = await evalIn(p.page, `(() => { const t = document.getElementById('zoom-toast'); return { text: t.textContent, hidden: t.hidden, show: t.classList.contains('show') }; })()`);
    // Meta+- x2 -> 110%
    await keyCombo('-', 'Minus', 4);
    await keyCombo('-', 'Minus', 4);
    const afterMinus = await evalIn(p.page, `(() => ({ label: document.getElementById('zoom-label').textContent }))()`);
    // Ctrl+0 -> Fit (label < 100%, board fits the scroll area)
    await keyCombo('0', 'Digit0', 2);
    const afterFit = await evalIn(p.page, `(() => ({
      label: document.getElementById('zoom-label').textContent,
      dispW: Math.round(document.getElementById('board').getBoundingClientRect().width),
      scrollW: document.querySelector('.board-scroll').clientWidth
    }))()`);
    await sleep(1300);
    const toastGone = await evalIn(p.page, `document.getElementById('zoom-toast').hidden`);
    results.kbd = { afterPlus, afterMinus, afterFit, toast1, toastGone };
    results.kbdOk = afterPlus.label === '130%' && afterPlus.dispW === Math.round(1400 * 1.3) &&
      toast1.text === '130%' && !toast1.hidden && toast1.show && toastGone === true &&
      afterMinus.label === '110%' &&
      Number(afterFit.label.replace('%', '')) < 100 && afterFit.dispW <= afterFit.scrollW;

    // undo/redo: Ctrl+Z pops strokes, Ctrl+Shift+Z and the redo button restore them
    const strokes = () => evalIn(p.page, `new Promise((res) => chrome.storage.local.get('wbStrokes', (d) => res((d.wbStrokes || []).length)))`);
    const n0 = await strokes();
    await keyCombo('z', 'KeyZ', 2);
    await sleep(650);
    const n1 = await strokes();
    await keyCombo('z', 'KeyZ', 2);
    await sleep(650);
    const n2 = await strokes();
    await keyCombo('z', 'KeyZ', 10); // Ctrl+Shift+Z
    await sleep(650);
    const n3 = await strokes();
    await evalIn(p.page, `document.getElementById('redo').click(); 'clicked'`);
    await sleep(650);
    const n4 = await strokes();
    results.undoRedo = { n0, n1, n2, n3, n4, redoBtn: await evalIn(p.page, `!!document.getElementById('redo')`) };
    results.undoRedoOk = n0 > 2 && n1 === n0 - 1 && n2 === n0 - 2 && n3 === n0 - 1 && n4 === n0;
    results.kbdErrors = p.errs;
    await cdp.send('Target.closeTarget', { targetId: p.targetId });
    p.page.close();
  }

  // ================= whiteboard tab auto-fit =================
  {
    const p = await openPage(cdp, `chrome-extension://${wbId}/popup.html?tab=1`);
    await sleep(1800);
    results.tabAutoFit = await evalIn(p.page, `(() => ({
      zoom: document.getElementById('zoom').value,
      label: document.getElementById('zoom-label').textContent,
      isTab: document.body.classList.contains('tab-mode'),
      sizeW: document.getElementById('board').width
    }))()`);
    // storage has 1400x1100, tab viewport smaller -> zoom < 100%
    results.tabAutoFitOk = results.tabAutoFit.isTab && Number(results.tabAutoFit.zoom) < 100 && results.tabAutoFit.sizeW === 1400;
    await cdp.send('Target.closeTarget', { targetId: p.targetId });
    p.page.close();
  }

  // ================= image-to-pdf editor grip =================
  {
    const p = await openPage(cdp, `chrome-extension://${pdfId}/popup.html?sample=1`);
    await sleep(3000);
    const before = await evalIn(p.page, `(() => ({ w: document.getElementById('editor').offsetWidth, h: document.getElementById('editor').offsetHeight }))()`);
    const gp = await evalIn(p.page, `(() => { const r = document.getElementById('resize-grip').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await drag(p.page, gp, { x: gp.x + 150, y: gp.y + 120 });
    await sleep(400);
    const after = await evalIn(p.page, `(() => ({ w: document.getElementById('editor').offsetWidth, h: document.getElementById('editor').offsetHeight }))()`);
    await click(p.page, 'convert');
    await sleep(2500);
    const converted = await evalIn(p.page, `document.getElementById('out-size').textContent`);
    results.pdfGrip = { before, after, converted };
    results.pdfGripOk = after.w === before.w + 150 && after.h === before.h + 120 && /PDF ready/.test(converted || '');
    results.pdfErrors = p.errs;
    await cdp.send('Target.closeTarget', { targetId: p.targetId });
    p.page.close();
  }

  // ================= image-resize editor grip =================
  {
    const p = await openPage(cdp, `chrome-extension://${resId}/popup.html?sample=1`);
    await sleep(3000);
    const before = await evalIn(p.page, `(() => ({ w: document.getElementById('editor').offsetWidth, h: document.getElementById('editor').offsetHeight }))()`);
    const gp = await evalIn(p.page, `(() => { const r = document.getElementById('resize-grip').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await drag(p.page, gp, { x: gp.x + 150, y: gp.y + 120 });
    await sleep(400);
    const after = await evalIn(p.page, `(() => ({ w: document.getElementById('editor').offsetWidth, h: document.getElementById('editor').offsetHeight }))()`);
    const est = await evalIn(p.page, `document.getElementById('out-size').textContent`);
    results.resGrip = { before, after, est };
    results.resGripOk = after.w === before.w + 150 && after.h === before.h + 120 && /Estimated output/.test(est || '');
    results.resErrors = p.errs;
    await cdp.send('Target.closeTarget', { targetId: p.targetId });
    p.page.close();
  }

  const summarize = (e) => ({
    console: [...new Set(e.console)], exceptions: [...new Set(e.exceptions)], net: [...new Set(e.net)],
  });
  results.wbErrors = summarize(results.wbErrors);
  results.kbdErrors = summarize(results.kbdErrors);
  results.pdfErrors = summarize(results.pdfErrors);
  results.resErrors = summarize(results.resErrors);

  const clean = (e) => e.console.length === 0 && e.exceptions.length === 0 && e.net.length === 0;
  const allOk =
    results.zoom50ok && results.zoom100ok && results.sizedOk && results.gripZoomOk && results.fitOk &&
    results.kbdOk && results.undoRedoOk && results.tabAutoFitOk && results.pdfGripOk && results.resGripOk &&
    clean(results.wbErrors) && clean(results.kbdErrors) && clean(results.pdfErrors) && clean(results.resErrors);

  console.log(JSON.stringify(results, null, 2));
  console.log('\n=== OVERALL:', allOk ? 'ALL E2E PASS' : 'E2E PROBLEMS', '===');
  cdp.close();
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('harness failed:', e); process.exit(2); });
