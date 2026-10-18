// Pure builder for the demo seed: no Node built-ins, so the worker test pool can import it.
import { getCookies } from 'better-auth/cookies';
import { serializeSignedCookie } from 'better-call';

export const DEMO = {
  householdId: 'hh_demo',
  userId: 'u_demo',
  email: 'demo@example.com',
  ownerMemberId: 'mem_alex',
  memberId: 'mem_sam',
} as const;

export interface SeedTarget {
  name: 'local' | 'staging';
  database: string;
  wranglerFlags: string[];
  baseURL: string;
  secretsFile: string;
}

const TARGETS: Record<string, SeedTarget> = {
  local: { name: 'local', database: 'divvy', wranglerFlags: ['--local'], baseURL: 'http://localhost:8787', secretsFile: '.dev.vars' },
  staging: {
    name: 'staging',
    database: 'divvy-staging',
    wranglerFlags: ['--env', 'staging', '--remote'],
    baseURL: 'https://divvy-staging.hugohhkwok.workers.dev',
    secretsFile: '.dev.vars.staging',
  },
};

// There is deliberately no production entry: the seed wipes every table it touches.
export function resolveTarget(name: string): SeedTarget {
  const target = TARGETS[name];
  if (!target) throw new Error('seed target must be local or staging');
  return target;
}

export async function signSessionCookie(token: string, secret: string, baseURL: string): Promise<{ name: string; value: string }> {
  if (!secret) throw new Error('BETTER_AUTH_SECRET is empty');
  const name = getCookies({ baseURL }).sessionToken.name;
  const serialized = await serializeSignedCookie(name, token, secret);
  return { name, value: serialized.split(';')[0].slice(name.length + 1) };
}

const DAY = 86_400_000;
// The first 8 entries of CATEGORIES in src/constants.ts, with two stores each.
const SPEND: Array<[category: string, stores: [string, string], baseCents: number]> = [
  ['Groceries', ['Fresh Market', 'Corner Grocer'], 4200],
  ['Dining', ['Noodle House', 'Taco Stand'], 2800],
  ['Utilities', ['City Hydro', 'Fibre Internet'], 7500],
  ['Rent', ['Maple Property Mgmt', 'Maple Property Mgmt'], 120000],
  ['Entertainment', ['Riverside Cinema', 'Board Game Cafe'], 2400],
  ['Transport', ['Metro Transit', 'Quick Fuel'], 3500],
  ['Shopping', ['Home Goods Co', 'Bookshop'], 5600],
  ['Travel', ['Coastal Air', 'Harbour Hotel'], 18000],
];
const CARDS = { mem_alex: ['card_demo_visa', 'Demo Visa'], mem_sam: ['card_demo_mc', 'Demo Mastercard'] } as const;

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
// Equal split; the odd cent goes to the first member by id, as the server's largest-remainder split does.
const equalShares = (cents: number) => JSON.stringify({ [DEMO.ownerMemberId]: Math.ceil(cents / 2), [DEMO.memberId]: Math.floor(cents / 2) });

export function buildSeedSql({ now, sessionToken }: { now: number; sessionToken: string }): string {
  const h = q(DEMO.householdId);
  const lines = [
    'queue_items', 'transactions', 'expense_history', 'category_preferences', 'ai_usage', 'reminder_completions',
    'cycles', 'cards', 'household_members', 'households', 'session', 'account', 'user',
  ].map((t) => `DELETE FROM "${t}";`);

  lines.push(
    `INSERT INTO households (id, name, currency_code, timezone, custom_categories_json, allowed_emails_json, created_at) VALUES (${h}, 'Demo Household', 'CAD', 'America/Vancouver', '[]', ${q(JSON.stringify([{ email: DEMO.email, memberId: DEMO.ownerMemberId }]))}, ${now});`,
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (${q(DEMO.userId)}, 'Alex', ${q(DEMO.email)}, 1, ${now}, ${now});`,
    `INSERT INTO household_members (id, household_id, user_id, display_name, role, sort_order, created_at) VALUES (${q(DEMO.ownerMemberId)}, ${h}, ${q(DEMO.userId)}, 'Alex', 'owner', 0, ${now});`,
    `INSERT INTO household_members (id, household_id, user_id, display_name, role, sort_order, created_at) VALUES (${q(DEMO.memberId)}, ${h}, NULL, 'Sam', 'member', 1, ${now});`,
    `INSERT INTO cards (id, household_id, member_id, name, sort_order, statement_day) VALUES ('card_demo_visa', ${h}, ${q(DEMO.ownerMemberId)}, 'Demo Visa', 0, 5);`,
    `INSERT INTO cards (id, household_id, member_id, name, sort_order, statement_day) VALUES ('card_demo_mc', ${h}, ${q(DEMO.memberId)}, 'Demo Mastercard', 1, 20);`,
  );

  for (let i = 0; i < 60; i++) {
    const [category, stores, base] = SPEND[i % SPEND.length];
    const payer = i % 3 === 0 ? DEMO.memberId : DEMO.ownerMemberId;
    const [cardId, cardName] = CARDS[payer];
    const cents = base + ((i * 137) % 2000);
    const date = isoDate(now - (2 + i * 2) * DAY);
    lines.push(
      `INSERT INTO transactions (id, expense_id, household_id, cycle_id, date, store, amount_cents, category, payer_id, card_id, card_name_snapshot, split_type, split_shares_json, has_been_approved, revision, source, created_at, updated_at) VALUES ('tx_demo_${i}', 'exp_demo_${i}', ${h}, NULL, '${date}', ${q(stores[i % 2])}, ${cents}, ${q(category)}, ${q(payer)}, ${q(cardId)}, ${q(cardName)}, 'equal', ${q(equalShares(cents))}, 1, 1, 'manual', ${now}, ${now});`,
    );
  }

  for (const [i, store, cents] of [[0, 'Fresh Market', 3899], [1, 'Noodle House', 2450]] as const) {
    lines.push(
      `INSERT INTO queue_items (id, expense_id, household_id, date, store, amount_cents, category, payer_id, card_id, split_type, source, has_been_approved, created_at, updated_at) VALUES ('q_demo_${i}', 'exp_demo_q${i}', ${h}, '${isoDate(now - DAY)}', ${q(store)}, ${cents}, NULL, ${q(DEMO.ownerMemberId)}, 'card_demo_visa', 'equal', 'csv', 0, ${now}, ${now});`,
    );
  }

  lines.push(
    `INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('sess_demo', ${now + 30 * DAY}, ${q(sessionToken)}, ${now}, ${now}, ${q(DEMO.userId)});`,
  );
  return lines.join('\n') + '\n';
}
