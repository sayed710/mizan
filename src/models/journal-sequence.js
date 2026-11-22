// Odoo sequence overrides use Python named groups. JavaScript uses the same
// capture names with a different spelling.
export function journalSequenceRegex(value) {
  const source = String(value).replaceAll('(?P<', '(?<');
  if (!source.includes('(?<seq>')) throw new Error('The sequence regex must contain a seq group');
  try {
    return new RegExp(source, 'd');
  } catch (error) {
    throw new Error('Invalid sequence regex', { cause: error });
  }
}

/** Increment the last matching journal entry, preserving its captured format. */
export function journalSequenceName(db, journal, date, fallback, predicate = () => true) {
  if (!journal.sequence_override_regex) return fallback;
  const regex = journalSequenceRegex(journal.sequence_override_regex);
  const candidates = (db.records['account.move'] ?? [])
    .filter((move) => move.journal_id === journal.id && move.state === 'posted' && predicate(move))
    .sort((a, b) => b.id - a.id);
  const previous = candidates.map((move) => regex.exec(move.name ?? '')).find((match) => match?.groups?.seq != null);
  if (!previous) {
    const match = regex.exec(fallback);
    if (!match?.groups || match.groups.seq == null) throw new Error('The journal entry sequence does not match the journal sequence regex');
    return fallback;
  }
  const groups = previous.groups;
  if (!/^\d*$/.test(groups.seq)) throw new Error('The sequence group must contain digits');
  const year = date.slice(0, 4);
  const month = date.slice(5, 7);
  const reset = (groups.year && groups.year !== year.slice(-groups.year.length)) || (groups.month && groups.month !== month);
  const substitutions = [
    ['seq', String(reset ? 1 : Number(groups.seq || 0) + 1).padStart(groups.seq.length, '0')],
    ...(groups.year ? [['year', year.slice(-groups.year.length)]] : []),
    ...(groups.month ? [['month', month]] : []),
  ];
  let result = previous[0];
  for (const [name, replacement] of substitutions.sort((a, b) => previous.indices.groups[b[0]][0] - previous.indices.groups[a[0]][0])) {
    const [start, end] = previous.indices.groups[name];
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}
