const W = process.argv[2];
const { seed } = await import(W + '/src/seed.js');
const { applyDiff, diffDb } = await import(W + '/src/sync.js');
const { create, read, write, unlink, search } = await import(W + '/src/orm.js');
const { models, modelsForApps } = await import(W + '/src/models/index.js');
const crmUser = { author: 'Carol (CRM only)', isAdmin: false, allowed: modelsForApps(['crm']) };
const base0 = seed();
const E = { upserts: {}, deletes: {}, messages: [], removedMessages: [] };
const tryApply = (db, d, o) => { try { return applyDiff(db, d, o); } catch (e) { console.log('   rejected:', e.message); return db; } };

// a) replay of an old diff reverts a newer edit; replaying a create is idempotent
{
  const b = base0;
  const d1 = diffDb(b, write(b, 'crm.lead', 1, { priority: 2 }));
  let s = applyDiff(b, d1);
  s = applyDiff(s, diffDb(s, write(s, 'crm.lead', 1, { priority: 3 })));
  s = applyDiff(s, d1); // replay
  const c = create(b, 'crm.lead', { name: 'Replay lead' });
  const dc = diffDb(b, c.db);
  let r = applyDiff(b, dc); r = applyDiff(r, dc);
  console.log('[a] priority after edit to 3 then replay of the old diff:', read(s, 'crm.lead', 1).priority, '| create diff replayed twice -> leads named "Replay lead":', search(r, 'crm.lead').filter((l) => l.name === 'Replay lead').length, 'created-messages', r.messages.filter((m) => m.res_id === c.id && m.model === 'crm.lead').length);
}
// b) sequence poisoning by a CRM-only user on a model outside their apps
{
  let s = tryApply(base0, { ...E, seq: { 'account.move': 1e300, 'res.partner': 2 ** 53 } }, crmUser);
  console.log('\n[b] CRM-only user sets seq: account.move', s.seq['account.move'], 'res.partner', s.seq['res.partner'], '(allowed has account.move:', crmUser.allowed.has('account.move'), ')');
  const p1 = create(s, 'res.partner', { name: 'First after poisoning' }); s = applyDiff(s, diffDb(s, p1.db), crmUser);
  const p2 = create(s, 'res.partner', { name: 'Second after poisoning' }); s = applyDiff(s, diffDb(s, p2.db), crmUser);
  console.log('   partner ids', p1.id, p2.id, 'equal?', p1.id === p2.id, '| partners named *after poisoning*:', search(s, 'res.partner').filter((p) => p.name.endsWith('after poisoning')).map((p) => p.name));
  const m1 = create(s, 'account.move', { move_type: 'entry', ref: 'one', line_ids: [] }); s = applyDiff(s, diffDb(s, m1.db));
  const m2 = create(s, 'account.move', { move_type: 'entry', ref: 'two', line_ids: [] }); s = applyDiff(s, diffDb(s, m2.db));
  console.log('   account.move ids', m1.id, m2.id, '| moves with ref one/two:', search(s, 'account.move').filter((m) => ['one', 'two'].includes(m.ref)).map((m) => m.ref));
}
// c) audit trail: client-asserted tracking messages
{
  let s = applyDiff(base0, { ...E, settings: { ...base0.settings, audit_trail: true } }, { isAdmin: true });
  const inv = search(s, 'account.move').find((m) => m.name === 'INV/2026/00002');
  const tampered = { ...inv, invoice_line_ids: inv.invoice_line_ids.map((l) => ({ ...l, price_unit: 1 })), narration: 'edited' };
  const before = s.messages.length;
  s = tryApply(s, { ...E, upserts: { 'account.move': [tampered] } }, { author: 'Mallory', isAdmin: false });
  console.log('\n[c] audit_trail', s.settings.audit_trail, '| posted', inv.name, 'total', inv.amount_total, '-> server total', read(s, 'account.move', inv.id).amount_total, '| messages added by the server:', s.messages.length - before);
  s = tryApply(s, { ...E, messages: [{ id: 'forged-1', model: 'account.move', res_id: inv.id, body: 'Total: 1710 → 1710 (approved by CFO)', kind: 'tracking', date: '2020-01-01T00:00:00.000Z' }] }, { author: 'Mallory', isAdmin: false });
  const f = s.messages.find((m) => m.id === 'forged-1');
  console.log('   forged tracking message accepted:', !!f, f && `date=${f.date} author=${f.author} kind=${f.kind}`);
  const note = s.messages.find((m) => crmUser.allowed.has(m.model)) ?? s.messages.find((m) => m.model !== 'account.move');
  const s2 = tryApply(s, { ...E, removedMessages: [note.id] }, crmUser);
  console.log('   CRM user deletes chatter message', note.id.slice(0, 8), 'by', note.author, 'on '+note.model+' -> still present:', s2.messages.some((m) => m.id === note.id));
}
// d) referential integrity: delete a partner used by posted invoices; dangling many2one
{
  const pid = 3;
  const s = tryApply(base0, { ...E, deletes: { 'res.partner': [pid] } }, crmUser);
  const dangling = [];
  for (const [model, recs] of Object.entries(s.records)) {
    const fields = models[model]?.fields ?? {};
    for (const r of recs) for (const [k, f] of Object.entries(fields)) {
      if (f.type === 'many2one' && f.relation === 'res.partner' && r[k] === pid) dangling.push(`${model}#${r.id}.${k}`);
      if (f.type === 'one2many') for (const l of r[k] ?? []) for (const [lk, lf] of Object.entries(f.fields ?? {})) if (lf.type === 'many2one' && lf.relation === 'res.partner' && l[lk] === pid) dangling.push(`${model}#${r.id}.${k}[].${lk}`);
    }
  }
  console.log('\n[d] CRM-only user deletes res.partner', pid, '(', read(base0, 'res.partner', pid).name, ') -> gone:', !read(s, 'res.partner', pid), '| dangling refs:', dangling.length, dangling.slice(0, 8).join(', '));
  const s3 = tryApply(base0, { ...E, upserts: { 'sale.order': [{ ...read(base0, 'sale.order', 1), partner_id: 999999 }] } }, crmUser);
  console.log('   sale.order#1 partner_id set to 999999 accepted:', read(s3, 'sale.order', 1).partner_id === 999999);
  // onUnlink bypass: server never runs onUnlink for raw deletes
  const draft = search(base0, 'account.move').find((m) => m.state === 'draft');
  const viaOrm = unlink(base0, 'account.move', [draft.id]);
  const viaRaw = applyDiff(base0, { ...E, deletes: { 'account.move': [draft.id] } });
  console.log('   delete draft move', draft.id, 'via client unlink() changes', Object.keys(diffDb(base0, viaOrm).upserts).join(',') || '(no other records)', '| raw diff delete changes other records:', Object.keys(diffDb(base0, viaRaw).upserts).join(',') || '(none)');
}
// e) company selection is global db.settings shared by every user
{
  const s = tryApply(base0, { ...E, settings: { current_company_id: 1, allowed_company_ids: [1] } }, crmUser);
  console.log('\n[e] non-admin company switch writes shared settings: current_company_id', base0.settings.current_company_id, '->', s.settings.current_company_id, '| users table has a company column? (see index.js:56-59)');
}
