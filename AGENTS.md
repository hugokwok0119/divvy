# Divvy UI preferences

Prefer floating white cards over expanding expense rows for secondary details, editing, and confirmation flows. Expense history, Move to Pending, custom allocation, and Split Transaction should use this pattern.

Follow the existing native modal dialog styling: rounded white card, soft shadow, dimmed and blurred backdrop, clear heading, and separate footer actions. Support a close button, Escape, and clicking outside. Restore focus to the opener. Dismiss unfinished form input without saving it; prevent dismissal while an explicit save is running.

Keep primary expense fields compact in the row. Keep the orange edited indicator close beneath the item with a small readable gap, left-aligned with the date column.

For split controls, selected member backgrounds match the exact member color; selected equal is dark gray and custom is purple. Icons, letters, and underlines turn white. Hover must preserve selected colors.

Use four shared typography roles: Heading 1 (24px, semibold), Heading 2 (18px, semibold), Body 1 (14px), and Body 2 (12px). Body text uses normal weight, with semibold emphasis. Duplicate warnings and review notes use Body 1; secondary metadata uses Body 2. Preserve 16px touch-input sizing where needed for mobile usability. Reuse central role settings instead of adding one-off sizes.

When one or more expenses are selected, bulk editing uses a floating toolbar fixed near the viewport bottom and aligned to the ledger width. Preserve access to the last rows and allow the toolbar itself to scroll if its controls exceed the available height.

Typography settings live in `src/index.css`. Prefer `text-heading1`, `text-heading2`, `text-body1`, and `text-body2` for new UI. Existing size utilities are aliases to those roles for compatibility.

# Workflow for agents

These rules apply to every agent working in this repository. `CONTRIBUTING.md` has the full detail.

- Work on a `feat/*`, `fix/*` or `chore/*` branch cut from `dev`, and open a pull request into `dev`, the default branch. Never push to `dev` or `main` directly; rulesets reject it.
- Pull request titles are Conventional Commits. Each pull request carries one label (`feature`, `fix` or `chore`) and follows `.github/pull_request_template.md`.
- Issue tracking: every change starts with an issue and ends with the pull request that closes it.
  - Open an issue before starting any work. Do not cut a branch or write code without one.
  - Each pull request matches exactly one issue. Extra work gets its own issue and pull request.
  - A pull request into `dev` puts `Closes #N` in its body.
  - A hotfix pull request into `main` cannot close by keyword, so link the issue in the pull request's Development sidebar before merging.
  - The release pull request from `dev` into `main` is the only one without its own issue. It lists the issues it ships without closing keywords.
  - Never close an issue by hand unless the issue already lists its fixing pull request as linked. A comment or a cross-reference is not a link.
- Run focused tests for the files you change. CI runs the full suite. Never merge on red CI, and never use `git commit --no-verify`.
- Migrations only add tables, columns or indexes. Dropping or renaming takes two releases.
- Staging deploys automatically from `dev`. Production deploys only from a `vX.Y.Z` tag on `main`, after the owner approves in the `production` environment. Never deploy production by hand with `wrangler deploy`.
- Never print, commit or paste secrets. `.dev.vars*` files are gitignored and stay local.
