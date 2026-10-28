import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import {
  abSample, dueAbWinners, dueMailings, markBounced, mailingModels, queueMailing, recipientsOf,
  renderTemplate, selectWinner, sendWinner, trackEvent, unsubscribe,
} from './models/mailing.js';
import { seed } from './seed.js';

const NOW = '2026-10-25';
const tokens = () => { let n = 0; return () => `tok-${++n}`; };
const mailing = (db, vals) => {
  const { db: next, id } = create(db, 'mailing.mailing', { subject: 'Hello {{ object.name }}', ...vals });
  return { db: next, m: read(next, 'mailing.mailing', id) };
};
const emails = (rs) => rs.map((r) => r.email);
const traces = (db, id) => search(db, 'mailing.trace').filter((t) => t.mailing_id === id);

test('renderTemplate fills nested and missing fields and leaves other braces alone', () => {
  const obj = { name: 'Sara', partner: { city: 'Giza' }, n: 0 };
  assert.equal(renderTemplate('Hi {{ object.name }} from {{object.partner.city}} ({{ object.n }})', obj), 'Hi Sara from Giza (0)');
  assert.equal(renderTemplate('[{{ object.missing.deep }}]', obj), '[]');
  assert.equal(renderTemplate('{{ user.name }} {{ 1 + 1 }}', obj), '{{ user.name }} {{ 1 + 1 }}');
});

test('list recipients skip opt-outs, dedupe by email and drop active blacklisted addresses', () => {
  const db0 = seed();
  const list = search(db0, 'mailing.list')[0].id;
  let db = create(db0, 'mailing.contact', { name: 'Rania again', email: ' RANIA@mail.example ', list_id: list }).db;
  db = create(db, 'mailing.contact', { name: 'No mail', email: '  ', list_id: list }).db;
  const { db: withM, m } = mailing(db, { list_id: list });
  assert.deepEqual(emails(recipientsOf(withM, m)), ['rania@mail.example', 'karim.a@mail.example']);
  const black = create(withM, 'mail.blacklist', { email: 'Karim.A@mail.example' }).db;
  assert.deepEqual(emails(recipientsOf(black, m)), ['rania@mail.example']);
  assert.equal(recipientsOf(black, { ...m, exclude_blacklist: false }).length, 2);
  const inactive = create(withM, 'mail.blacklist', { email: 'karim.a@mail.example', active: false }).db;
  assert.equal(recipientsOf(inactive, m).length, 2);
});

test('partner and lead recipients filter by tag and country (case-insensitive)', () => {
  const db = seed();
  const partners = recipientsOf(db, { mailing_model: 'res.partner', partner_tag: 'Wholesale' });
  assert.deepEqual(partners.map((r) => r.name).sort(), ['Atlas Workspace', 'Gulf Interiors']);
  assert.ok(partners.every((r) => r.res_model === 'res.partner'));
  assert.deepEqual(recipientsOf(db, { mailing_model: 'res.partner', partner_tag: 'Wholesale', partner_country: 'uae' }).map((r) => r.name), ['Gulf Interiors']);
  const withLead = create(db, 'crm.lead', { name: 'Big deal', contact_name: 'Mona', email: 'mona@lead.example', country: 'Egypt', tag_ids: ['Hot'] }).db;
  const leads = recipientsOf(withLead, { mailing_model: 'crm.lead', partner_tag: 'Hot', partner_country: 'EGYPT' });
  assert.deepEqual(leads.map((r) => [r.email, r.name, r.res_model]), [['mona@lead.example', 'Mona', 'crm.lead']]);
  const all = recipientsOf(withLead, { mailing_model: 'crm.lead' });
  assert.equal(new Set(all.map((r) => r.email.toLowerCase())).size, all.length);
});

test('queueMailing creates one sent trace per recipient and sets the counters', () => {
  const db0 = seed();
  const { db, m } = mailing(db0, { list_id: search(db0, 'mailing.list')[0].id });
  const sent = queueMailing(db, m, { now: NOW, token: tokens() });
  const ts = traces(sent, m.id);
  assert.deepEqual(ts.map((t) => [t.email, t.state, t.sent_date, t.token, t.ab_version]),
    [['rania@mail.example', 'sent', NOW, 'tok-1', false], ['karim.a@mail.example', 'sent', NOW, 'tok-2', false]]);
  const after = read(sent, 'mailing.mailing', m.id);
  assert.deepEqual([after.state, after.sent_date, after.sent, after.delivered], ['sent', NOW, 2, 2]);
  assert.throws(() => queueMailing(sent, after, { now: NOW, token: tokens() }), /already been sent/);
  assert.throws(() => queueMailing(db, { ...m, subject: '' }, { now: NOW, token: tokens() }), /subject/);
});

test('trackEvent is monotonic: two opens count once, a click without an open counts both', () => {
  const db0 = seed();
  const { db, m } = mailing(db0, { list_id: search(db0, 'mailing.list')[0].id });
  let s = queueMailing(db, m, { now: NOW, token: tokens() });
  s = trackEvent(trackEvent(s, 'tok-1', 'open', { now: NOW }), 'tok-1', 'open', { now: '2026-10-26' });
  s = trackEvent(s, 'tok-2', 'click', { now: NOW, url: 'https://shop.example/a' });
  s = trackEvent(s, 'tok-2', 'click', { now: NOW, url: 'https://shop.example/b' });
  s = trackEvent(s, 'tok-2', 'open', { now: NOW });
  s = trackEvent(s, 'nope', 'click', { now: NOW });
  const [t1, t2] = traces(s, m.id);
  assert.deepEqual([t1.state, t1.open_date], ['opened', NOW]);
  assert.deepEqual([t2.state, t2.open_date, t2.click_date, t2.links_clicked], ['clicked', NOW, NOW, ['https://shop.example/a', 'https://shop.example/b']]);
  const r = read(s, 'mailing.mailing', m.id);
  assert.deepEqual([r.opened, r.clicked, r.replied, r.opened_ratio, r.clicked_ratio], [2, 1, 0, 100, 50]);
  s = trackEvent(s, 'tok-1', 'reply', { now: NOW });
  assert.deepEqual([read(s, 'mailing.mailing', m.id).replied, traces(s, m.id)[0].state], [1, 'replied']);
});

test('a bounce moves one delivery to bounced and blocks later tracking', () => {
  const db0 = seed();
  const { db, m } = mailing(db0, { list_id: search(db0, 'mailing.list')[0].id });
  let s = markBounced(queueMailing(db, m, { now: NOW, token: tokens() }), 'tok-1');
  s = markBounced(s, 'tok-1');
  s = trackEvent(s, 'tok-1', 'open', { now: NOW });
  const r = read(s, 'mailing.mailing', m.id);
  assert.deepEqual([r.sent, r.delivered, r.bounced, r.opened, r.bounced_ratio, r.received_ratio], [2, 1, 1, 0, 50, 50]);
  assert.equal(traces(s, m.id)[0].state, 'bounced');
});

test('unsubscribe opts a list contact out and blacklists a partner once', () => {
  const db0 = seed();
  const { db, m } = mailing(db0, { list_id: search(db0, 'mailing.list')[0].id });
  const s = unsubscribe(queueMailing(db, m, { now: NOW, token: tokens() }), 'tok-1');
  const rania = search(s, 'mailing.contact').find((c) => c.email === 'rania@mail.example');
  assert.equal(rania.opt_out, true);
  assert.equal(search(s, 'mail.blacklist').length, 0);

  const { db: pdb, m: pm } = mailing(db0, { mailing_model: 'res.partner', partner_tag: 'VIP' });
  const ps = queueMailing(pdb, pm, { now: NOW, token: tokens() });
  const once = unsubscribe(unsubscribe(ps, 'tok-1'), 'tok-1');
  const bl = search(once, 'mail.blacklist');
  assert.deepEqual(bl.map((b) => [b.email, b.reason, b.active]), [['sales@nilefurniture.example', 'Unsubscribed from mailing', true]]);
  assert.equal(recipientsOf(once, pm).length, 0);
});

test('A/B: 30% versions get disjoint deterministic samples; the click winner reaches only the rest', () => {
  const { db: d1, id: list } = create(seed(), 'mailing.list', { name: 'AB' });
  let db = Array.from({ length: 10 }, (_, i) => i).reduce((acc, i) => create(acc, 'mailing.contact', { name: `C${i}`, email: `c${9 - i}@ab.example`, list_id: list }).db, d1);
  const ab = { list_id: list, ab_testing_enabled: true, ab_testing_pc: 30, ab_testing_winner_selection: 'clicked', ab_testing_schedule_date: '2026-10-27', campaign_key: 'spring' };
  const { db: withA, m: a } = mailing(db, { ...ab, subject: 'Version A' });
  const { db: withB, m: b } = mailing(withA, { ...ab, subject: 'Version B' });
  assert.deepEqual(emails(abSample(withB, a)), ['c0@ab.example', 'c1@ab.example', 'c2@ab.example']);
  const tok = tokens();
  db = queueMailing(withB, a, { now: NOW, token: tok });
  assert.deepEqual(emails(abSample(db, b)), ['c3@ab.example', 'c4@ab.example', 'c5@ab.example']);
  assert.deepEqual(dueAbWinners(db, '2026-10-30'), []); // version B not sent yet
  db = queueMailing(db, read(db, 'mailing.mailing', b.id), { now: NOW, token: tok });
  assert.ok(traces(db, b.id).every((t) => t.ab_version));
  db = trackEvent(db, traces(db, b.id)[0].token, 'click', { now: NOW });
  assert.equal(selectWinner(db, 'spring').id, b.id);
  assert.equal(selectWinner(write(db, 'mailing.mailing', a.id, { ab_testing_winner_selection: 'manual' }), 'spring'), null);
  assert.deepEqual(dueAbWinners(db, '2026-10-26'), []);
  assert.deepEqual(dueAbWinners(db, '2026-10-27'), ['spring']);

  const done = sendWinner(db, b.id, { now: NOW, token: tok });
  const winner = search(done, 'mailing.mailing').find((m) => m.ab_winner);
  assert.deepEqual([winner.subject, winner.campaign_key, winner.ab_testing_enabled, winner.state, winner.sent], ['Version B', 'spring', false, 'sent', 4]);
  assert.deepEqual(emails(traces(done, winner.id)), ['c9@ab.example', 'c8@ab.example', 'c7@ab.example', 'c6@ab.example']);
  assert.ok(traces(done, winner.id).every((t) => !t.ab_version));
  assert.deepEqual(dueAbWinners(done, '2026-10-30'), []);
  assert.throws(() => sendWinner(done, b.id, { now: NOW, token: tok }), /already been sent/);
});

test('Send Winner Now sends the open record when the selection is manual', () => {
  const { db: d1, id: list } = create(seed(), 'mailing.list', { name: 'AB' });
  const db = ['x@ab.example', 'y@ab.example'].reduce((acc, email) => create(acc, 'mailing.contact', { name: email, email, list_id: list }).db, d1);
  const { db: withA, m: a } = mailing(db, { list_id: list, ab_testing_enabled: true, ab_testing_pc: 50, ab_testing_winner_selection: 'manual', campaign_key: 'k' });
  const sent = queueMailing(withA, a, { now: NOW, token: tokens() });
  const button = mailingModels['mailing.mailing'].form.buttons.find((x) => x.label === 'Send Winner Now');
  const { db: out } = button.run(sent, read(sent, 'mailing.mailing', a.id));
  const winner = search(out, 'mailing.mailing').find((m) => m.ab_winner);
  assert.deepEqual(emails(traces(out, winner.id)), ['y@ab.example']);
});

test('dueMailings returns scheduled mailings up to the given date', () => {
  const db0 = seed();
  const { db, m: early } = mailing(db0, { state: 'scheduled', schedule_date: '2026-10-25' });
  const { db: db2 } = mailing(db, { state: 'scheduled', schedule_date: '2026-11-01' });
  const { db: db3 } = mailing(db2, { state: 'draft', schedule_date: '2026-10-01' });
  assert.deepEqual(dueMailings(db3, '2026-10-25').map((m) => m.id), [early.id]);
  assert.equal(dueMailings(db3, '2026-11-01').length, 2);
});
