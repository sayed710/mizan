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
  const year = date.slice(0, 4);
  const month = date.slice(5, 7);

  const moves = (db.records['account.move'] ?? [])
    .filter((move) => move.journal_id === journal.id && move.state === 'posted' && predicate(move));

  const parsed = [];
  for (const move of moves) {
    const match = regex.exec(move.name ?? '');
    if (!match?.groups || match.groups.seq == null || !/^\d*$/.test(match.groups.seq)) continue;
    const groups = match.groups;
    const matchesPeriod = (!groups.year || groups.year === year.slice(-groups.year.length))
      && (!groups.month || groups.month === month);
    parsed.push({
      move,
      match,
      seq: BigInt(groups.seq || 0),
      matchesPeriod,
    });
  }

  const existingNames = new Set((db.records['account.move'] ?? []).filter((m) => m.journal_id === journal.id).map((m) => m.name));

  const periodMatches = parsed.filter((p) => p.matchesPeriod);
  let templateMatch = null;
  let templateName = null;
  let startSeq;

  if (periodMatches.length > 0) {
    periodMatches.sort((a, b) => (b.seq > a.seq ? 1 : b.seq < a.seq ? -1 : 0) || b.move.id - a.move.id);
    const top = periodMatches[0];
    templateMatch = top.match;
    templateName = top.move.name;
    startSeq = top.seq + 1n;
  } else if (parsed.length > 0) {
    parsed.sort((a, b) => b.move.id - a.move.id);
    const latest = parsed[0];
    templateMatch = latest.match;
    templateName = latest.move.name;
    startSeq = 1n;
  } else {
    const match = regex.exec(fallback);
    if (!match?.groups || match.groups.seq == null) throw new Error('The journal entry sequence does not match the journal sequence regex');
    if (!/^\d*$/.test(match.groups.seq)) throw new Error('The sequence group must contain digits');
    templateMatch = match;
    templateName = fallback;
    startSeq = BigInt(match.groups.seq || 0);
    if (!existingNames.has(fallback)) return fallback;
    startSeq += 1n;
  }

  const groups = templateMatch.groups;
  const generate = (seqVal) => {
    const substitutions = [
      ['seq', String(seqVal).padStart(groups.seq.length, '0')],
      ...(groups.year ? [['year', year.slice(-groups.year.length)]] : []),
      ...(groups.month ? [['month', month]] : []),
    ];
    let result = templateName;
    for (const [name, replacement] of substitutions.sort((a, b) => templateMatch.indices.groups[b[0]][0] - templateMatch.indices.groups[a[0]][0])) {
      const [start, end] = templateMatch.indices.groups[name];
      result = result.slice(0, start) + replacement + result.slice(end);
    }
    return result;
  };

  let seq = startSeq;
  let result = generate(seq);
  while (existingNames.has(result)) {
    seq += 1n;
    result = generate(seq);
  }
  return result;
}
