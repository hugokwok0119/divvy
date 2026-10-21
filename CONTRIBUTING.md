# Contributing to Divvy

This file describes how changes move from a branch to production, and how to roll back.

## Branches

| Branch | Purpose |
|---|---|
| `main` | Released code only. Every release is a `vX.Y.Z` tag on `main`. |
| `dev` | Integration branch. Every push to `dev` deploys the staging Worker. |
| `feat/*`, `fix/*`, `chore/*` | Short-lived work branches, cut from `dev`, merged back by pull request. |
| `hotfix/*` | Urgent production fixes, cut from `main`, merged into `main`, then `main` is merged into `dev`. |

Both `main` and `dev` are protected: changes arrive only by pull request, the `secrets` and
`verify` checks must pass, and force pushes and deletion are blocked. Release tags cannot be
moved or deleted.

## Pull requests

- The title is a Conventional Commit, for example `feat: add card reminders` or
  `fix: keep the draft when approval fails`. Pull requests into `dev` are squash-merged, so the
  title becomes the commit message on `dev`.
- The release pull request from `dev` into `main` uses a merge commit, so the two branches keep
  a shared history.
- Each pull request carries one label: `feature`, `fix` or `chore`. The label decides where the
  change appears in the release notes.
- Each pull request closes exactly one issue. See [Issue tracking](#issue-tracking).
- The owner reviews and merges every pull request.

## Issue tracking

Every change starts with an issue and ends with the pull request that closes it.

1. **Open the issue first.** Before you write code or docs, open an issue that describes the
   problem or the change. Do not start work, or cut a branch, without one.
2. **One issue, one pull request.** Each pull request matches exactly one issue. If the work
   grows, open a new issue for the extra part and give it its own pull request.
3. **The pull request closes its issue.** GitHub reads `Closes #N` only on pull requests into
   the default branch, which is `dev`, so:
   - a pull request into `dev` puts `Closes #N` in its body;
   - a hotfix pull request into `main` cannot close by keyword: link the issue from the pull
     request's **Development** sidebar before merging.
4. **Never close an issue by hand**, unless the issue already lists its fixing pull request as
   linked. A comment or a cross-reference is not a link.

The release pull request from `dev` into `main` is the only pull request without an issue of
its own. It lists the issues it ships, without closing keywords.

## Tests

Run the tests for the files you change while you work. CI runs the full suite, the type check,
the build and a secrets scan on every pull request:

```bash
npx vitest run tests/money.test.ts
```

The worker tests use an in-memory D1 database. No test touches a real Cloudflare database.

## Database migrations

Generate migrations with `npm run db:generate` and commit them in `migrations/`.

A migration may only add tables, columns or indexes. It may not drop or rename anything in the
same release as the code that stops using it. Removing something takes two releases: first
stop using it, then drop it. This rule means an older Worker version still works against the
newer database, so a code rollback never needs a data rollback.

Deploys apply pending migrations first. If a migration fails, the deploy does not run.

## Releasing

1. Open a pull request named `release: vX.Y.Z` from `dev` into `main`. Use a patch version for
   fixes only, a minor version for new features, and a major version for breaking changes.
2. When CI passes, merge it with a merge commit.
3. Tag the merge commit and push the tag:

   ```bash
   git fetch origin
   git tag -a vX.Y.Z origin/main -m vX.Y.Z
   git push origin vX.Y.Z
   ```

4. The deploy workflow checks that the tag is on `main`, then waits for approval on the
   `production` environment in the Actions tab.
5. After approval it records a D1 Time Travel bookmark, applies migrations, deploys, checks that
   the site answers, and publishes a GitHub Release. The release notes end with a fallback
   block: the new Worker version ID, the bookmark, and the previous release tag.

## Rolling back

Code and data roll back separately. Try code first.

**Code.** Put the previous Worker version back. This takes seconds and does not touch data. Use
the version ID from the previous release's fallback block:

```bash
npx wrangler rollback <version-id>
```

**Data.** Restore the production database to the bookmark recorded before the bad release's
migration. Every write made after the bookmark is lost, and the Free plan keeps Time Travel
history for 7 days. Use this only when data or schema is damaged:

```bash
npx wrangler d1 time-travel restore divvy --bookmark=<bookmark>
```
