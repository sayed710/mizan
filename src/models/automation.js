// Marketing Automation: an activity tree run per participant, with delays and email-event triggers, processed by the scheduler.
import { create, read, search, write } from '../orm.js';
import { addDays, today } from './common.js';

export const TRIGGERS = [
  ['begin', 'Beginning of campaign'], ['act', 'After previous activity'], ['mail_open', 'Mail opened'], ['mail_not_open', 'Mail not opened'],
  ['mail_click', 'Mail clicked'], ['mail_not_click', 'Mail not clicked'], ['mail_reply', 'Mail replied'],
];
const EVENT_TRIGGER = { open: 'mail_open', click: 'mail_click', reply: 'mail_reply' };
const NEGATIVE = { mail_not_open: 'open', mail_not_click: 'click' };
// Older campaigns have no parent/trigger: each step follows the previous one.
const parentOf = (steps, i) => (steps[i].parent != null && steps[i].parent !== '' ? Number(steps[i].parent) - 1 : i - 1);
const triggerOf = (steps, i) => steps[i].trigger || (i === 0 ? 'begin' : 'act');
const childrenOf = (steps, i) => steps.map((_, k) => k).filter((k) => k !== i && parentOf(steps, k) === i && triggerOf(steps, k) !== 'begin');
const delay = (s) => Math.round(Number(s.delay_days) || 0);

/** Contacts the campaign targets: subscribed contacts of its list. */
const targets = (db, campaign) => search(db, 'mailing.contact').filter((c) => c.list_id === campaign.list_id && !c.opt_out && c.email);

/** Add contacts not yet in the campaign as participants, with their beginning activities scheduled. */
export function syncParticipants(db, campaign, at = today()) {
  const steps = campaign.steps ?? [];
  const known = new Set(search(db, 'marketing.participant').filter((p) => p.campaign_id === campaign.id).map((p) => p.res_id));
  const fresh = targets(db, campaign).filter((c) => !known.has(c.id));
  const next = fresh.reduce((acc, c) => create(acc, 'marketing.participant', {
    campaign_id: campaign.id, res_model: 'mailing.contact', res_id: c.id, name: c.name, email: c.email, state: 'running',
    traces: steps.map((s, i) => (triggerOf(steps, i) === 'begin' ? { step: i, state: 'scheduled', scheduled_date: addDays(at, delay(s)) } : null)).filter(Boolean),
  }).db, db);
  const count = search(next, 'marketing.participant').filter((p) => p.campaign_id === campaign.id).length;
  return write(next, 'marketing.campaign', campaign.id, { participants: count });
}

/** Launch: validates the workflow, then enrols the target. */
export function startCampaign(db, campaign, at = today()) {
  const steps = campaign.steps ?? [];
  if (!steps.length) throw new Error('Add at least one workflow step');
  if (!steps.some((_, i) => triggerOf(steps, i) === 'begin')) throw new Error('One activity must start at the beginning of the campaign');
  steps.forEach((_, i) => {
    const p = parentOf(steps, i);
    if (triggerOf(steps, i) !== 'begin' && !(p >= 0 && p < steps.length && p !== i)) throw new Error(`Activity ${i + 1} needs a parent activity`);
    if (triggerOf(steps, i).startsWith('mail_') && steps[p]?.action !== 'email') throw new Error(`Activity ${i + 1} reacts to an email, so its parent must send one`);
  });
  return syncParticipants(write(db, 'marketing.campaign', campaign.id, { stage_id: 'running' }), { ...campaign, stage_id: 'running' }, at);
}

const setTraces = (db, p, traces) => write(db, 'marketing.participant', p.id, { traces, state: traces.some((t) => t.state === 'scheduled') ? 'running' : 'completed' });

/**
 * Process every scheduled activity due on or before `at` for running campaigns. A processed activity schedules its
 * 'after previous' children and its 'not opened/clicked' children (cancelled later if the event happens);
 * email-event children are scheduled when the event is recorded.
 */
export function processDue(db, at = today()) {
  const running = new Map(search(db, 'marketing.campaign').filter((c) => c.stage_id === 'running').map((c) => [c.id, c]));
  return search(db, 'marketing.participant').filter((p) => running.has(p.campaign_id) && p.state === 'running').reduce((acc, p) => {
    const steps = running.get(p.campaign_id).steps ?? [];
    let traces = p.traces ?? [];
    let changed = false;
    for (let guard = 0; guard < 50; guard += 1) {
      const due = traces.findIndex((t) => t.state === 'scheduled' && t.scheduled_date <= at);
      if (due < 0) break;
      const t = traces[due];
      const negative = NEGATIVE[triggerOf(steps, t.step)];
      const parentTrace = traces.find((x) => x.step === parentOf(steps, t.step));
      const rejected = negative && parentTrace?.events?.includes(negative);
      const done = { ...t, state: rejected ? 'rejected' : 'processed', processed_date: at };
      const kids = rejected || !steps[t.step] ? [] : childrenOf(steps, t.step)
        .filter((k) => ['act', 'mail_not_open', 'mail_not_click'].includes(triggerOf(steps, k)))
        .map((k) => ({ step: k, state: 'scheduled', scheduled_date: addDays(t.scheduled_date, delay(steps[k])) }));
      traces = [...traces.slice(0, due), done, ...traces.slice(due + 1), ...kids];
      changed = true;
    }
    return changed ? setTraces(acc, p, traces) : acc;
  }, db);
}

/** An email event (open/click/reply) on a participant's processed activity: schedules the reacting children. */
export function recordEvent(db, participantId, step, event, at = today()) {
  const p = read(db, 'marketing.participant', participantId);
  const campaign = p && read(db, 'marketing.campaign', p.campaign_id);
  if (!p || !campaign || !EVENT_TRIGGER[event]) return db;
  const steps = campaign.steps ?? [];
  const trace = (p.traces ?? []).find((t) => t.step === step && t.state === 'processed');
  if (!trace || (trace.events ?? []).includes(event)) return db;
  // A click counts as an open too.
  const events = [...new Set([...(trace.events ?? []), event, ...(event === 'click' ? ['open'] : [])])];
  const reacting = childrenOf(steps, step).filter((k) => events.map((e) => EVENT_TRIGGER[e]).includes(triggerOf(steps, k)) && !(p.traces ?? []).some((t) => t.step === k));
  const traces = [
    ...(p.traces ?? []).map((t) => (t === trace ? { ...t, events } : t)),
    ...reacting.map((k) => ({ step: k, state: 'scheduled', scheduled_date: addDays(at, delay(steps[k])) })),
  ];
  return setTraces(db, p, traces);
}

/** Per activity: scheduled, processed and rejected counts across participants. */
export function stepStats(db, campaign) {
  const all = search(db, 'marketing.participant').filter((p) => p.campaign_id === campaign.id).flatMap((p) => p.traces ?? []);
  return (campaign.steps ?? []).map((s, i) => {
    const mine = all.filter((t) => t.step === i);
    const n = (state) => mine.filter((t) => t.state === state).length;
    return { step: i, action: s.action, detail: s.detail, scheduled: n('scheduled'), processed: n('processed'), rejected: n('rejected') };
  });
}

const ACTIONS = [['email', 'Send Email'], ['sms', 'Send SMS'], ['wait', 'Wait'], ['tag', 'Add Tag']];

export const automationModels = {
  'marketing.campaign': {
    label: 'Campaigns',
    fields: {
      name: { type: 'char', label: 'Campaign', required: true },
      list_id: { type: 'many2one', relation: 'mailing.list', label: 'Target' },
      steps: {
        type: 'one2many',
        label: 'Workflow',
        fields: {
          action: { type: 'selection', label: 'Action', options: ACTIONS },
          detail: { type: 'char', label: 'Details' },
          parent: { type: 'integer', label: 'Parent Activity #' },
          trigger: { type: 'selection', label: 'Trigger', options: TRIGGERS },
          delay_days: { type: 'float', label: 'After (days)' },
        },
        newLine: () => ({ action: 'email', detail: '', parent: null, trigger: 'act', delay_days: 0 }),
      },
      participants: { type: 'integer', label: 'Participants', readonly: true },
      stage_id: { type: 'selection', label: 'Status', tracking: true, options: [['draft', 'New'], ['running', 'Running'], ['stopped', 'Stopped']] },
    },
    defaults: () => ({ steps: [], participants: 0, stage_id: 'draft' }),
    groupBys: ['stage_id', 'list_id'],
    kanban: { groupBy: 'stage_id', title: 'name', lines: ['list_id', 'participants'] },
    list: ['name', 'list_id', 'participants', 'stage_id'],
    form: {
      statusbar: 'stage_id',
      buttons: [
        { label: 'Start', primary: true, when: (r) => r.stage_id !== 'running', run: (db, r) => ({ db: startCampaign(db, r) }) },
        { label: 'Sync Participants', when: (r) => r.stage_id === 'running', run: (db, r) => ({ db: syncParticipants(db, r) }) },
        { label: 'Process Now', when: (r) => r.stage_id === 'running', run: (db) => ({ db: processDue(db) }) },
        { label: 'Stop', vals: { stage_id: 'stopped' }, when: (r) => r.stage_id === 'running' },
      ],
      title: 'name',
      groups: [['list_id'], ['participants']],
      tabs: [{ label: 'Workflow', fields: ['steps'] }],
      smart: [{ label: 'Participants', model: 'marketing.participant', field: 'campaign_id', target: 'automation/participants' }],
      chatter: true,
    },
  },

  'marketing.participant': {
    label: 'Participants',
    fields: {
      campaign_id: { type: 'many2one', relation: 'marketing.campaign', label: 'Campaign' },
      name: { type: 'char', label: 'Name' },
      email: { type: 'char', label: 'Email' },
      res_model: { type: 'char', label: 'Document Model', readonly: true },
      res_id: { type: 'integer', label: 'Document ID', readonly: true },
      state: { type: 'selection', label: 'Status', options: [['running', 'Running'], ['completed', 'Completed'], ['unlinked', 'Removed']] },
      traces: {
        type: 'one2many', label: 'Activities', readonly: true,
        fields: {
          step: { type: 'integer', label: 'Activity #' },
          state: { type: 'selection', label: 'Status', options: [['scheduled', 'Scheduled'], ['processed', 'Processed'], ['rejected', 'Rejected'], ['canceled', 'Canceled']] },
          scheduled_date: { type: 'date', label: 'Scheduled for' },
          processed_date: { type: 'date', label: 'Processed on' },
          events: { type: 'tags', label: 'Events' },
        },
        newLine: () => ({ step: 0, state: 'scheduled' }),
      },
    },
    groupBys: ['campaign_id', 'state'],
    kanban: { title: 'name', lines: ['email', 'campaign_id'], badge: 'state' },
    list: ['campaign_id', 'name', 'email', 'state'],
    form: {
      lockedWhen: () => true, title: 'name', groups: [['campaign_id', 'email'], ['state']], tabs: [{ label: 'Activities', fields: ['traces'] }],
      // Campaign emails are not sent with tracking yet (simulated), so opens, clicks and replies are recorded by hand.
      buttons: [{
        label: 'Record Email Event', when: (r) => (r.traces ?? []).some((t) => t.state === 'processed'),
        ask: [{ label: 'Activity number', type: 'number', default: (r) => String((r.traces.find((t) => t.state === 'processed')?.step ?? 0) + 1) }, { label: 'Event (open, click or reply)', default: () => 'open' }],
        run: (db, r, [step, event]) => {
          if (!EVENT_TRIGGER[event]) throw new Error('Enter open, click or reply');
          if (!(r.traces ?? []).some((t) => t.step === step - 1 && t.state === 'processed')) throw new Error('That activity has not been sent to this participant');
          return { db: recordEvent(db, r.id, step - 1, event) };
        },
      }],
    },
  },
};
