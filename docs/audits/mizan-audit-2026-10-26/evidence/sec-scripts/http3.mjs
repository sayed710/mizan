const P = process.argv[2]; const B = `http://127.0.0.1:${P}`;
const H = { 'x-requested-with': 'mizan', 'content-type': 'application/json' };
const admin = await (async () => { const r = await fetch(B + '/api/login', { method: 'POST', headers: H, body: JSON.stringify({ login: 'admin', password: 'Adm1nPass!x' }) }); return r.headers.get('set-cookie').split(';')[0]; })();
// path traversal
for (const p of ['/../package.json', '/..%2f..%2fserver/index.js', '/assets/../../package.json']) {
  const r = await fetch(B + p, { redirect: 'manual' }); const t = (await r.text()).slice(0, 40).replace(/\n/g, ' ');
  console.log('GET', p, '->', r.status, r.headers.get('content-type'), JSON.stringify(t));
}
// open redirect: return param on / while logged in
for (const back of ['/dashboard', '//evil.com/x', '/\\evil.com', 'https://evil.com', '/%2f%2fevil.com']) {
  const r = await fetch(B + '/?return=' + encodeURIComponent(back), { headers: { cookie: admin }, redirect: 'manual' });
  console.log('return=' + JSON.stringify(back), '->', r.status, 'Location:', r.headers.get('location'));
}
// public cart price recompute: send bogus prices, see if ignored
const cart = await fetch(B + '/api/public/cart', { method: 'POST', headers: H, body: JSON.stringify({ lines: [{ product_id: 2, qty: 1, price_unit: 0.01 }] }) });
console.log('public cart (client price 0.01):', JSON.stringify(await cart.json()).slice(0, 160));
// reset wipes data: create a lead, reset, check gone
console.log('reset by admin:', (await fetch(B + '/api/reset', { method: 'POST', headers: { ...H, cookie: admin } })).status);
// SECURE cookie flag in this non-prod run
console.log('login Set-Cookie flags:', (await fetch(B + '/api/login', { method: 'POST', headers: H, body: JSON.stringify({ login: 'admin', password: 'Adm1nPass!x' }) })).headers.get('set-cookie'));
