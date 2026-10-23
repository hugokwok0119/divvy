/// <reference types="node" />
import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const migration = () => readFileSync(new URL('../migrations/0010_group_accounts.sql', import.meta.url), 'utf8');

describe('group accounts migration', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE households (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE household_members (id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        user_id TEXT UNIQUE, display_name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE queue_items (id TEXT PRIMARY KEY, household_id TEXT NOT NULL);
      CREATE TABLE cycles (id TEXT PRIMARY KEY, household_id TEXT NOT NULL);
      CREATE TABLE cards (id TEXT PRIMARY KEY, household_id TEXT NOT NULL);
      INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', 0);
      INSERT INTO household_members (id, household_id, user_id, display_name, created_at) VALUES
        ('m1', 'h1', 'u1', 'Sam', 5), ('m2', 'h1', NULL, 'Alex', 6);
    `);
    db.exec(migration());
  });

  it('backfills one account link per linked member', () => {
    expect(db.prepare('SELECT member_id, household_id, user_id FROM member_accounts').all())
      .toEqual([{ member_id: 'm1', household_id: 'h1', user_id: 'u1' }]);
  });
  it('mirrors a user_id set later into member_accounts', () => {
    db.exec("UPDATE household_members SET user_id = 'u2' WHERE id = 'm2'");
    expect(db.prepare("SELECT user_id FROM member_accounts WHERE member_id = 'm2'").get()).toEqual({ user_id: 'u2' });
  });
  it('mirrors a member inserted with a user_id', () => {
    db.exec("INSERT INTO household_members (id, household_id, user_id, display_name, created_at) VALUES ('m3', 'h1', 'u3', 'Kim', 7)");
    expect(db.prepare("SELECT household_id, user_id FROM member_accounts WHERE member_id = 'm3'").get())
      .toEqual({ household_id: 'h1', user_id: 'u3' });
  });
  it('lets one account link to members in two groups', () => {
    db.exec("INSERT INTO households (id, name, created_at) VALUES ('h2', 'Trip', 0)");
    db.exec("INSERT INTO household_members (id, household_id, user_id, display_name, created_at) VALUES ('m9', 'h2', NULL, 'Sam', 8)");
    db.exec("INSERT INTO member_accounts (member_id, household_id, user_id, linked_at) VALUES ('m9', 'h2', 'u1', 0)");
    expect(db.prepare("SELECT member_id FROM member_accounts WHERE user_id = 'u1' ORDER BY member_id").all())
      .toEqual([{ member_id: 'm1' }, { member_id: 'm9' }]);
  });
  it('rejects a second member for the same account in one group', () => {
    expect(() => db.exec("INSERT INTO member_accounts (member_id, household_id, user_id, linked_at) VALUES ('m2', 'h1', 'u1', 0)"))
      .toThrow(/UNIQUE constraint failed/);
  });
  it('keeps existing households on the rent reminder', () => {
    expect(db.prepare("SELECT rent_reminder FROM households WHERE id = 'h1'").get()).toEqual({ rent_reminder: 1 });
  });
  it('adds the household_id indexes', () => {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['queue_household_idx', 'cycles_household_idx', 'members_household_idx', 'cards_household_idx']));
  });
});
