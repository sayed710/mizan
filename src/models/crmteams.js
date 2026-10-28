// Sales teams with lead assignment rules, and predictive lead scoring learned from won and lost leads.
import { search, write, writeMany } from '../orm.js';
import { addDays, today } from './common.js';

/** Minimum closed leads before scores are trusted; below it the stage probability is kept. */
export const MIN_CLOSED_LEADS = 5;
const FEATURES = ['country', 'medium', 'source', 'stage_id'];

const isWon = (l) => l.stage_id === 'won' || l.stage_id === 4 || l.probability === 100;
const isLost = (l) => l.active === false && !isWon(l);
const featuresOf = (l) => [
  ...FEATURES.filter((f) => l[f]).map((f) => `${f}=${String(l[f]).toLowerCase()}`),
  ...(l.tag_ids ?? []).map((t) => `tag=${String(t).toLowerCase()}`),
];

/**
 * Scorer for open leads: naive Bayes over country, medium, source, stage and tags, with Laplace smoothing,
 * learned once from closed leads. Null when there is not enough history.
 */
function scorer(db) {
  const all = db.records['crm.lead'] ?? [];
  const won = all.filter(isWon);
  const lost = all.filter(isLost);
  if (won.length + lost.length < MIN_CLOSED_LEADS || !won.length || !lost.length) return null;
  const tally = (list) => list.reduce((m, l) => { for (const f of new Set(featuresOf(l))) m.set(f, (m.get(f) ?? 0) + 1); return m; }, new Map());
  const wonCounts = tally(won);
  const lostCounts = tally(lost);
  return (lead) => {
    // Work in log-odds so many features do not underflow.
    const logOdds = featuresOf({ ...lead, stage_id: isWon(lead) ? null : lead.stage_id }).reduce(
      (s, f) => s + Math.log(((wonCounts.get(f) ?? 0) + 1) / (won.length + 2)) - Math.log(((lostCounts.get(f) ?? 0) + 1) / (lost.length + 2)),
      Math.log(won.length / lost.length),
    );
    return Math.round((100 / (1 + Math.exp(-logOdds))) * 100) / 100;
  };
}

/** Probability (%) that an open lead is won, or null when there is not enough history. */
export function predictiveProbability(db, lead) {
  return scorer(db)?.(lead) ?? null;
}

/** Refresh the automated probability of every open lead (kept in step by the scheduler), in one batch. */
export function refreshProbabilities(db) {
  const score = scorer(db);
  if (!score) return db;
  const updates = new Map();
  for (const l of search(db, 'crm.lead').filter((x) => !isWon(x))) {
    const p = score(l);
    if (p !== l.automated_probability) updates.set(l.id, { automated_probability: p });
  }
  return writeMany(db, 'crm.lead', updates);
}

const matchesTeam = (team, lead) => (!team.country || String(lead.country ?? '').toLowerCase() === team.country.toLowerCase())
  && (!team.tag || (lead.tag_ids ?? []).includes(team.tag));

/**
 * Assign unassigned open leads matching the team's rules to its members, least loaded first, never above a member's
 * capacity (leads assigned in the last 30 days).
 */
export function assignLeads(db, team, at = today()) {
  const since = addDays(at, -30);
  const members = (team.member_ids ?? []).filter((m) => m.name);
  if (!members.length) return db;
  const leads = search(db, 'crm.lead').filter((l) => !l.assign_date && !l.user && !isWon(l) && (!l.team_id || l.team_id === team.id) && matchesTeam(team, l));
  const load = new Map(members.map((m) => [m.name, search(db, 'crm.lead').filter((l) => l.user === m.name && (l.assign_date ?? '') >= since).length]));
  return leads.reduce((acc, lead) => {
    const free = members.filter((m) => !(Number(m.capacity) > 0) || load.get(m.name) < Number(m.capacity))
      .sort((a, b) => load.get(a.name) - load.get(b.name) || a.name.localeCompare(b.name));
    if (!free.length) return acc;
    load.set(free[0].name, load.get(free[0].name) + 1);
    return write(acc, 'crm.lead', lead.id, { team_id: team.id, user: free[0].name, assign_date: at });
  }, db);
}

/** Every team with auto-assignment on, in sequence (the scheduler runs this). */
export const assignAllTeams = (db, at = today()) => search(db, 'crm.team').filter((t) => t.auto_assign && t.active !== false)
  .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0)).reduce((acc, t) => assignLeads(acc, t, at), db);

export const crmTeamModels = {
  'crm.team': {
    label: 'Sales Teams',
    fields: {
      name: { type: 'char', label: 'Sales Team', required: true },
      sequence: { type: 'integer', label: 'Sequence' },
      leader: { type: 'char', label: 'Team Leader' },
      alias_email: { type: 'char', label: 'Email Alias' },
      auto_assign: { type: 'boolean', label: 'Auto Assignment' },
      country: { type: 'char', label: 'Country Rule' },
      tag: { type: 'char', label: 'Tag Rule' },
      member_ids: {
        type: 'one2many', label: 'Members',
        fields: { name: { type: 'char', label: 'Salesperson' }, capacity: { type: 'integer', label: 'Leads per 30 days (0 = unlimited)' } },
        newLine: () => ({ name: '', capacity: 30 }),
      },
      active: { type: 'boolean', label: 'Active' },
    },
    defaults: () => ({ sequence: 10, auto_assign: true, member_ids: [], active: true }),
    kanban: { title: 'name', lines: ['leader', 'country', 'tag'], counter: { label: 'Opportunities', model: 'crm.lead', field: 'team_id' } },
    list: ['sequence', 'name', 'leader', 'auto_assign'],
    form: {
      title: 'name',
      buttons: [{ label: 'Assign Leads', primary: true, run: (db, r) => ({ db: assignLeads(db, r) }) }],
      groups: [['leader', 'alias_email', 'sequence'], ['auto_assign', 'country', 'tag', 'active']],
      tabs: [{ label: 'Members', fields: ['member_ids'] }],
      smart: [{ label: 'Pipeline', model: 'crm.lead', field: 'team_id', target: 'crm/pipeline' }],
    },
  },
};
