// Usage: node scripts/seed-demo.ts --target local|staging
// Wipes the target database's app tables, fills a fictional household, and prints a login cookie.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { buildSeedSql, resolveTarget, signSessionCookie } from './seed-demo/build.ts';

const arg = process.argv.indexOf('--target');
const target = resolveTarget(arg === -1 ? '' : process.argv[arg + 1] ?? '');

if (!existsSync(target.secretsFile)) {
  console.error(`${target.secretsFile} not found: it must hold this target's BETTER_AUTH_SECRET.`);
  process.exit(1);
}
const secret = parseEnv(readFileSync(target.secretsFile, 'utf8')).BETTER_AUTH_SECRET ?? '';
if (!secret) {
  console.error(`BETTER_AUTH_SECRET is missing or empty in ${target.secretsFile}.`);
  process.exit(1);
}

const token = randomBytes(32).toString('base64url');
// --command, not --file: remote --file uses D1's import API, which rejects a Wrangler OAuth login.
const sql = buildSeedSql({ now: Date.now(), sessionToken: token });
execFileSync('npx', ['wrangler', 'd1', 'execute', target.database, ...target.wranglerFlags, '--command', sql, '--yes'], { stdio: 'inherit' });

const { name, value } = await signSessionCookie(token, secret);
console.log(`\nSeeded ${target.name}. Sign in at ${target.baseURL} by pasting this into the browser console:\n`);
console.log(`document.cookie="${name}=${value}; path=/; secure"`);
