// General Settings "Company Name" and "Currency": do they change what is printed / displayed?
const { chromium } = require('playwright');
const [BASE] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE + '/#/settings/general'); await page.waitForSelector('#company');
  console.log('settings company field:', JSON.stringify(await page.inputValue('#company')), '| settings currency:', await page.inputValue('#currency'));
  await page.fill('#company', 'Renamed Trading LLC');
  await page.selectOption('#currency', 'EGP');
  await page.waitForTimeout(300);
  console.log('navbar company now:', JSON.stringify(await page.textContent('header.navbar .company').catch(() => null)));
  await page.evaluate(() => { location.hash = '#/print/account.move/4'; }); await page.waitForTimeout(400);
  const body = (await page.textContent('body')).replace(/\s+/g, ' ');
  console.log('printed invoice company/currency:', JSON.stringify(body.slice(0, 60)), '| first amount:', (body.match(/(EGP|E£|\$|USD)\s?[\d,]+\.\d\d/) ?? [''])[0]);
  await page.evaluate(() => { location.hash = '#/accounting/dashboard'; }); await page.waitForTimeout(300);
  console.log('dashboard first KPI:', (await page.textContent('.kpi b')));
  await browser.close();
})();
