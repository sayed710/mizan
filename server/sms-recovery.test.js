import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../src/seed.js';
import { create, read, search } from '../src/orm.js';
import { sendSmsCampaign } from './integrations.js';
import { queueSms } from '../src/models/sms.js';

test('interrupted SMS delivery quarantines uncertain attempts and resumes only unattempted recipients', async () => {
  const list = create(seed(), 'mailing.list', { name: 'Recovery list' });
  const a = create(list.db, 'mailing.contact', { name: 'A', email: 'a@recovery.test', list_id: list.id, phone: '+201001112233' });
  const b = create(a.db, 'mailing.contact', { name: 'B', email: 'b@recovery.test', list_id: list.id, phone: '+201001112234' });
  const campaign = create(b.db, 'sms.campaign', { name: 'Recovery', body: 'Sale', list_id: list.id });
  let db = campaign.db, crash = true, sends = 0;
  const store = {
    get: () => db,
    commit(next) {
      if (crash && search(next, 'sms.trace').some((t) => t.campaign_id === campaign.id && ['sent', 'error'].includes(t.state))) throw new Error('Simulated process loss');
      db = next;
    },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async () => { sends++; return new Response('{}', { status: 200 }); };
  try {
    await assert.rejects(sendSmsCampaign({}, store, { id: campaign.id }), /process loss/);
    assert.equal(sends, 1);
    crash = false;
    await sendSmsCampaign({}, store, { id: campaign.id });
    assert.equal(sends, 2, 'only the previously unattempted recipient is submitted');
    const traces = search(db, 'sms.trace').filter((t) => t.campaign_id === campaign.id);
    assert.deepEqual(traces.map((t) => t.state), ['uncertain', 'sent']);
    assert.equal(read(db, 'sms.campaign', campaign.id).delivered, 1);
    await sendSmsCampaign({}, store, { id: campaign.id });
    assert.equal(sends, 2, 'uncertain delivery is never automatically repeated');
    const legacy = queueSms(campaign.db, read(campaign.db, 'sms.campaign', campaign.id));
    db = { ...legacy, records: { ...legacy.records, 'sms.trace': legacy.records['sms.trace'].map(({ delivery_pending, attempted_at, ...trace }) => trace) } };
    await sendSmsCampaign({}, store, { id: campaign.id });
    assert.equal(sends, 2, 'legacy outgoing traces have unknown delivery status, not evidence of non-delivery');
    assert.ok(search(db, 'sms.trace').filter((t) => t.campaign_id === campaign.id).every((t) => t.state === 'uncertain'));
  } finally { globalThis.fetch = original; }
});
