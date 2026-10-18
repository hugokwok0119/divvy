import { sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { aiUsage } from '../db/schema';

// The Gemini key's project is on the API free tier: 20 requests per day per model.
// A statement scan can take 2 requests (first pass plus repair), so 10 scans stay under it.
export const DAILY_AI_LIMIT = 10;

/** Returns false when the household is over its daily allowance. */
export async function checkAndIncrement(
  db: DrizzleD1Database,
  householdId: string,
  usageDate: string,
  limit = DAILY_AI_LIMIT,
): Promise<boolean> {
  await db.insert(aiUsage)
    .values({ householdId, usageDate, requestCount: 1 })
    .onConflictDoUpdate({
      target: [aiUsage.householdId, aiUsage.usageDate],
      set: { requestCount: sql`${aiUsage.requestCount} + 1` },
    });

  const rows = await db.select().from(aiUsage)
    .where(sql`${aiUsage.householdId} = ${householdId} AND ${aiUsage.usageDate} = ${usageDate}`)
    .limit(1);

  return (rows[0]?.requestCount ?? 0) <= limit;
}
