# Supporting material for the 2026-10-26 technical audit

The main report is `../MIZAN-FULL-TECHNICAL-AUDIT-2026-10-26.md`.

- `sec.md`, `acct.md`, `db.md`, `flows.md`, `modules.md`, `ui.md`, `arch.md`: the detailed reports from each workstream. Every finding has its evidence, reproduction, impact, root cause, recommended correction, dependencies, verification plan and confidence.
- `evidence/`: the reproduction scripts and their captured outputs, as they were run during the audit. Paths inside the reports point here.
  - The scripts were written to run inside a **throwaway copy of the repository at commit 0e9f748**. Some of them change files in that copy; `arch-scripts/mutate.sh`, for example, reorders model spreads to measure test sensitivity.
  - Never run them in a working tree you care about, and never against a database that holds real data.
- `evidence/mod-out/`: module and model statistics, test counts per file, and the raw data behind the module maturity matrix.

Nothing in this folder is imported by the application or picked up by `npm test`, whose globs only match `src/**/*.test.js` and `server/**/*.test.js`.
