import { describe, expect, it, vi } from 'vitest';
import { planSend, rowsPaidBy, sendRows } from '../src/lib/sendToGroup';
import type { Member, QueueItem, QueueItemInput } from '../src/types';

const member = (id: string, displayName: string, archivedAt: number | null = null): Member => ({
  id, displayName, role: 'member', sortOrder: 0, archivedAt, sittingOutAt: null,
});

const row = (id: string, payerId: string | null, extra: Partial<QueueItem> = {}): QueueItem => ({
  expenseId: `e_${id}`, hasBeenApproved: false, lastEditedAt: null, parentExpenseId: null, revision: 3,
  editedByMemberId: null, editedByName: null, source: 'csv', sourceFileId: 'f1', sourceFileName: 'march.csv',
  reviewNote: null, splitRuleJson: '{"memberId":"m_yuki"}', updatedAt: 1, id, date: '2026-03-01',
  store: 'Shop', amountCents: 1234, category: 'Groceries', payerId, cardId: 'c1', splitType: 'single',
  isDuplicate: 0, ...extra,
});

const source = [member('m_yuki', 'Yuki'), member('m_kit', 'Kit'), member('m_sam', 'Sam')];
let n = 0;
const newId = () => `new_${++n}`;

describe('planSend', () => {
  it('carries the payer over by display name', () => {
    const { inputs, unmatchedPayers } = planSend([row('q1', 'm_yuki')], source, [member('t_yuki', 'yuki ')], newId);
    expect(inputs[0].payerId).toBe('t_yuki');
    expect(unmatchedPayers).toEqual([]);
  });

  it('leaves the payer blank and names who did not carry over', () => {
    const { inputs, unmatchedPayers } = planSend(
      [row('q1', 'm_kit'), row('q2', 'm_kit')], source, [member('t_yuki', 'Yuki')], newId,
    );
    expect(inputs.map((i) => i.payerId)).toEqual([null, null]);
    expect(unmatchedPayers).toEqual(['Kit']);
  });

  it('does not match an archived or ambiguous name', () => {
    const target = [member('t_yuki', 'Yuki', 5), member('t_sam1', 'Sam'), member('t_sam2', 'sam')];
    const { inputs, unmatchedPayers } = planSend([row('q1', 'm_yuki'), row('q2', 'm_sam')], source, target, newId);
    expect(inputs.map((i) => i.payerId)).toEqual([null, null]);
    expect(unmatchedPayers).toEqual(['Yuki', 'Sam']);
  });

  it('clears the card, resets the split to equal and keeps the import details', () => {
    const { inputs } = planSend([row('q1', 'm_yuki')], source, [member('t_yuki', 'Yuki')], () => 'fresh');
    expect(inputs[0]).toEqual({
      id: 'fresh', date: '2026-03-01', store: 'Shop', amountCents: 1234, category: 'Groceries',
      payerId: 't_yuki', cardId: null, splitType: 'equal', splitRule: null,
      source: 'csv', sourceFileId: 'f1', sourceFileName: 'march.csv',
    });
  });
});

describe('sendRows', () => {
  const rows = [row('q1', null, { revision: 4 }), row('q2', null, { revision: 7 })];
  const inputs = [{ id: 'n1' }, { id: 'n2' }] as QueueItemInput[];

  it('creates before it removes', async () => {
    const calls: string[] = [];
    const deps = {
      create: async () => { calls.push('create'); return ['n1', 'n2']; },
      remove: async () => { calls.push('remove'); },
    };
    expect(await sendRows(deps, rows, inputs)).toEqual({ result: 'sent', notCopied: 0 });
    expect(calls).toEqual(['create', 'remove']);
  });

  it('removes nothing when creating fails', async () => {
    const remove = vi.fn();
    await expect(sendRows({ create: () => Promise.reject(new Error('nope')), remove }, rows, inputs)).rejects.toThrow('nope');
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps originals whose copy was not created', async () => {
    const remove = vi.fn(async () => {});
    const outcome = await sendRows({ create: async () => ['n2'], remove }, rows, inputs);
    expect(remove).toHaveBeenCalledWith(['q2'], { q2: 7 });
    expect(outcome).toEqual({ result: 'sent', notCopied: 1 });
  });

  it('skips removing when no copy was created', async () => {
    const remove = vi.fn();
    expect(await sendRows({ create: async () => [], remove }, rows, inputs)).toEqual({ result: 'sent', notCopied: 2 });
    expect(remove).not.toHaveBeenCalled();
  });

  it('reports a copy left behind when removing fails', async () => {
    const outcome = await sendRows(
      { create: async () => ['n1', 'n2'], remove: () => Promise.reject(new Error('gone')) }, rows, inputs,
    );
    expect(outcome).toEqual({ result: 'copied-not-removed', notCopied: 0 });
  });
});

describe('rowsPaidBy', () => {
  it('counts the rows the named source payer paid', () => {
    const rows = [row('q1', 'm_kit'), row('q2', 'm_kit'), row('q3', 'm_yuki'), row('q4', null)];
    expect(rowsPaidBy(rows, source, 'Kit')).toBe(2);
    expect(rowsPaidBy(rows, source, 'Sam')).toBe(0);
  });
});
