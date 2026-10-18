/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';

const migrationPath = new URL('../migrations/0005_pending_approval_history.sql', import.meta.url);
const migrated = () => {
  const database = new DatabaseSync(':memory:');
  for (const table of ['transactions', 'queue_items']) database.exec(`CREATE TABLE ${table} (
    id TEXT PRIMARY KEY, household_id TEXT, expense_id TEXT, edited_by_member_id TEXT,
    edited_by_name TEXT, updated_at INTEGER, revision INTEGER DEFAULT 1)`);
  database.exec('CREATE TABLE expense_history (id TEXT PRIMARY KEY, household_id TEXT, expense_id TEXT, revision INTEGER, event_type TEXT, timestamp INTEGER, actor_member_id TEXT, actor_name TEXT, before_json TEXT, after_json TEXT, source_row_id TEXT, target_row_id TEXT)');
  return database;
};
const event = (database: DatabaseSync, id: string, expenseId: string, revision: number,
  type: string, before: string | null, after: string, household = 'h1') => {
  database.prepare('INSERT INTO expense_history (id, household_id, expense_id, revision, event_type, timestamp, actor_member_id, actor_name, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, household, expenseId, revision, type, revision * 100, 'm2', 'Hugo', before, after);
};
const apply = (database: DatabaseSync) => {
  database.exec(existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '');
};

describe('additive approval-history migration', () => {
  it('marks meaningful legacy edits after migration while ignoring legacy no-op events', () => {
    const database = migrated();
    try {
      apply(database);
      database.exec("INSERT INTO transactions (id, household_id, expense_id, edited_by_name, updated_at) VALUES ('t', 'h1', 'e', 'Alex', 0)");
      event(database, 'edit', 'e', 2, 'edited', '{"store":"Old"}', '{"store":"New"}');
      database.exec("UPDATE transactions SET updated_at = 200, revision = 2 WHERE id = 't'");
      expect(database.prepare('SELECT last_edited_at FROM transactions').get()).toMatchObject({ last_edited_at: 200 });
      event(database, 'noop', 'e', 3, 'edited', '{"store":"New"}', '{"store":"New"}');
      database.exec("UPDATE transactions SET updated_at = 300, revision = 3 WHERE id = 't'");
      expect(database.prepare('SELECT last_edited_at FROM transactions').get()).toMatchObject({ last_edited_at: 200 });
    } finally { database.close(); }
  });
  it('preserves server markers through legacy inserts in both lifecycle directions', () => {
    const database = migrated();
    try {
      apply(database);
      database.exec("INSERT INTO transactions (id, household_id, expense_id, edited_by_name, has_been_approved, last_edited_at, parent_expense_id) VALUES ('t', 'h1', 'e', 'Editor', 1, 123, 'source')");
      database.exec("INSERT INTO queue_items (id, household_id, expense_id, edited_by_name) SELECT 'q', household_id, expense_id, 'Approver' FROM transactions WHERE id = 't'");
      database.exec("DELETE FROM transactions WHERE id = 't'");
      expect(database.prepare('SELECT * FROM queue_items').get()).toMatchObject({ has_been_approved: 1, last_edited_at: 123, parent_expense_id: 'source', edited_by_name: 'Editor' });
      database.exec("INSERT INTO transactions (id, household_id, expense_id, edited_by_name) SELECT 't2', household_id, expense_id, 'Approver' FROM queue_items WHERE id = 'q'");
      database.exec("DELETE FROM queue_items WHERE id = 'q'");
      expect(database.prepare('SELECT * FROM transactions').get()).toMatchObject({ has_been_approved: 1, last_edited_at: 123, parent_expense_id: 'source', edited_by_name: 'Editor' });
    } finally { database.close(); }
  });
  it('backfills real approval and meaningful edit evidence without rewriting old snapshots', () => {
    const database = migrated();
    try {
      database.exec("INSERT INTO transactions (id, household_id, expense_id, edited_by_member_id, edited_by_name, updated_at) VALUES ('t1', 'h1', 'approved', 'm1', 'Sam', 999)");
      database.exec("INSERT INTO queue_items (id, household_id, expense_id, edited_by_member_id, edited_by_name, updated_at) VALUES ('q1', 'h1', 'returned', 'm1', 'Sam', 999)");
      const original = ' { "state":"approved", "store":"Old", "amountCents":10000 } ';
      const changed = '{"state":"approved","store":"New","amountCents":10000}';
      event(database, 'approved-baseline', 'approved', 1, 'legacy_baseline', null, original);
      event(database, 'approved-edit', 'approved', 2, 'edited', original, changed);
      event(database, 'approved-noop', 'approved', 3, 'edited', changed, changed);
      event(database, 'returned-approval', 'returned', 1, 'approved', null, original);
      event(database, 'returned-event', 'returned', 2, 'returned_to_pending', original, '{"state":"pending","store":"Old"}');
      event(database, 'returned-edit', 'returned', 3, 'edited', '{"state":"pending","store":"Old"}', '{"state":"pending","store":"Fixed"}');
      const historical = database.prepare('SELECT * FROM expense_history ORDER BY id').all();
      apply(database);
      expect(database.prepare('SELECT * FROM transactions').get()).toMatchObject({ has_been_approved: 1,
        last_edited_at: 200, edited_by_member_id: 'm2', edited_by_name: 'Hugo', parent_expense_id: null });
      expect(database.prepare('SELECT * FROM queue_items').get()).toMatchObject({ has_been_approved: 1,
        last_edited_at: 300, edited_by_name: 'Hugo', parent_expense_id: null });
      expect(database.prepare('SELECT * FROM expense_history ORDER BY id').all()).toEqual(historical);
    } finally { database.close(); }
  });

  it('does not turn initial Pending typing or another household approval into prior approval', () => {
    const database = migrated();
    try {
      database.exec("INSERT INTO queue_items (id, household_id, expense_id, edited_by_member_id, edited_by_name, updated_at) VALUES ('q1', 'h1', 'shared', 'm1', 'Sam', 999)");
      event(database, 'pending-import', 'shared', 1, 'imported', null, '{"state":"pending","store":null}');
      event(database, 'pending-typing', 'shared', 2, 'edited', '{"state":"pending","store":null}', '{"state":"pending","store":"Entered"}');
      event(database, 'foreign-approval', 'shared', 1, 'approved', null, '{"state":"approved","store":"Foreign"}', 'h2');
      apply(database);
      expect(database.prepare('SELECT * FROM queue_items').get()).toMatchObject({ has_been_approved: 0, last_edited_at: null });
    } finally { database.close(); }
  });
});
