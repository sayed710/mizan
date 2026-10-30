import { seed } from '../src/seed.js';
import { read, search, create, unlink } from '../src/orm.js';
import { applyDiff, diffDb } from '../src/sync.js';
import { models } from '../src/models/index.js';
import { payMove } from '../src/models/accounting.js';
import { invariants, press } from './lib.mjs';
const base = seed();
const drafts = search(base, 'account.move').filter((m) => m.state === 'draft');
console.log('draft invoices in seed:', drafts.map((m) => m.id + ':' + m.move_type));
// A: two users post two different draft invoices from the same snapshot
let a = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 14 }] });
const baseA = a.db; const idX = a.id;
let b = create(baseA, 'account.move', { move_type: 'out_invoice', partner_id: 4, invoice_line_ids: [{ product_id: 2, qty: 1, price_unit: 200, tax: 14 }] });
const shared = b.db; const idY = b.id; // both drafts exist on server
const userA = press(shared, 'account.move', idX, 'Confirm');
const userB = press(shared, 'account.move', idY, 'Confirm');
let server = applyDiff(shared, diffDb(shared, userA), { isAdmin: false });
server = applyDiff(server, diffDb(shared, userB), { isAdmin: false });
console.log('A) concurrent post ->', read(server, 'account.move', idX).name, '/', read(server, 'account.move', idY).name);
// B: two users each register a payment from same snapshot on different invoices -> both create account.move with same new id
const inv1 = search(shared, 'account.move').find((m) => m.move_type === 'out_invoice' && m.state === 'posted' && m.amount_residual > 0);
const bill = search(shared, 'account.move').find((m) => m.move_type === 'in_invoice' && m.state === 'posted' && m.amount_residual > 0);
const uA = payMove(shared, inv1.id, 100, '2026-10-20');
const uB = payMove(shared, bill.id, 200, '2026-10-20');
const newA = uA.records['account.move'].at(-1), newB = uB.records['account.move'].at(-1);
console.log('B) payment move ids chosen by clients: A', newA.id, newA.name, ' B', newB.id, newB.name);
let s2 = applyDiff(shared, diffDb(shared, uA), { isAdmin: false });
s2 = applyDiff(s2, diffDb(shared, uB), { isAdmin: false });
const survivor = read(s2, 'account.move', newA.id);
console.log('   server keeps move', survivor.id, survivor.name, survivor.ref, '| invoice', read(s2, 'account.move', inv1.id).name, 'amount_paid', read(s2, 'account.move', inv1.id).amount_paid);
const pays = (s2.records['account.payment'] ?? []).filter((p) => p.amount === 100 || p.amount === 200).map((p) => `${p.id}:${p.name}:${p.amount}:move${p.move_id}`);
console.log('   payments on server', pays);
console.log('   invariants', JSON.stringify(invariants(s2).receivable), JSON.stringify(invariants(s2).payable));
// C: number reuse after deleting a posted invoice (no audit trail)
let d = press(shared, 'account.move', idX, 'Confirm');
d = press(d, 'account.move', idY, 'Confirm');
console.log('C) posted:', read(d, 'account.move', idX).name, read(d, 'account.move', idY).name);
const resetBtn = models['account.move'].form.buttons.find((x) => x.label === 'Reset to Draft');
d = resetBtn.run(d, read(d, 'account.move', idX)).db;
d = unlink(d, 'account.move', [idX]);
let c = create(d, 'account.move', { move_type: 'out_invoice', partner_id: 5, invoice_line_ids: [{ product_id: 1, qty: 2, price_unit: 50, tax: 14 }] });
d = press(c.db, 'account.move', c.id, 'Confirm');
const names = search(d, 'account.move').filter((m) => m.name?.startsWith('INV/')).map((m) => m.name);
console.log('   after reset+delete+new post, INV names:', names, 'duplicates:', names.filter((x, i) => names.indexOf(x) !== i));
// D: reset-to-draft keeps journal items? 
let e = press(shared, 'account.move', idX, 'Confirm');
e = resetBtn.run(e, read(e, 'account.move', idX)).db;
const ex = read(e, 'account.move', idX);
console.log('D) after Reset to Draft: state', ex.state, 'name', ex.name, 'line_ids kept', ex.line_ids.length);
// E: reset to draft of an invoice with partial payment via amount_paid=0 trick? Reset hidden when amount_paid>0, but payments exist
