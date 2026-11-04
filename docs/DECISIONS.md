# Project decisions

Decisions taken on 2026-10-27 for the open items of the technical audit of 2026-10-26.
The owner delegated these choices. Each one can be revisited; the reason is recorded so that it can be.

## D1. Licence (LIC-001): all rights reserved, for now

The repository had no licence. It now has a proprietary `LICENSE` ("all rights reserved"), and `package.json` says `UNLICENSED`.

Why:
- It keeps every option open. A later move to MIT, Apache-2.0 or AGPL-3.0 is one commit. An open licence, once granted, cannot be taken back for the copies already released.
- LIC-002 (Odoo naming and behaviour) still needs legal review. Granting open-source rights before that review would widen any exposure.

Revisit after the legal review. If Mizan is to be open source, choose between Apache-2.0 (permissive, with a patent grant) and AGPL-3.0 (copyleft, also covers hosted use).

## D2. Architecture (ARCH-001, ARCH-008): keep Mizan, make the server authoritative step by step

The audit asked to choose between (A) re-platforming Mizan itself and (B) building on Odoo Community plus OCA.

Choice: (A).

Why:
- About 70 fix PRs already move Mizan towards (A): server-side guards and validation, server-assigned ids and numbers, an audit log, per-user companies, migrations and backups.
- (B) would discard the codebase and the work on it. Its licence (LGPL-3 core, AGPL for many OCA modules) would also shape how Mizan can be distributed, which D1 has not decided.

Order of work:
1. Merge the open P0 and P1 PRs, which close the worst data-integrity and permission gaps.
2. Move each workflow action (post, confirm, validate, pay) into a server command that runs the existing model function with the user's rights. The browser then sends commands instead of whole-record diffs. Start with accounting, stock and payroll (SEC-001, ACC-017, MOD-008).
3. Add ACLs and record rules on the server, and drop the client-side diff for workflow models.
4. Move storage from SQLite to PostgreSQL once commands are in place. Postgres gives real transactions and sequences, and multi-process writes (DB-009).

## D3. Repository visibility and branch protection (GOV-001, GOV-002, GOV-003)

- Make the repository private until the P0 and P1 fixes are merged. No secrets were found (GOV-003), but the code shows the open gaps and raises the LIC-002 question.
- Protect `main`:
  - require a pull request (0 approvals, so the owner can still merge alone);
  - block force pushes and deletion;
  - once the CI workflow (PR #11) is merged, also require its check to pass.

These are GitHub settings. The owner applies them under Settings, General and Settings, Branches: the automation proxy used for the fixes may not change repository settings.

## D4. E-invoicing (ACC-019): Egypt (ETA) first

The company data and users are Egyptian, so the Egyptian Tax Authority e-invoice comes first. The UAE and ZATCA phase 2 follow.

ETA submission needs:
- the taxpayer's API credentials;
- a signing certificate (a USB token or an HSM).

The document format, validation and submission client can be built first. Live submission waits for those credentials.
