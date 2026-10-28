# Contributing

Mizan handles financial and personal data. Every change needs to be traceable to a reviewed pull request (GOV-002).

## Workflow
1. **One branch per task.** Create it from `main` and name it after the task, for example `fix/acc-009-accounting-config` or `feat/pos-tables`. Several agents or people can then work in parallel without touching each other's branch.
2. **Never push to `main` directly, and never force-push a shared branch.** `main` changes only by merging a pull request.
3. **One concern per pull request.** Keep each PR small enough to review in one sitting. Name the audit finding or issue it addresses in the title.
4. **Run the checks before you ask for review:**
   ```bash
   npm test                          # all tests
   MIZAN_STRICT_FIELDS=1 npm test    # fails on undeclared fields
   npm run build
   npm run lint && npm run typecheck # once #96 is merged
   npm run coverage                  # once #101 is merged; must not drop below the minimums
   ```
5. **Review before merge.** Every PR needs green CI and at least one review, by a person or by a different agent than the author. The reviewer checks the tests, not just the diff.

## Commits
- Write messages in the form `type(scope): summary`, with the type one of `feat`, `fix`, `test`, `docs`, `refactor` or `chore`. Say *why* in the body.
- Agents must identify themselves with a trailer instead of in the subject. Name the agent and the tool or model, for example:
  ```
  Co-authored-by: Codex <noreply@openai.com>
  ```
- Use a noreply email address for your commit identity, and sign your commits (`git config commit.gpgsign true`).
- Add or change a test with every `feat` and `fix`. Name test files after the behaviour they cover, not after the review round.

## Code
- Add a new app as its own module under `src/models/`, registered once in the module list in `src/models/index.js`. Don't add one-line spreads to a shared hotspot line. An extension must keep the fields, buttons and hooks of the model it overrides; `compose.test.js` checks this once #92 is merged.
- Round money with `src/money.js` (#95), not a local helper.
- Add every new environment variable to `server/config.js` and `docs/CONFIGURATION.md` (#97).
- Never commit secrets. Configuration comes from environment variables.
