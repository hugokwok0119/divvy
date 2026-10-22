import { eq, isNull, and, notExists, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { households, householdMembers, memberAccounts } from '../db/schema';

export interface AllowlistEntry {
  email: string;
  memberId: string;
}

export async function resolveSignIn(
  db: DrizzleD1Database,
  email: string,
  ownerEmail: string,
): Promise<{ allowed: boolean; memberId?: string }> {
  const normalized = email.trim().toLowerCase();
  const rows = await db.select().from(households).limit(1);

  // Bootstrap: only the configured owner may create the household.
  if (rows.length === 0) {
    return { allowed: normalized === ownerEmail.trim().toLowerCase() };
  }

  const hits = await db
    .select({ memberId: sql<string>`json_extract(entry.value, '$.memberId')` })
    .from(sql`${households}, json_each(${households.allowedEmailsJson}) entry`)
    .where(sql`lower(trim(json_extract(entry.value, '$.email'))) = ${normalized}`)
    .orderBy(households.createdAt, households.id)
    .limit(1);
  if (hits[0]) return { allowed: true, memberId: hits[0].memberId };

  if (normalized === ownerEmail.trim().toLowerCase()) {
    const ownerRows = await db
      .select({ memberId: householdMembers.id, linked: memberAccounts.memberId })
      .from(householdMembers)
      .innerJoin(households, eq(households.id, householdMembers.householdId))
      .leftJoin(memberAccounts, eq(memberAccounts.memberId, householdMembers.id))
      .where(eq(householdMembers.role, 'owner'))
      .orderBy(households.createdAt, households.id)
      .limit(1);
    return ownerRows[0] && ownerRows[0].linked === null
      ? { allowed: true, memberId: ownerRows[0].memberId }
      : { allowed: true };
  }
  return { allowed: false };
}

/** Links an account to a member slot. A slot with an account is never relinked. */
export async function linkUserToMember(
  db: DrizzleD1Database,
  userId: string,
  memberId: string,
): Promise<void> {
  const result = await db
    .update(householdMembers)
    .set({ userId })
    .where(and(
      eq(householdMembers.id, memberId),
      isNull(householdMembers.userId),
      notExists(db.select().from(memberAccounts).where(eq(memberAccounts.memberId, householdMembers.id))),
    ));

  // D1 counts the mirror_member_account_update trigger's insert too, so success can report 2.
  if (result.meta.changes === 0) {
    throw new Error(`Member ${memberId} is already linked to an account`);
  }
}
