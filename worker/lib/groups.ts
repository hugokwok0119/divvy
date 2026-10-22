/**
 * Groups the signed-in account belongs to, across households. These run
 * before any group is chosen, so they read the session directly instead of
 * going through requireScope.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { households, householdMembers, memberAccounts } from '../db/schema';
import { createAuth } from '../auth';
import { isEmailAllowed, isOwnerEmail } from './scope';
import type { Env } from '../index';

export interface GroupSummary {
  id: string;
  name: string;
  role: 'owner' | 'member';
  memberId: string;
  peopleCount: number;
  pendingCount: number;
}

type GroupContext = Context<{ Bindings: Env }>;

async function readSession(c: GroupContext) {
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) throw new HTTPException(401, { message: 'Not signed in' });
  return session;
}

// The POST route checks the creator before validating, then createGroup checks again; one read serves both.
const sessions = new WeakMap<Request, ReturnType<typeof readSession>>();

function requireSession(c: GroupContext) {
  let session = sessions.get(c.req.raw);
  if (!session) {
    session = readSession(c);
    sessions.set(c.req.raw, session);
  }
  return session;
}

/** 401 without a session, 403 unless the account is the configured owner. */
export async function requireGroupCreator(c: GroupContext) {
  const session = await requireSession(c);
  if (!isOwnerEmail(session.user.email, c.env.OWNER_EMAIL)) {
    throw new HTTPException(403, { message: 'Only the owner can create groups' });
  }
  return session;
}

export async function listGroups(c: GroupContext): Promise<{ groups: GroupSummary[]; canCreate: boolean }> {
  const session = await requireSession(c);
  const rows = await drizzle(c.env.DB)
    .select({
      id: households.id,
      name: households.name,
      role: sql<'owner' | 'member'>`${householdMembers.role}`,
      memberId: householdMembers.id,
      peopleCount: sql<number>`(select count(*) from household_members p where p.household_id = ${households.id} and p.archived_at is null)`,
      pendingCount: sql<number>`(select count(*) from queue_items q where q.household_id = ${households.id})`,
      allowedEmailsJson: households.allowedEmailsJson,
    })
    .from(memberAccounts)
    .innerJoin(householdMembers, eq(householdMembers.id, memberAccounts.memberId))
    .innerJoin(households, eq(households.id, memberAccounts.householdId))
    // An archived member cannot open the group (requireScope refuses it), so it is not listed.
    .where(and(eq(memberAccounts.userId, session.user.id), isNull(householdMembers.archivedAt)))
    .orderBy(asc(memberAccounts.linkedAt), asc(households.id));
  // Same allowlist rule as requireScope: a removed person sees neither the group nor its counts.
  const groups = rows
    .filter((r) => isEmailAllowed(session.user.email, r.allowedEmailsJson, c.env.OWNER_EMAIL))
    .map(({ allowedEmailsJson: _, ...group }) => group);
  return { groups, canCreate: isOwnerEmail(session.user.email, c.env.OWNER_EMAIL) };
}

export async function createGroup(
  c: GroupContext,
  input: { name: string; currencyCode: string; timezone: string },
): Promise<GroupSummary> {
  const session = await requireGroupCreator(c);
  const db = drizzle(c.env.DB);
  const id = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const now = Date.now();
  // Never fall back to the email: emails stay on the server.
  const ownerName = session.user.name.trim() || 'Owner';
  // user_id stays null: that column is globally unique and already links the
  // caller's first household. The member_accounts row is the link here.
  await db.batch([
    db.insert(households).values({ id, ...input, rentReminder: 0, allowedEmailsJson: '[]', createdAt: now }),
    db.insert(householdMembers).values({ id: memberId, householdId: id, displayName: ownerName, role: 'owner', sortOrder: 0, createdAt: now }),
    db.insert(memberAccounts).values({ memberId, householdId: id, userId: session.user.id, linkedAt: now }),
  ]);
  return { id, name: input.name, role: 'owner', memberId, peopleCount: 1, pendingCount: 0 };
}
