// Keyboard-only: can a user open a record from the List view? Can the Navbar dropdown be closed with Escape? Is focus moved into the search panel?
const { chromium } = require('playwright');
const [BASE] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
  await page.goto(BASE + '/#/sales/orders?view=list'); await page.waitForSelector('table.list tbody tr');
  const focusables = await page.evaluate(() => [...document.querySelectorAll('table.list tbody tr')].map((tr) => [...tr.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].map((e) => e.tagName + (e.type ? ':' + e.type : '')).join(',')).slice(0, 3));
  console.log('focusable elements per list row:', JSON.stringify(focusables));
  // Tab from the search input until we reach the first row checkbox, then press Enter and Space
  await page.focus('table.list tbody tr input[type=checkbox]');
  const before = page.url();
  await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  console.log('Enter on focused row checkbox -> navigated to form?', page.url() !== before);
  // group rows
  await page.goto(BASE + '/#/sales/orders?view=list');
  // navbar dropdown
  await page.goto(BASE + '/#/sales'); await page.waitForSelector('.nav-group button');
  await page.focus('.nav-group button'); await page.keyboard.press('Enter'); await page.waitForTimeout(100);
  const opened = !!(await page.$('.nav-dropdown'));
  const activeAfterOpen = await page.evaluate(() => document.activeElement?.className + '|' + document.activeElement?.textContent);
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  console.log('navbar dropdown opened by Enter:', opened, '| focus after open:', activeAfterOpen, '| still open after Escape:', !!(await page.$('.nav-dropdown')));
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(50);
  console.log('ArrowDown moves focus into menu:', await page.evaluate(() => document.activeElement?.getAttribute('role')));
  // search panel "dialog"
  await page.goto(BASE + '/#/sales/orders?view=list'); await page.waitForSelector('.search-toggle');
  await page.click('.search-toggle'); await page.waitForTimeout(100);
  console.log('search panel open; focus is in it:', await page.evaluate(() => !!document.activeElement?.closest('.search-panel')), '| aria-modal:', await page.evaluate(() => document.querySelector('.search-panel')?.getAttribute('aria-modal')));
  await browser.close();
})();
