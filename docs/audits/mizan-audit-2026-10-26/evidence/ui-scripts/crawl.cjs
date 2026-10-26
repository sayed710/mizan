// Crawl every menu route in browser-only demo mode, in Arabic, desktop width; collect render errors, untranslated
// Latin text, unnamed controls, unlabeled inputs, slow routes. Then sample routes at 375px for horizontal overflow.
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.argv[2];
const routes = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const OUT = process.argv[4];
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('mizan-lang', 'ar'); } catch {} });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`${page.url().split('#')[1]} pageerror: ${e.message.slice(0, 160)}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${page.url().split('#')[1]} console: ${m.text().slice(0, 160)}`); });
  page.on('dialog', (d) => d.dismiss());
  await page.goto(BASE + '/#/');
  await page.waitForSelector('.app-grid');
  const res = [];
  for (const r of routes) {
    const t0 = Date.now();
    await page.evaluate((h) => { location.hash = h; }, r.hash);
    await page.waitForTimeout(120);
    const info = await page.evaluate(() => {
      const main = document.querySelector('.shell > main, .shell > *:not(header)') || document.body;
      const boundary = !!document.querySelector('.shell .alert[role=alert]') && /تعذر|could not be displayed|This screen/.test(document.querySelector('.shell .alert[role=alert]')?.textContent ?? '');
      const errText = boundary ? document.querySelector('.shell .alert[role=alert]').textContent.slice(0, 160) : null;
      // visible text nodes with Latin words of 3+ letters (exclude record data in table cells / cards / inputs is impossible to separate perfectly; count UI chrome only)
      const latin = new Set();
      const chrome = document.querySelectorAll('header.navbar, .control-panel, th, label, button, .tabs, .statusbar, h1, h2, h3, .cp-title, dt, .column-head, .smart span, legend, .empty, .alert, option');
      chrome.forEach((el) => { const tx = (el.innerText || el.textContent || '').trim(); if (/[A-Za-z]{3,}/.test(tx) && tx.length < 60) latin.add(tx.replace(/\s+/g, ' ')); });
      const ctrls = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [tabindex]')].filter((e) => e.offsetParent !== null || e.getClientRects().length);
      const nameOf = (e) => (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.getAttribute('title') || (e.labels && e.labels.length ? [...e.labels].map((l) => l.textContent).join('') : '') || (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName) ? '' : e.textContent) || e.getAttribute('placeholder') || '').trim();
      const unnamed = ctrls.filter((e) => !nameOf(e) && !(e.tagName === 'INPUT' && ['submit', 'button'].includes(e.type) && e.value)).map((e) => `${e.tagName.toLowerCase()}${e.type ? '[' + e.type + ']' : ''}.${[...e.classList].join('.')}`);
      const placeholderOnly = ctrls.filter((e) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) && !e.getAttribute('aria-label') && !(e.labels && e.labels.length) && e.getAttribute('placeholder')).length;
      const clickRows = document.querySelectorAll('tr[class]:not([tabindex])').length;
      const ids = [...document.querySelectorAll('[id]')].map((e) => e.id); const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
      const rows = document.querySelectorAll('table.list tbody tr').length;
      const cards = document.querySelectorAll('article.card').length;
      return { boundary, errText, latin: [...latin].slice(0, 30), unnamed: [...new Set(unnamed)].slice(0, 10), unnamedCount: unnamed.length, placeholderOnly, clickRows, dupIds: [...new Set(dupIds)].slice(0, 5), rows, cards, dir: document.documentElement.dir, lang: document.documentElement.lang };
    });
    res.push({ ...r, ms: Date.now() - t0, ...info });
  }
  // mobile overflow on a sample
  await page.setViewportSize({ width: 375, height: 800 });
  const sample = routes.filter((_, i) => i % 6 === 0);
  const overflow = [];
  for (const r of sample) {
    await page.evaluate((h) => { location.hash = h; }, r.hash);
    await page.waitForTimeout(100);
    const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, nav: document.querySelector('.navbar')?.scrollWidth ?? 0 }));
    if (w.sw > w.cw + 1) overflow.push(`${r.hash} scrollWidth=${w.sw} > ${w.cw}`);
  }
  fs.writeFileSync(OUT, JSON.stringify({ res, consoleErrors, overflow, sampleSize: sample.length }, null, 1));
  await browser.close();
  console.log('done', res.length);
})();
