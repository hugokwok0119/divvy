import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { households, householdMembers } from '../../worker/db/schema';
import { resolveSignIn, linkUserToMember } from '../../worker/lib/onboarding';

const db = () => drizzle(env.DB);

beforeEach(async () => {
  await env.DB.exec('DELETE FROM household_members');
  await env.DB.exec('DELETE FROM households');
});

describe('resolveSignIn', () => {
  it('allows the owner email when no household exists yet', async () => {
    const r = await resolveSignIn(db(), 'owner@example.com', 'owner@example.com');
    expect(r.allowed).toBe(true);
  });

  it('refuses any other address when no household exists', async () => {
    const r = await resolveSignIn(db(), 'stranger@example.com', 'owner@example.com');
    expect(r.allowed).toBe(false);
  });

  it('refuses an address absent from the allowlist once a household exists', async () => {
    await db().insert(households).values({
      id: 'h1', name: 'Divvy', createdAt: 0,
      allowedEmailsJson: JSON.stringify([{ email: 'sam@example.com', memberId: 'm1' }]),
    });
    const r = await resolveSignIn(db(), 'stranger@example.com', 'owner@example.com');
    expect(r.allowed).toBe(false);
  });

  it('allows an allowlisted address and returns its member slot', async () => {
    await db().insert(households).values({
      id: 'h1', name: 'Divvy', createdAt: 0,
      allowedEmailsJson: JSON.stringify([{ email: 'sam@example.com', memberId: 'm1' }]),
    });
    const r = await resolveSignIn(db(), 'sam@example.com', 'owner@example.com');
    expect(r).toEqual({ allowed: true, memberId: 'm1' });
  });

  it('matches email case-insensitively', async () => {
    await db().insert(households).values({
      id: 'h1', name: 'Divvy', createdAt: 0,
      allowedEmailsJson: JSON.stringify([{ email: 'sam@example.com', memberId: 'm1' }]),
    });
    const r = await resolveSignIn(db(), 'SAM@Example.COM', 'owner@example.com');
    expect(r.allowed).toBe(true);
  });
});

describe('linkUserToMember', () => {
  beforeEach(async () => {
    await db().insert(households).values({ id: 'h1', name: 'Divvy', createdAt: 0 });
    await db().insert(householdMembers).values({
      id: 'm1', householdId: 'h1', displayName: 'Sam', createdAt: 0, userId: null,
    });
  });

  it('links a member slot that has no account yet', async () => {
    await linkUserToMember(db(), 'u1', 'm1');
    const rows = await db().select().from(householdMembers);
    expect(rows[0].userId).toBe('u1');
  });

  it('never relinks a member slot that already has an account', async () => {
    await linkUserToMember(db(), 'u1', 'm1');
    await expect(linkUserToMember(db(), 'u2', 'm1')).rejects.toThrow();
    const rows = await db().select().from(householdMembers);
    expect(rows[0].userId).toBe('u1');
  });
});
