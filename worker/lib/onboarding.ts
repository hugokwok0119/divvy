import { eq, isNull, and } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { households, householdMembers } from '../db/schema';

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

  const allowlist: AllowlistEntry[] = JSON.parse(rows[0].allowedEmailsJson);
  const hit = allowlist.find((e) => e.email.trim().toLowerCase() === normalized);
  if (hit) return { allowed: true, memberId: hit.memberId };

  if (normalized === ownerEmail.trim().toLowerCase()) {
    const ownerRows = await db
      .select({ memberId: householdMembers.id })
      .from(householdMembers)
      .where(and(
        eq(householdMembers.householdId, rows[0].id),
        eq(householdMembers.role, 'owner'),
      ))
      .limit(1);
    return ownerRows[0]
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
    .where(and(eq(householdMembers.id, memberId), isNull(householdMembers.userId)));

  // D1 counts the mirror_member_account_update trigger's insert too, so success can report 2.
  if (result.meta.changes === 0) {
    throw new Error(`Member ${memberId} is already linked to an account`);
  }
}
