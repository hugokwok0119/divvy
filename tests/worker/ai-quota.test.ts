import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { ScopedRepository } from '../../worker/lib/scope';

const repo = (householdId: string) => new ScopedRepository(drizzle(env.DB), householdId);
const today = '2026-10-22';

async function scan(householdId: string, times: number) {
  const results = [];
  for (let i = 0; i < times; i++) results.push(await repo(householdId).checkAiQuota(today));
  return results;
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM ai_usage');
});

describe('checkAiQuota', () => {
  it('refuses the 11th scan of the day across two groups', async () => {
    expect(await scan('h1', 6)).toEqual(Array(6).fill(true));
    expect(await scan('h2', 4)).toEqual(Array(4).fill(true));
    expect(await repo('h1').checkAiQuota(today)).toBe(false);
    expect(await repo('h2').checkAiQuota(today)).toBe(false);
  });

  it('still caps a single group at 10', async () => {
    expect(await scan('h1', 10)).toEqual(Array(10).fill(true));
    expect(await repo('h1').checkAiQuota(today)).toBe(false);
    // A refused group scan does not spend the app-wide allowance.
    const row = await env.DB.prepare("SELECT request_count FROM ai_usage WHERE household_id = 'all'").first();
    expect(row?.request_count).toBe(10);
  });
});
