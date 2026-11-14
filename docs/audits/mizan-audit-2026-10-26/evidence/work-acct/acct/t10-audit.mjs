import { seed } from '../src/seed.js';
import { read, search, write } from '../src/orm.js';
import { applyDiff, diffDb } from '../src/sync.js';
import { modelsForApps } from '../src/models/index.js';
const base0 = seed();
const base = { ...base0, settings: { ...base0.settings, audit_trail: true } };
const inv = search(base, 'account.move').find((m) => m.move_type === 'out_invoice' && m.state === 'posted' && m.amount_residual > 0);
// honest client edit of a tracked field creates messages client-side
const honest = write(base, 'account.move', inv.id, { ref: 'PO-123' });
const d = diffDb(base, honest);
console.log('honest diff carries', d.messages.length, 'tracking message(s):', d.messages.map((m) => m.body));
const s1 = applyDiff(base, d, { isAdmin: false, allowed: modelsForApps(['accounting']), author: 'alice' });
// forged: same change, strip messages
const s2 = applyDiff(base, { ...d, messages: [] }, { isAdmin: false, allowed: modelsForApps(['accounting']), author: 'mallory' });
const cnt = (db) => db.messages.filter((m) => m.model === 'account.move' && m.res_id === inv.id).length;
console.log('server messages for move after honest diff:', cnt(s1), '| after forged diff without messages:', cnt(s2), '| ref on server:', read(s2, 'account.move', inv.id).ref);
// try to remove the honest audit message
const mid = s1.messages.find((m) => m.model === "account.move" && m.res_id === inv.id).id;
console.log("s1 audit_trail", s1.settings.audit_trail, "msg", s1.messages.find((m) => m.res_id === inv.id).model);
const s3 = applyDiff(s1, { upserts: {}, deletes: {}, messages: [], removedMessages: [mid], seq: s1.seq, settings: null }, { isAdmin: false });
console.log('audited message removable?', s3.messages.some((m) => m.id === mid) ? 'no (kept)' : 'yes (removed)');
// audit trail off: removal allowed
const off = { ...s1, settings: { ...s1.settings, audit_trail: false } };
const s4 = applyDiff(off, { upserts: {}, deletes: {}, messages: [], removedMessages: [mid], seq: off.seq, settings: null }, { isAdmin: false });
console.log('audit trail OFF: message removable?', s4.messages.some((m) => m.id === mid) ? 'no' : 'yes (removed)');
