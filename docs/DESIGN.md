# Divvy design

This is the living design document for Divvy. It describes how the app works today and why.
A pull request that changes a design decision updates this file and adds an entry to the
Decision log at the end.

## Purpose

Divvy is a household expense-splitting app. Members of one household import or enter shared
expenses, review them together, close a monthly cycle, and settle up. It replaces a
spreadsheet-style prototype with a shared, auditable ledger.

One account can belong to several groups, such as a household and a trip. The header shows the
current group, and its menu switches groups or creates a new one.

The main flow:

1. Choose a group. With one group there is nothing to choose. Then import a credit-card statement
   (PDF, read by Gemini) or a CSV export (parsed in the browser), or enter an expense by hand. The
   import area names the group the rows go into.
2. Imported rows land in **Pending**. A person checks payer, allocation and possible duplicates,
   then approves each row.
3. **Approved** rows count toward the live settlement.
4. Any member closes the cycle for review, and the cycle is ticked off as settled once paid.

## Architecture

| Layer | Choice |
|---|---|
| Hosting | One Cloudflare Worker serving the API and the static front end (assets binding) |
| API | Hono, all routes under `/api`, JSON, `Cache-Control: no-store` |
| Database | Cloudflare D1 (SQLite), schema in `worker/db/schema.ts`, migrations in `migrations/` |
| ORM | Drizzle ORM, migrations generated with drizzle-kit |
| Auth | Better Auth with Google OAuth only, sessions stored in D1 |
| AI | Gemini (`gemini-3.8-flash`), called only from the Worker in `worker/lib/gemini.ts` |
| Front end | React 19, Tailwind v4, built by Vite into `dist/` |
| Tests | Vitest: a `pure` project for logic and a `worker` project that runs the Worker against an in-memory D1 |

The browser never holds the Gemini key and never talks to Gemini. Statement uploads go to
`POST /api/ai/parse-receipt`, which checks the session first, caps uploads at 5 MB, verifies the
file signature, and rate-limits each household to 10 AI requests per day (`DAILY_AI_LIMIT` in
`worker/lib/ratelimit.ts`). Every group shares one free-tier Gemini key, so the same limit also
applies across all groups: a second counter in `ai_usage`, under the key `all` and dated by the
America/Vancouver day, is checked after the household's own counter. For a PDF statement, the
Worker checks the extracted rows against the statement's own printed total and refuses a result
that does not reconcile. CSV files are parsed in the browser and never sent to Gemini.

`scripts/statement-eval/` is an offline Python harness that scores the statement prompt and
schema against a fictional mock corpus with known ground truth.

## Data model

All money is integer cents. Timestamps are epoch milliseconds.

| Table | Holds |
|---|---|
| `households` | One household, shown to people as a group: name, currency (CAD), timezone (America/Vancouver), custom categories, sign-in allowlist, rent-reminder flag |
| `household_members` | Participants, their role (`owner` or `member`), display order, and the linked user once they sign in |
| `member_accounts` | Links an account to a member slot, at most one slot per account in each group, so one account can belong to many groups. Triggers copy `household_members.user_id` into it until that column is dropped |
| `cards` | Payment cards per member, with an optional statement day for reminders |
| `transactions` | Approved expenses: date, store, amount, category, payer, card, split type and exact per-member shares |
| `queue_items` | Pending expenses waiting for review, with duplicate flags and source-file provenance |
| `cycles` | Closed and settled cycles; a settled cycle stores its frozen settlement |
| `expense_history` | Every saved version and event of an expense: import, approval, edit, move to Pending, deletion |
| `category_preferences` | Learned store-to-category suggestions |
| `ai_usage` | Daily AI request counts per household, plus an app-wide count under the key `all` |
| `reminder_completions` | Manual ticks on the payment reminder calendar |
| `user`, `session`, `account`, `verification` | Better Auth tables |

## Money and settlement

The rules live in `src/lib/money.ts` and `src/lib/settlement.ts`. They are pure and fully
unit-tested.

- Splitting is exact. Shares come from integer division, and the remainder is handed out one
  cent at a time by the largest remainder method. Per-member shares always sum to the amount.
- Split types are `equal` (across the roster), `custom` (percentages) and `single` (one member).
- A member's balance is what they paid minus what they consumed, summed from the stored shares.
  Balances across the household sum to zero, and greedy matching of creditors and debtors turns
  them into a short list of transfers.
- Refunds are negative amounts and split by the same rules.

## Expense lifecycle

- Inputs enter Pending. Approval saves edits, validates the expense and records who approved it.
- Approved expenses can be edited directly and stay Approved. History records who saved each
  version and what changed.
- **Move to Pending** sends an Approved expense back for review with an optional note. It keeps
  its values and history, and it stops counting toward totals until someone approves it again.
- Deletion is recorded in history, not destroyed.
- Duplicate warnings are advisory. A person decides whether to keep both rows.

## Cycle lifecycle

| State | Transactions | Settlement |
|---|---|---|
| Active (`cycle_id IS NULL`) | Editable | Computed live |
| `closed` | Editable | Computed live |
| `settled` | Frozen | Frozen snapshot in `settlement_json` |

Closing is a handoff for review, not a freeze. `POST /api/cycles/close` takes the exact list of
expense ids and claims them in one D1 batch. If any id is already claimed, the whole batch is
rejected, so a double click or a race cannot close a cycle twice or partly. Corrections after
settling are new adjustment expenses in the current cycle.

A closed or settled cycle can be shared as an image, so people without app access, such as
temporary trip members, can check their part. **Download summary** in the History detail opens a
dialog that builds one JPG in the browser from data History already loads. Nothing is stored and
the server is not involved. By default the image shows Settle up and each person's Paid, Share and
Net. **Detailed grid view** adds every item, with each person's exact stored share in their own
column. A share that took a leftover cent is marked with an asterisk. Every list of people uses
member order.

## Security boundary

D1 has no row-level security, so tenant isolation lives in one place in application code.
`requireScope(c)` in `worker/lib/scope.ts` resolves the session to one household membership and
returns a `ScopedRepository`. A request names its group in the `x-divvy-group` header or the
`group` query parameter, and `requireScope` checks that the account has a link to that group in
`member_accounts`. When a request names no group, `requireScope` uses the caller's only active
group, and a caller with more than one gets 400 with `reason: 'group_required'`. Route handlers
reach data only through that repository, and every query it issues filters by the caller's
household. Writes also check that any referenced payer, card or cycle belongs to the same
household.

`/api/groups` lists and creates groups, so it runs outside the `requireScope` middleware and reads
the session itself, with its data access in `worker/lib/groups.ts`. It lists only the groups the
caller can open, and only the `OWNER_EMAIL` account can create one.

Sign-in is Google only. The first sign-in by the `OWNER_EMAIL` address creates the household.
Every later sign-in must match an allowlist entry in some household, and any other address is
rejected before an account is created. Session cookies are `HttpOnly`, `Secure` and `SameSite=Lax`.

## Demo mode

The login page has a **Try the demo** button for visitors without an account. Demo mode runs
entirely in the browser with a fictional household:

- `src/demo/` loads lazily when the button is clicked, so signed-in users never download it.
- It replaces `fetch` with a guard. Every `/api` request is answered by an in-browser route
  table and demo store, and an unknown `/api` route is refused. The guard never sends an `/api`
  request to the network, so the demo cannot reach the server, Gemini or D1.
- Visitors can import fictional sample statements and get recorded extraction results, and can
  edit, delete and approve Pending rows. Everything else is read-only, and a banner says that
  nothing is saved.
- `GET /api/groups` lists the demo household as the only group, and creating a group is off, so
  the header shows the household's name and nothing to choose.

## Delivery

Code reaches production only through the pipeline described in `CONTRIBUTING.md`: pull requests
into `dev` with required checks, an automatic staging deploy from `dev`, and approval-gated
releases from version tags on `main`. Database migrations run before each deploy and stop the
deploy if they fail.

## UI conventions

The full list is in `AGENTS.md`. In short:

- Secondary details, editing and confirmations use floating white cards, not expanding rows.
- Dialogs have a rounded white card, a soft shadow, a dimmed and blurred backdrop, a clear
  heading and separate footer actions. They close with a button, Escape or a click outside, and
  return focus to the opener.
- Four typography roles live in `src/index.css`: Heading 1 (24px), Heading 2 (18px), Body 1
  (14px) and Body 2 (12px).
- Split controls use the member's exact color when selected, dark gray for equal and purple for
  custom.
- Member colors come from the 20-color list in `src/lib/memberColors.ts`, assigned by member
  order. Colors repeat from the 21st member.

## Decision log

Each entry gives the date, the decision and the reason.

1. **2026-10-16. Publish a fresh public repository from a cleaned tree.** The earlier history
   held a real household ledger import and predates any CI rules. Rejected: rewriting history
   (risky, and the old commits were unreviewed) and a private repository (branch rules and
   environments need a paid plan on private repositories).
2. **2026-10-16. Clean the private repository on a reviewed branch before export.** Deletions
   made with `git rm` on a branch can be tested and reviewed. An exclude list at export time
   could not.
3. **2026-10-16. Keep one living design document.** This file, plus `README.md`,
   `CONTRIBUTING.md` and `AGENTS.md`. Per-feature specs and plans are working files and stay out
   of the repository.
4. **2026-10-16. Use two GitHub Actions workflows, `ci.yml` and `deploy.yml`.** Cloudflare
   Workers Builds was rejected because it documents no manual approval before production and
   keeps deploy history outside GitHub.
5. **2026-10-16. Release by pushing a `vX.Y.Z` tag on `main`.** The workflow migrates, deploys
   and writes release notes generated from pull requests. Rejected: a release bot (more
   configuration) and a manual button with a free-text version.
6. **2026-10-16. The owner merges every pull request.** Merging into `dev` deploys staging, so
   every deploy stays a human decision.
7. **2026-10-16. Keep a staging environment.** A separate Worker and database rehearse every
   migration and deploy on real Cloudflare before production. Without it, each migration would
   first run on real data.
8. **2026-10-16. Sign into local and staging with a seeded session.** A seed script creates a
   demo user and session and prints a signed cookie. Rejected: Google sign-in on staging (extra
   console setup) and a demo-login route (a backdoor risk in production code).
9. **2026-10-16. Use one Cloudflare API token, held in GitHub environments.** Cloudflare
   documents its D1 and Workers permissions as account-wide, so two tokens would not isolate
   staging from production. The protection is the approval gate on the production environment.
10. **2026-10-16. Build the interviewer demo as an in-browser mode.** It needs no server change
    and cannot cause AI cost or database writes. A separate demo site or a live sandbox was
    rejected.
11. **2026-10-16. Public commits use the GitHub noreply address.** Personal email addresses stay
    out of public commit metadata.
12. **2026-10-21. Share a cycle as a client-side JPG with one column per person.** The summary
    renders as a React component and `html-to-image` turns it into a JPG, loaded only when someone
    downloads. Inter is self-hosted under `public/fonts/` (SIL OFL), so the export fetches it from
    the same origin and inlines it, which the production CSP (`connect-src 'self'`) allows. Loading
    it from Google Fonts was rejected: the library cannot read that cross-origin stylesheet, and
    the CSP blocks fetching it, so deployed images fell back to the system sans-serif. Loosening
    the CSP was also rejected. The JPG is encoded with `canvas.toBlob`,
    because the same CSP blocks fetching a `data:` URL. A one-column-per-person grid lets each person read
    straight down their own column, and each column adds up to their share. Rejected: drawing
    the image by hand on a canvas (much more code), a server-rendered image (a server change for a
    one-off share), and listing shares under each item (hard to find your own name as the group
    grows).
13. **2026-10-21. Use 20 hand-picked member colors.** The first five are unchanged, so existing
    members keep their colors, and the new fifteen avoid the app's own `indigo-600`, `green-700`
    and `slate-600`. Rejected: darker tiers of the first five (each tier looks like its base color
    and stays near the app's blues and reds), and a generated golden-angle palette (unlimited, but
    it clusters into look-alike families once the app's hues are excluded).
14. **2026-10-22. Groups reuse the `households` table.** A group already needs everything a
    household has: members, cards, cycles and a ledger. Rejected: a new `groups` table, which means
    a two-release rename for no gain.
15. **2026-10-22. Account links live in `member_accounts`.** `household_members.user_id` is
    unique, so one account could hold a slot in only one group. Triggers copy that column into
    `member_accounts`, so the code that still writes `user_id` keeps working until a later release
    drops it. The migration is additive: it adds a table, columns, indexes and two triggers.
    Migration 0005 already added triggers. Rejected: rebuilding `household_members` without
    `UNIQUE`, which is not additive.
16. **2026-10-22. Requests name their group in the `x-divvy-group` header.** Rejected: a
    `/api/groups/:id/...` path prefix, which rewrites every route and the demo route table, and a
    cookie, which goes stale across tabs.
17. **2026-10-22. Without a named group, use the caller's only active group.** A caller with more
    than one active group gets 400 `group_required` and must choose. Rejected: falling back to the
    earliest group, which silently writes to the wrong ledger once a person has two groups.
18. **2026-10-22. Cap AI scans across all groups.** The Gemini key is app-wide and on the free
    tier, so a per-group limit does not protect it. The app-wide counter uses the key `all`, the
    America/Vancouver day (the app's default time zone) and `DAILY_AI_LIMIT`. The group's own
    counter is checked first, so a group already past its limit does not use up the shared
    allowance.
19. **2026-10-22. Switch groups from a header menu, and name the group above the import controls.**
    The switcher is a menu button that lists each group with its pending count and offers New
    group to the owner. The app remembers the choice in `divvy.groupId`. With several groups and
    no remembered one, it asks before loading any data, and a `group_required` answer clears the
    choice and asks again. The import area says which group new rows go into, with a Change button
    that opens the same menu, because importing into the wrong ledger is the costly mistake.
    Rejected: a separate groups page (an extra step on every switch) and a default to the first
    group (the silent wrong-ledger write from entry 17).
20. **2026-10-22. The rent reminder is a per-group setting.** Existing households keep it on, because
    the migration adds `rent_reminder` with a default of 1. New groups start with it off, because a
    trip has no rent. The group owner turns it on or off in Settings, under Reminders.
