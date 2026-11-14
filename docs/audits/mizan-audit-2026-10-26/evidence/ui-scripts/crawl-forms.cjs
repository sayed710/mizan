// Arabic mode: open the first record's form of every action route and collect Latin-script UI chrome
// (labels, headers, buttons, tabs, statusbar, totals, smart buttons, selects' options, alerts) + JS errors.
const { chromium } = require('playwright');
const fs = require('fs');
const [BASE, ROUTES, OUT] = process.argv.slice(2);
const routes = JSON.parse(fs.readFileSync(ROUTES, 'utf8')).filter((r) => r.type === 'action' && r.model);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('mizan-lang', 'ar'); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${page.url().split('#')[1]}: ${e.message.slice(0, 140)}`));
  page.on('dialog', (d) => d.dismiss());
  await page.goto(BASE + '/#/');
  await page.waitForSelector('.app-grid');
  // the demo db lives in localStorage once something is committed; read records from the seed via the page instead
  const out = [];
  const seenModel = new Set();
  for (const r of routes) {
    if (seenModel.has(r.model)) continue;
    seenModel.add(r.model);
    await page.evaluate((h) => { location.hash = h + '?view=list'; }, r.hash);
    await page.waitForTimeout(80);
    const hasRow = await page.$('table.list tbody tr:not(.group-row) td:not(.empty)');
    if (!hasRow) { out.push({ hash: r.hash, model: r.model, form: false }); continue; }
    await page.click('table.list tbody tr:not(.group-row) td:nth-child(2)');
    await page.waitForTimeout(100);
    const info = await page.evaluate(() => {
      const sel = '.form-page label, .form-page th, .form-page .tabs button, .form-page .statusbar button, .form-header button, .form-page dt, .smart span, .form-page .ribbon, .form-page .subtitle, .form-page select option, .form-page .alert, .form-page h2, .chatter button, .activities .muted';
      const latin = new Set();
      document.querySelectorAll(sel).forEach((el) => { const tx = (el.textContent || '').trim().replace(/\s+/g, ' '); if (/[A-Za-z]{2,}/.test(tx) && tx.length < 80) latin.add(tx); });
      const boundary = /تعذر عرض/.test(document.querySelector('.shell .alert')?.textContent ?? '') ? document.querySelector('.shell .alert').textContent.slice(0, 140) : null;
      const req = [...document.querySelectorAll('.form-page .field label .req')].length;
      const reqInputs = [...document.querySelectorAll('.form-page [required], .form-page [aria-required=true]')].length;
      const orphanLabels = [...document.querySelectorAll('.form-page label[for]')].filter((l) => !document.getElementById(l.htmlFor)).length;
      const numInputs = document.querySelectorAll('.form-page input[type=number]').length;
      return { latin: [...latin], boundary, req, reqInputs, orphanLabels, numInputs };
    });
    out.push({ hash: r.hash, model: r.model, form: true, url: page.url().split('#')[1], ...info });
  }
  fs.writeFileSync(OUT, JSON.stringify({ out, errors }, null, 1));
  await browser.close();
  console.log('forms', out.filter((x) => x.form).length, 'of', out.length);
})();
