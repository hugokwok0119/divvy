# Divvy

[![ci](https://github.com/hugokwok0119/divvy/actions/workflows/ci.yml/badge.svg)](https://github.com/hugokwok0119/divvy/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/hugokwok0119/divvy)](https://github.com/hugokwok0119/divvy/releases)

Divvy is a household expense-splitting app. Members import credit-card statements or CSV
exports, review each expense together, and settle up at the end of a monthly cycle. An AI model
reads PDF statements, and every result is checked against the statement's own printed total
before anything is imported.

Live app: <https://divvy.hugohhkwok.workers.dev>. Use **Try the demo** on the login page to try a
fictional household in your browser. The demo sends nothing to the server.

## Stack

- Cloudflare Workers, serving a Hono API and the static front end
- Cloudflare D1 (SQLite) with Drizzle ORM and drizzle-kit migrations
- Better Auth with Google sign-in
- Gemini for statement and receipt extraction, called only from the Worker
- React 19, Tailwind v4 and Vite
- Vitest, including Worker tests against an in-memory D1
- A Python evaluation harness for the statement prompt (`scripts/statement-eval/`)

The design, data model and security boundary are in [docs/DESIGN.md](docs/DESIGN.md).

## How this was built

Divvy is built by one developer working with an AI coding agent, following a fixed workflow:

1. The agent and the developer agree on a design, and the agent writes it up as a spec.
2. The agent turns the spec into a step-by-step implementation plan.
3. The agent implements the plan test-first: each test is written and seen to fail before the
   code that makes it pass.
4. Every change arrives as a pull request. CI runs a secrets scan, the type check, the full test
   suite and the build, and the pull request cannot merge until they pass.
5. The developer reviews and merges every pull request, tests on staging, and approves each
   production deploy.

Commits written with the agent carry a `Co-Authored-By` trailer, so the history shows which
work was agent-assisted. The branch and release flow is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Run locally

Requirements: Node 24 and npm.

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npx wrangler dev
```

In a second terminal:

```bash
npm run dev
```

Vite serves the app on <http://localhost:3000> and forwards `/api` to the Worker on port 8787.

### Sign in locally without Google

Seed the local database with a fictional household and print a login cookie:

```bash
npm run seed:local
```

Open <http://localhost:8787> (or <http://localhost:3000> with `npm run dev`), open the browser
console, paste the printed `document.cookie=...` line and reload. `seed:local` wipes the app
tables in your local database before filling them. `npm run seed:staging` does the same for the
staging database and reads its secret from `.dev.vars.staging`. There is no production option.

## Tests

```bash
npm test
npm run build
python3 -m unittest discover -s scripts/statement-eval -p 'test_*.py'
```
