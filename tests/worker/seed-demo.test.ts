import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createAuth } from '../../worker/auth';
import workerApp, { type Env } from '../../worker/index';
import { buildSeedSql, signSessionCookie } from '../../scripts/seed-demo/build';

describe('demo seed', () => {
  const testEnv = { ...env, OWNER_EMAIL: 'owner@example.com' } as unknown as Env;

  it('seeded cookie opens bootstrap', async () => {
    await env.DB.exec(buildSeedSql({ now: Date.now(), sessionToken: 'tok' }));
    // Staging is served over https; the cookie must be the one the Worker reads there.
    const { name, value } = await signSessionCookie('tok', (await createAuth(testEnv).$context).secret);
    const res = await workerApp.request('https://divvy-staging.hugohhkwok.workers.dev/api/bootstrap', { headers: { Cookie: `${name}=${value}` } }, testEnv);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      household: { name: string }; members: unknown[]; transactions: unknown[]; queue: unknown[]; me: { role: string };
    };
    expect(body.household.name).toBe('Demo Household');
    expect(body.members.length).toBe(2);
    expect(body.transactions.length).toBe(60);
    expect(body.queue.length).toBe(2);
    expect(body.me.role).toBe('owner');
  });

  it('seeding twice leaves the same counts', async () => {
    await env.DB.exec(buildSeedSql({ now: Date.now(), sessionToken: 'tok' }));
    await env.DB.exec(buildSeedSql({ now: Date.now(), sessionToken: 'tok' }));
    const count = async (t: string) => (await env.DB.prepare(`SELECT count(*) AS n FROM "${t}"`).first<{ n: number }>())!.n;
    expect(await count('transactions')).toBe(60);
    expect(await count('household_members')).toBe(2);
    expect(await count('session')).toBe(1);
  });
});
