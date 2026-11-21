import { seed, orm, btn, tryIt, log, applyDiff, diffDb } from './lib.mjs';
const { create, read, search } = orm;
const base = seed();
// user A and user B both have the same snapshot (poll interval 15 s) and each create a quotation
const A = create(base, 'sale.order', { partner_id: 1, order_line: [{ product_id: 1, qty: 1, price_unit: 210, tax: 0 }] });
const B = create(base, 'sale.order', { partner_id: 5, order_line: [{ product_id: 4, qty: 9, price_unit: 35, tax: 0 }] });
log('A id', A.id, 'B id', B.id);
let server = applyDiff(base, diffDb(base, A.db), { isAdmin: false, author: 'A' });
server = applyDiff(server, diffDb(base, B.db), { isAdmin: false, author: 'B' });
const rec = read(server, 'sale.order', A.id);
log('server sale.order #' + A.id, 'partner', rec.partner_id, '| A\'s quotation (partner 1) survives?', search(server, 'sale.order').some((o) => o.partner_id === 1 && o.order_line?.[0]?.product_id === 1 && o.id === A.id), '| count', search(base, 'sale.order').length, '->', search(server, 'sale.order').length);
// invoices posted concurrently get the same id and the same number
const s1 = search(base, 'sale.order').find((o) => o.state === 'sale' && o.invoice_status === 'to_invoice');
log('order to invoice', s1?.name);
