import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { api, ApiError } from '../../src/lib/api';
import { computeShares } from '../../src/lib/settlement';
import type { Bootstrap, QueueItem, Transaction, CloseCycleInput } from '../../src/types';
import '../../src/index.css';
const session = {
  session: {
    id: 's1',
    userId: 'u1',
    token: 'test',
    expiresAt: '2099-01-01T00:00:00Z',
  },
  user: { id: 'u1', name: 'Alex', email: 'test@example.com' },
};
window.fetch = async () =>
  new Response(JSON.stringify(session), {
    headers: { 'content-type': 'application/json' },
  });
window.confirm = () => true;
const { default: App } = await import('../../src/App');
const pending: QueueItem = {
  hasBeenApproved: false, lastEditedAt: null, parentExpenseId: null,
  id: 'q1',
  expenseId: 'e1',
  revision: 1,
  date: null,
  store: null,
  amountCents: null,
  category: null,
  payerId: null,
  cardId: null,
  splitType: null,
  splitRuleJson: null,
  source: 'csv',
  sourceFileId: 'f1',
  sourceFileName: 'October.csv',
  isDuplicate: 0,
  editedByMemberId: null,
  editedByName: null,
  updatedAt: 0,
  reviewNote: null,
};
const approved: Transaction = {
  ...pending,
  hasBeenApproved: true,
  id: 't1',
  expenseId: 'e2',
  date: '2026-10-01',
  store: 'Cafe',
  amountCents: 1000,
  category: 'Dining',
  payerId: 'm1',
  cardId: 'c1',
  splitType: 'equal',
  cycleId: null,
  splitSharesJson: '{"m1":500,"m2":500}',
  cardNameSnapshot: 'Visa',
  isStarred: 0,
  favoriteName: null,
};
const initial: Bootstrap = {
  me: { memberId: 'm1', role: 'owner' },
  household: {
    id: 'h',
    name: 'Ledger test',
    currencyCode: 'CAD',
    timezone: 'America/Vancouver',
    customCategories: [],
    currentCycleName: null,
    rentReminder: true,
  },
  members: [
    {
      id: 'm1',
      displayName: 'Alex',
      role: 'owner',
      sortOrder: 0,
      archivedAt: null,
    },
    {
      id: 'm2',
      displayName: 'Sam',
      role: 'member',
      sortOrder: 1,
      archivedAt: null,
    },
  ],
  cards: [{ id: 'c1', memberId: 'm1', name: 'Visa', archived: 0, sortOrder: 0, statementDay: null, historyName: null, historyStatementDay: null, historyAppliedAt: null }],
  queue: [pending],
  transactions: [approved],
  cycles: [],
  categoryPreferences: {},
};
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function wait(test: () => boolean, message: string) {
  for (let i = 0; i < 150; i++) {
    if (test()) return;
    await tick();
  }
  throw new Error(message);
}
async function mount(options: { member?: boolean; legacy?: boolean; settled?: boolean; allocation?: Record<string, number>; third?: boolean; archived?: boolean; pendingComplete?: boolean; returned?: boolean } = {}) {
  let stored = structuredClone(initial);
  if (options.pendingComplete || options.returned) stored.queue[0] = { ...pending, date: approved.date, store: approved.store,
    amountCents: approved.amountCents, category: approved.category, payerId: approved.payerId, splitType: 'equal',
    hasBeenApproved: !!options.returned, lastEditedAt: options.returned ? 1 : null, editedByName: options.returned ? 'Sam' : null };
  if (options.allocation) {
    stored.transactions[0].splitType = 'custom';
    stored.transactions[0].splitRuleJson = JSON.stringify({ percentages: options.allocation });
  }
  if (options.third) stored.members.push({ id: 'm3', displayName: 'Morgan', role: 'member', sortOrder: 2, archivedAt: null });
  if (options.archived) stored.members[1].archivedAt = 1;
  if (options.member) stored.me = { memberId: 'm2', role: 'member' };
  const closings: CloseCycleInput[] = [];
  let staleClose = false;
  api.closeCycle = async (input) => {
    closings.push(structuredClone(input));
    if (staleClose) {
      stored.transactions[0] = { ...stored.transactions[0], amountCents: 4200, revision: 2 };
      throw new ApiError(409, 'Selected expenses changed. Review again.');
    }
    assert(input.confirmed === true, 'Closure must be explicitly confirmed');
    input.transactionIds.forEach((id) => assert(stored.transactions.find((tx) => tx.id === id)?.revision === input.revisions[id], 'Close revision mismatch'));
    stored.transactions = stored.transactions.filter((tx) => !input.transactionIds.includes(tx.id));
    return { ...fixtureCycle, id: input.cycleId };
  };
  let failSave = false,
    failApprove = false,
    failId = '';
  let saveGate: Promise<void> | null = null,
    releaseSave = () => {};
  const saves: Array<{ id: string; patch: any; revision: number }> = [],
    approvals: QueueItem[] = [],
    moves: any[] = [];
  api.bootstrap = async () => structuredClone(stored);
  api.updateQueueItem = async (id, patch, revision) => {
    saves.push({ id, patch, revision });
    if (saveGate) await saveGate;
    if (failSave || id === failId) throw new ApiError(409, 'Changed by Sam. Reload saved values.');
    const row = stored.queue.find((q) => q.id === id)!;
    assert(row.revision === revision, 'Queue revision mismatch');
    const next = {
      ...row,
      ...(patch as object),
      splitRuleJson:
        'splitRule' in (patch as any)
          ? JSON.stringify((patch as any).splitRule)
          : row.splitRuleJson,
      revision: revision + 1,
      editedByName: row.hasBeenApproved ? 'Alex' : null,
      lastEditedAt: row.hasBeenApproved ? Date.now() : null,
    };
    stored.queue = stored.queue.map((q) => (q.id === id ? next : q));
    return next;
  };
  api.updateTransaction = async (id, patch, revision) => {
    saves.push({ id, patch, revision });
    if (saveGate) await saveGate;
    if (failSave || id === failId) throw new ApiError(409, 'Changed by Sam. Reload saved values.');
    const row = stored.transactions.find((q) => q.id === id)!;
    assert(row.revision === revision, 'Transaction revision mismatch');
    const next = {
      ...row,
      ...(patch as object),
      splitRuleJson:
        'splitRule' in (patch as any)
          ? JSON.stringify((patch as any).splitRule)
          : row.splitRuleJson,
      revision: revision + 1,
      editedByName: 'Alex',
    };
    stored.transactions = stored.transactions.map((q) => (q.id === id ? next : q));
    next.splitSharesJson = JSON.stringify(computeShares(next.amountCents, next.splitType,
      next.splitRuleJson ? JSON.parse(next.splitRuleJson) : null,
      Object.keys(JSON.parse(row.splitSharesJson))));
    next.lastEditedAt = Date.now();
    return next;
  };
  api.confirmQueueItem = async (id, transactionId, input, revision) => {
    const row = stored.queue.find((q) => q.id === id)!;
    approvals.push(structuredClone(row));
    assert(row.revision === revision, 'Approve must use saved revision');
    if (failApprove) throw new ApiError(500, 'Approval failed');
    const next = {
      ...approved,
      ...row,
      ...(input as object),
      id: transactionId,
      revision: revision + 1,
      hasBeenApproved: true,
    } as Transaction;
    stored.queue = stored.queue.filter((q) => q.id !== id);
    stored.transactions.push(next);
    return next;
  };
  api.returnToPending = async (id, revision, note) => {
    const row = stored.transactions.find((q) => q.id === id)!;
    assert(row.revision === revision, 'Move must use saved revision');
    moves.push({ revision, note });
    const next = {
      ...row,
      id: 'returned',
      revision: revision + 1,
      isDuplicate: 0,
      reviewNote: note === undefined ? row.reviewNote : note,
    };
    stored.transactions = stored.transactions.filter((q) => q.id !== id);
    stored.queue.push(next);
    return next;
  };
  const deletedBatches: string[][] = [];
  api.deleteQueueItems = async (ids, revisions) => {
    ids.forEach((id) =>
      assert(
        stored.queue.find((row) => row.id === id)?.revision === revisions[id],
        'Bulk delete must use saved revisions',
      ),
    );
    deletedBatches.push(ids);
    stored.queue = stored.queue.filter((row) => !ids.includes(row.id));
    return ids;
  };
  api.deleteQueueItem = async (id) => {
    stored.queue = stored.queue.filter((row) => row.id !== id);
  };
  const fixtureCycle = {
    id: 'closed-fixture',
    status: options.settled ? 'settled' as const : 'closed' as const,
    settlementJson: null,
    closedByMemberId: options.legacy ? null : 'm1',
    closedByName: options.legacy ? null : 'Alex',
    closingSnapshotJson: options.legacy ? null : JSON.stringify({ transactions: [{ ...approved, state: 'approved' }], members: initial.members }),
    closedAt: 0,
    settledAt: null,
    name: null,
  };
  api.cycles = async () => [{ ...fixtureCycle, settlement: { balances: {}, transfers: [] }, groups: [] }];
  api.cycle = async () => ({
    cycle: fixtureCycle,
    transactions: stored.transactions.map((row) => ({ ...row, cycleId: fixtureCycle.id })),
    settlement: { balances: {}, transfers: [] },
  });
  let splitFailure = '';
  const splits: Array<{
    id: string;
    transactionId: string;
    amountCents: number;
    revision: number;
  }> = [];
  api.splitQueueItem = async (id, queueItemId, amountCents, revision) => {
    splits.push({ id, transactionId: queueItemId, amountCents, revision });
    if (splitFailure === 'before') { splitFailure = ''; throw new ApiError(500, 'Forced split failure'); }
    let original = stored.queue.find(row => row.id === id)!;
    let separated = stored.queue.find(row => row.id === queueItemId);
    if (!separated) {
      assert(original.revision === revision, 'Pending split revision mismatch');
      separated = { ...original, id: queueItemId, expenseId: queueItemId, parentExpenseId: original.expenseId, amountCents, revision: 1 };
      original = { ...original, amountCents: original.amountCents! - amountCents, revision: revision + 1 };
      stored.queue = [...stored.queue.map(row => row.id === id ? original : row), separated];
    }
    if (splitFailure === 'after') { splitFailure = ''; throw new ApiError(500, 'Lost split response'); }
    return { original, separated };
  };
  api.createTransaction = async () => {
    throw new ApiError(500, 'Forced child creation failure');
  };
  (api as any).splitTransaction = async (
    id: string,
    transactionId: string,
    amountCents: number,
    revision: number,
  ) => {
    splits.push({ id, transactionId, amountCents, revision });
    if (splitFailure === 'before') {
      splitFailure = '';
      throw new ApiError(500, 'Forced split failure');
    }
    let separated = stored.transactions.find((row) => row.id === transactionId);
    let original = stored.transactions.find((row) => row.id === id)!;
    if (!separated) {
      assert(original.revision === revision, 'Split original revision mismatch');
      separated = {
        ...original,
        id: transactionId,
        expenseId: transactionId,
        amountCents,
        revision: 1,
      };
      original = {
        ...original,
        amountCents: original.amountCents - amountCents,
        revision: revision + 1,
      };
      stored.transactions = [
        ...stored.transactions.map((row) => (row.id === id ? original : row)),
        separated,
      ];
    }
    if (splitFailure === 'after') {
      splitFailure = '';
      throw new ApiError(500, 'Lost split response');
    }
    return { original, separated };
  };
  api.expenseHistory = async (expenseId) => [
    {
      id: 'ev',
      expenseId,
      eventType: 'edited',
      actorMemberId: 'm2',
      actorName: 'Sam',
      timestamp: 1,
      before: {
        expenseId,
        revision: 1,
        state: 'approved',
        updatedAt: 0,
        reviewNote: null,
        amountCents: 1000,
      },
      after: {
        expenseId,
        revision: 2,
        state: 'approved',
        updatedAt: 1,
        reviewNote: null,
        amountCents: 2500,
      },
      reviewNote: null,
    },
  ];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<App />));
  await wait(() => !!host.querySelector('input[aria-label="Store"]'), 'App did not load');
  const buttons = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
    );
  const click = async (name: string) => {
    assert(buttons(name).length, `Missing ${name}`);
    flushSync(() => buttons(name)[0].click());
    await tick();
  };
  const field = (name: string) =>
    host.querySelector(`[aria-label="${name}"], [id="${name}"]`) as unknown as HTMLInputElement | HTMLSelectElement;
  const change = (name: string, value: string) => {
    if (!field(name) && name === 'Split') flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-label^="Custom split for"]')?.click());
    if (!field(name) && (name === 'Payer' || name === 'Card')) flushSync(() => buttons('Show details')[0]?.click());
    flushSync(() => {
      const element = field(name);
      assert(element, `Missing ${name}`);
      const proto =
        element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
      element.dispatchEvent(
        new Event(element.tagName === 'SELECT' ? 'change' : 'input', {
          bubbles: true,
        }),
      );
    });
  };
  return {
    host,
    root,
    buttons,
    click,
    field,
    change,
    saves,
    closings,
    staleClose: () => { staleClose = true; },
    splits,
    failSplit: (afterCommit = false) => {
      splitFailure = afterCommit ? 'after' : 'before';
    },
    deletedBatches,
    approvals,
    moves,
    stored: () => stored,
    failSave: () => {
      failSave = true;
    },
    allowSave: () => { failSave = false; },
    remount: async () => { flushSync(() => root.render(null)); flushSync(() => root.render(<App />)); await wait(() => !!host.querySelector('input[aria-label="Store"]'), 'Remount failed'); },
    externalPendingEdit: async () => {
      stored.queue[0] = { ...stored.queue[0], store: 'Saved by Sam', revision: stored.queue[0].revision + 1 };
      window.dispatchEvent(new Event('focus')); await tick();
    },
    failApprove: () => {
      failApprove = true;
    },
    failId: (id: string) => {
      failId = id;
    },
    addPending: async () => {
      stored.queue.push({
        ...pending,
        id: 'q2',
        expenseId: 'e3',
        store: 'Second item',
      });
      window.dispatchEvent(new Event('focus'));
      await tick();
    },
    externalEdit: async () => {
      stored.transactions[0] = {
        ...stored.transactions[0],
        store: 'Saved by Sam',
        revision: 2,
        editedByName: 'Sam',
      };
      window.dispatchEvent(new Event('focus'));
      await tick();
    },
    delaySave: () => {
      saveGate = new Promise((resolve) => {
        releaseSave = resolve;
      });
    },
    releaseSave: () => {
      releaseSave();
      saveGate = null;
    },
    close: () => {
      releaseSave();
      root.unmount();
      host.remove();
    },
  };
}
const results: string[] = [];
async function check(
  name: string,
  test: (view: Awaited<ReturnType<typeof mount>>) => Promise<void>,
  options: Parameters<typeof mount>[0] = {},
) {
  let view;
  try {
    view = await mount(options);
    await test(view);
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  } finally {
    view?.close();
  }
}
await check('same fields, nullable Pending and source grouping', async (v) => {
  await v.click('Pending (1)');
  assert(v.host.textContent?.includes('October.csv'), 'Missing file group');
  for (const name of ['Date', 'Store', 'Category', 'Payer', 'Card', 'Amount'])
    assert(v.field(name), `Missing Pending ${name}`);
  assert(v.field('Payer').value === '', 'Nullable payer must not silently default');
  await v.click('Approved (1)');
  await v.click('Show details');
  for (const name of ['Date', 'Store', 'Category', 'Payer', 'Card', 'Amount'])
    assert(v.field(name), `Missing Approved ${name}`);
  assert(v.host.querySelector('[aria-label="Split between"]'), 'Missing split controls');
});
await check(
  'draft survives tab switch and approval uses saved custom split/revision',
  async (v) => {
    await v.click('Pending (1)');
    v.change('Date', '2026-10-02');
    v.change('Store', 'Refund');
    v.change('Amount', '-12.34');
    v.change('Category', 'Other');
    v.change('Payer', 'm1');
    v.change('Split', 'custom');
    v.change('Alex percentage', '70');
    v.change('Sam percentage', '30');
    await v.click('Save allocation');
    await v.click('Approved (1)');
    await v.click('Pending (1)');
    assert(v.field('Store').value === 'Refund', 'Draft lost on tab change');
    assert(v.saves.length > 0, 'Completed controls must save');
    await v.click('Approve');
    await wait(() => v.stored().queue.length === 0, 'Approval did not progress');
    assert(
      v.approvals[0].revision > 1 && v.approvals[0].amountCents === -1234,
      'Must approve saved signed amount',
    );
    assert(JSON.parse(v.approvals[0].splitRuleJson!).percentages.m1 === 70, 'Custom rule lost');
  },
);
await check('single split persists, failure retains draft and Pending', async (v) => {
  await v.click('Pending (1)');
  v.change('Date', '2026-10-02');
  v.change('Store', 'Lunch');
  v.change('Amount', '10');
  v.change('Category', 'Dining');
  v.change('Payer', 'm1');
  v.change('Split', 'single');
  v.change('Split member', 'm2');
  v.failApprove();
  await v.click('Approve');
  await wait(() => v.host.textContent!.includes('Approval failed'), 'Approval failure missing');
  assert(
    v.stored().queue.length === 1 && v.field('Store').value === 'Lunch',
    'Failed approval lost Pending/draft',
  );
  assert(JSON.parse(v.approvals[0].splitRuleJson!).memberId === 'm2', 'Single split lost');
});
await check(
  'Approved save stays Approved, payer clears card, conflict keeps typed values',
  async (v) => {
    await v.click('Approved (1)');
    v.change('Amount', '25');
    v.change('Payer', 'm2');
    assert(v.field('Card').value === '', 'Incompatible card retained');
    await v.click('Save changes');
    await wait(
      () => v.saves.length === 1 && !v.host.textContent?.includes('Saving…'),
      'Save did not finish',
    );
    assert(
      v.stored().transactions[0].amountCents === 2500 &&
        v.stored().transactions[0].cardId === null &&
        v.stored().queue.length === 1,
      'Approved save changed lifecycle',
    );
    v.change('Store', 'Typed locally');
    v.failSave();
    await v.click('Save changes');
    await wait(() => v.host.textContent!.includes('Changed by Sam'), 'Conflict missing');
    assert(v.field('Store').value === 'Typed locally', 'Conflict erased draft');
  },
);
await check(
  'selection scoped to tab and Save and move uses authoritative revision/note',
  async (v) => {
    await v.click('Approved (1)');
    const select = v.host.querySelector<HTMLInputElement>('input[aria-label="Select Cafe"]')!;
    assert(select, 'Missing row selection');
    flushSync(() => select.click());
    await v.click('Pending (1)');
    assert(!v.host.textContent?.includes('1 selected'), 'Selection leaked to Pending');
    await v.click('Approved (1)');
    v.change('Amount', '32');
    await v.click('Move to Pending');
    v.change('Review note', 'Check allocation');
    await v.click('Save and move');
    await wait(() => v.moves.length === 1, 'Move failed');
    assert(
      v.moves[0].revision === 2 && v.moves[0].note === 'Check allocation',
      'Move used stale revision/note',
    );
    assert(
      v.stored().queue.find((q) => q.id === 'returned')?.amountCents === 3200,
      'Move lost saved values',
    );
  },
);
await check('history names actor and actual before/after differences', async (v) => {
  await v.click('Approved (1)');
  await v.click('View edit history');
  await wait(() => v.host.textContent!.includes('Sam'), 'History actor missing');
  assert(
    v.host.textContent?.includes('10.00') && v.host.textContent?.includes('25.00'),
    'History difference missing',
  );
});
await check('bulk failure progresses successful rows and preserves failed drafts', async (v) => {
  await v.addPending();
  await v.click('Pending (2)');
  flushSync(() => v.field('Select all visible expenses').click());
  v.failId('q2');
  v.change('Set category for selected expenses', 'Other');
  await wait(() => v.host.textContent!.includes('Changed by Sam'), 'Bulk failure missing');
  assert(
    v.stored().queue[0].category === 'Other' && v.stored().queue[1].category === null,
    'Successful/failed bulk rows not distinguished',
  );
  assert(
    v.host.textContent?.includes('2 selected'),
    'Autosave must retain approval selection',
  );
  const second = [...v.host.querySelectorAll('li')].find(
    (li) =>
      li.querySelector<HTMLInputElement>('input[aria-label="Store"]')?.value === 'Second item',
  )!;
  assert(
    (second.querySelector('[aria-label="Category"]') as unknown as HTMLSelectElement).value ===
      'Other',
    'Failed bulk draft lost',
  );
});
await check('delayed save survives tab switch without approving stale values', async (v) => {
  await v.click('Approved (1)');
  v.change('Store', 'Still typed');
  v.delaySave();
  await v.click('Save changes');
  await v.click('Pending (1)');
  assert(v.buttons('Approve All')[0].disabled, 'Global approve must wait for active save');
  await v.click('Approved (1)');
  assert(
    v.field('Store').value === 'Still typed' && v.field('Store').disabled,
    'Tab switch lost or unlocked in-flight draft',
  );
  v.releaseSave();
  await wait(() => !v.field('Store').disabled, 'Delayed save did not release');
  assert(
    v.field('Store').value === 'Still typed' && v.stored().transactions[0].store === 'Still typed',
    'Authoritative save lost typed store',
  );
});
await check('new server revision shows saved differences and retains local draft', async (v) => {
  await v.click('Approved (1)');
  v.change('Amount', '42');
  await v.externalEdit();
  assert(
    v.field('Amount').value === '42' && v.host.textContent?.includes('Saved by Sam'),
    'Conflict must retain draft and show saved values',
  );
  assert(v.buttons('Save changes')[0].disabled, 'Unseen revision must not overwrite');
  await v.click('Cancel');
  assert(v.field('Store').value === 'Saved by Sam', 'Cancel must load latest saved row');
});
await check('Pending bulk deletion preserves the atomic versioned endpoint', async (v) => {
  await v.addPending();
  await v.click('Pending (2)');
  flushSync(() => v.field('Select all visible expenses').click());
  await v.click('Delete selected');
  await v.click('Confirm delete');
  await wait(() => v.stored().queue.length === 0, 'Selected Pending rows were not deleted');
  assert(
    v.deletedBatches.length === 1 && v.deletedBatches[0].length === 2,
    'Must retain atomic Pending bulk deletion',
  );
});
await check('bulk staging cannot bypass a selected row save lock', async (v) => {
  await v.click('Approved (1)');
  flushSync(() => v.field('Select Cafe').click());
  await v.click('Set bulk split');
  v.change('Store', 'Saving row');
  v.delaySave();
  await v.click('Save changes');
  for (const label of [
    'Set category for selected expenses',
    'Set payer for selected expenses',
    'Set card for selected expenses',
  ])
    assert(v.field(label).disabled, `${label} must respect row save lock`);
  assert(
    v.buttons('Set bulk split')[0].disabled && v.buttons('Apply split to drafts')[0].disabled,
    'Bulk split controls must respect row save lock',
  );
  v.change('Set category for selected expenses', 'Travel');
  assert(
    v.field('Category').value === 'Dining',
    'Programmatic change must also be guarded while row saves',
  );
  v.releaseSave();
  await wait(() => !v.field('Store').disabled, 'Save lock not released');
  v.change('Set category for selected expenses', 'Travel');
  assert(v.field('Category').value === 'Travel', 'Bulk staging should resume after save');
});
await check('Done Editing shows saved cycle fields and retains private drafts', async (v) => {
  flushSync(() => v.host.querySelector<HTMLButtonElement>('button[aria-label="History"]')!.click());
  await wait(
    () => [...v.host.querySelectorAll('button')].some((b) => b.textContent?.includes('Closed ')),
    'Cycle list missing',
  );
  flushSync(() =>
    [...v.host.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('Closed '))!
      .click(),
  );
  await wait(() => v.buttons('Edit Transactions').length > 0, 'Cycle detail missing');
  await v.click('Edit Transactions');
  v.change('Store', 'Unsaved cycle draft');
  v.change('Date', '1999-01-01');
  v.change('Category', 'Travel');
  v.change('Split', 'single');
  await v.click('Done Editing');
  const row = v.host.querySelector('li')!;
  assert(
    row.textContent?.includes('Cafe') && !row.textContent?.includes('Unsaved cycle draft'),
    'Read-only view must render authoritative store',
  );
  assert(
    !row.textContent?.includes('1999-01-01') &&
      row.textContent?.includes('Dining') &&
      row.textContent?.includes('equal'),
    'Read-only view must render authoritative date/category/split',
  );
  await v.click('Edit Transactions');
  assert(
    v.field('Store').value === 'Unsaved cycle draft',
    'Leaving edit mode should retain private draft',
  );
});
await check('clean conflicting draft offers Cancel to load saved version', async (v) => {
  await v.click('Approved (1)');
  v.change('Store', 'Temporary');
  v.change('Store', 'Cafe');
  await v.externalEdit();
  assert(v.host.textContent?.includes('Saved values changed'), 'Expected clean-record conflict');
  assert(v.buttons('Cancel').length === 1, 'Conflict must offer Cancel even after local reversion');
  await v.click('Cancel');
  assert(
    v.field('Store').value === 'Saved by Sam' && !v.buttons('Star Saved by Sam')[0].disabled,
    'Cancel must restore usable saved row',
  );
});
for (const lostResponse of [false, true])
  await check(
    `atomic breakdown preserves money through ${lostResponse ? 'lost response' : 'failure'} and retry`,
    async (v) => {
      await v.click('Approved (1)');
      await v.click('Break down Cafe');
      v.change('Amount to separate', '3');
      v.failSplit(lostResponse);
      await v.click('Confirm Split');
      await wait(
        () => v.host.textContent!.includes(lostResponse ? 'Lost split response' : 'Forced'),
        'Split failure not shown',
      );
      assert(
        v.stored().transactions.reduce((sum, row) => sum + row.amountCents, 0) === 1000,
        'Split failure must preserve total money',
      );
      assert(v.stored().transactions.length === (lostResponse ? 2 : 1), 'Failure must be atomic');
      await v.click('Confirm Split');
      await wait(() => !v.buttons('Confirm Split').length, 'Split retry did not complete');
      assert(
        v
          .stored()
          .transactions.map((row) => row.amountCents)
          .sort()
          .join(',') === '300,700',
        'Retry must complete exactly one split',
      );
      assert(
        v.splits.length === 2 && v.splits[0].transactionId === v.splits[1].transactionId,
        'Retry must retain stable child identity',
      );
    },
  );
const acknowledge = (v: Awaited<ReturnType<typeof mount>>) => {
  const box = v.host.querySelector<HTMLInputElement>('input[aria-label="I confirm closing the selected expenses. This does not mark them as paid."]');
  assert(box, 'Closing acknowledgment missing');
  flushSync(() => box!.click());
};
const closeDialog = (v: Awaited<ReturnType<typeof mount>>) => v.host.querySelector('[aria-labelledby="close-cycle-heading"]')!;
const startClose = async (v: Awaited<ReturnType<typeof mount>>) => {
  const button = [...v.host.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^Close \d+ transactions/.test(b.textContent?.trim() ?? ''));
  assert(button, 'Close entry missing');
  flushSync(() => button!.click());
  await tick();
};
await check('member closes saved selection only with unchecked acknowledgment and exact revisions', async (v) => {
  await startClose(v);
  assert(v.buttons('Close cycle')[0].disabled, 'Unchecked close must be disabled');
  assert(!closeDialog(v).querySelector('textarea'), 'Closing must not collect a reason');
  acknowledge(v);
  assert(!v.buttons('Close cycle')[0].disabled, 'Checked saved selection must enable close');
  await v.click('Close cycle');
  await wait(() => !v.buttons('Close cycle').length, 'Closing did not finish');
  assert(v.closings.length === 1 && v.closings[0].confirmed === true && v.closings[0].transactionIds.join() === 't1' && v.closings[0].revisions.t1 === 1, 'Close payload must match acknowledged values');
  assert(v.stored().queue.length === 1 && v.stored().transactions.length === 0, 'Closing must leave Pending untouched');
}, { member: true });
await check('reopening closes unchecked and unrelated Pending import does not reset acknowledgment', async (v) => {
  await startClose(v);
  acknowledge(v);
  await v.addPending();
  assert(!v.buttons('Close cycle')[0].disabled, 'Unrelated Pending import invalidated saved selection');
  flushSync(() => [...closeDialog(v).querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Cancel')!.click());
  await startClose(v);
  assert(v.buttons('Close cycle')[0].disabled, 'Reopened close must start unchecked');
});
await check('included external edit resets acknowledgment and displays refreshed saved values', async (v) => {
  await startClose(v);
  acknowledge(v);
  await v.externalEdit();
  assert(v.buttons('Close cycle')[0].disabled, 'Included revision must reset acknowledgment');
  assert(closeDialog(v).textContent?.includes('Saved by Sam'), 'Preview did not refresh included values');
});
await check('included dirty draft requires explicit Cancel without auto-save', async (v) => {
  await v.click('Approved (1)');
  v.change('Amount', '99');
  await startClose(v);
  assert(closeDialog(v).textContent?.includes('Save or cancel'), 'Dirty closing must explain next action');
  acknowledge(v);
  assert(v.buttons('Close cycle')[0].disabled && v.saves.length === 0, 'Dirty values must not auto-save or close');
  flushSync(() => [...closeDialog(v).querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Cancel')!.click());
  await v.click('Cancel');
  await startClose(v);
  acknowledge(v);
  assert(!v.buttons('Close cycle')[0].disabled, 'Explicit Cancel should unblock saved close');
});
await check('in-flight included save blocks closing until completion and fresh acknowledgment', async (v) => {
  await v.click('Approved (1)');
  v.change('Amount', '25');
  v.delaySave();
  await v.click('Save changes');
  await startClose(v);
  acknowledge(v);
  assert(v.buttons('Close cycle')[0].disabled, 'In-flight save must block closing');
  v.releaseSave();
  await wait(() => !v.field('Amount').disabled, 'Save did not complete');
  assert(v.buttons('Close cycle')[0].disabled, 'Completed save requires fresh acknowledgment');
  assert(closeDialog(v).textContent?.includes('25.00'), 'Saved preview amount missing');
  await wait(() => !closeDialog(v).querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled, 'Saved closing values did not become ready for acknowledgment');
  await tick();
  acknowledge(v);
  await v.click('Close cycle');
  assert(v.closings[0].revisions.t1 === 2, 'Closing must await authoritative saved revision');
});
await check('stale close refreshes preview and never silently retries', async (v) => {
  await startClose(v);
  acknowledge(v);
  v.staleClose();
  await v.click('Close cycle');
  await wait(() => closeDialog(v).textContent!.includes('42.00'), 'Conflict preview did not refresh');
  assert(v.buttons('Close cycle')[0].disabled && v.closings.length === 1, 'Conflict must reset acknowledgment without retry');
});
const openHistory = async (v: Awaited<ReturnType<typeof mount>>) => {
  flushSync(() => v.host.querySelector<HTMLButtonElement>('button[aria-label="History"]')!.click());
  await wait(() => [...v.host.querySelectorAll('button')].some((b) => b.textContent?.includes('Closed ')), 'Cycle list missing');
  flushSync(() => [...v.host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Closed '))!.click());
  await wait(() => v.host.textContent!.includes('Cycle total'), 'Cycle detail missing');
};
await check('history retains closer and original snapshot after an unsettled correction', async (v) => {
  await openHistory(v);
  assert(v.host.textContent?.includes('Closed by Alex'), 'Closer missing');
  await v.click('Edit Transactions');
  v.change('Amount', '25');
  await v.click('Save changes');
  await wait(() => v.host.textContent!.includes('Changed since closing'), 'Correction label missing');
  await v.click('View edit history');
  await wait(() => v.host.textContent!.includes('Values at closing'), 'Original closing values missing');
  assert(v.host.textContent?.includes('10.00') && v.host.textContent?.includes('25.00'), 'Original/current difference missing');
}, { member: true });
await check('legacy closer is unknown and settled expenses have no editing controls', async (v) => {
  await openHistory(v);
  assert(v.host.textContent?.includes('Closed by unknown member'), 'Legacy actor must be honest');
  assert(!v.buttons('Edit Transactions').length && !v.field('Amount'), 'Settled cycle must remain read-only');
  assert(!v.buttons('Mark as Settled').length && !v.buttons('Undo Settlement').length, 'Member must not settle');
}, { member: true, legacy: true, settled: true });
const finishField = (v: Awaited<ReturnType<typeof mount>>, name: string) => flushSync(() => {
  const field = v.field(name);
  field.focus();
  field.blur();
});
await check('Pending text saves on completion and survives remount without history clutter', async v => {
  await v.click('Pending (1)');
  v.change('Store', 'Completed shop');
  assert(v.saves.length === 0, 'Raw typing was saved');
  assert(!v.buttons('Save changes').length && !v.buttons('View edit history').length, 'First Pending exposes manual save/history');
  finishField(v, 'Store');
  await wait(() => v.stored().queue[0].store === 'Completed shop' && !v.host.textContent?.includes('Saving…'), 'Completed store not saved');
  await v.remount(); await v.click('Pending (1)');
  assert(v.field('Store').value === 'Completed shop', 'Remount lost saved field');
  assert(!v.host.textContent?.includes('Edited by'), 'First Pending typing counted as later edit');
});
await check('delayed Pending save retains newer raw amount until its blur', async v => {
  await v.click('Pending (1)'); v.delaySave();
  v.change('Amount', '50'); finishField(v, 'Amount');
  v.change('Amount', '80');
  assert(!v.field('Amount').disabled, 'Autosave locked typing');
  v.releaseSave();
  await wait(() => v.stored().queue[0].amountCents === 5000 && !v.host.textContent?.includes('Saving…'), 'First save did not finish');
  assert(v.field('Amount').value === '80' && v.saves.length === 1, 'Response erased or persisted newer typing');
  finishField(v, 'Amount');
  await wait(() => v.stored().queue[0].amountCents === 8000, 'New completion not saved');
});
await check('queued completion captures values before later raw store typing', async v => {
  await v.click('Pending (1)'); v.delaySave();
  v.change('Amount', '50'); finishField(v, 'Amount');
  v.change('Category', 'Dining');
  v.change('Store', 'Unfinished prefix');
  v.releaseSave();
  await wait(() => v.stored().queue[0].category === 'Dining' && !v.host.textContent?.includes('Saving…'), 'Queued completion missing');
  assert(v.stored().queue[0].store === null && v.field('Store').value === 'Unfinished prefix', 'Queued write captured later raw typing');
});
await check('queued Pending completions survive a stage switch during saving', async v => {
  await v.click('Pending (1)'); v.delaySave();
  v.change('Amount', '50'); finishField(v, 'Amount'); v.change('Category', 'Dining');
  await v.click('Approved (1)'); v.releaseSave();
  await wait(() => v.stored().queue[0].category === 'Dining', 'Stage switch blocked queued Pending completion');
  await v.click('Pending (1)'); assert(v.field('Amount').value === '50.00', 'Stage switch lost saved amount');
});
await check('known Pending amounts retain invalid raw drafts without writing them', async v => {
  await v.click('Pending (1)');
  for (const raw of ['', '-', 'NaN', '1000000.01']) {
    v.change('Amount', raw); finishField(v, 'Amount'); await tick();
    assert(v.saves.length === 0 && v.field('Amount').value === raw, 'Invalid amount written or replaced');
  }
}, { pendingComplete: true });
await check('Pending approval waits for persistence and flushes latest valid amount', async v => {
  await v.click('Pending (1)'); v.delaySave();
  v.change('Amount', '50'); finishField(v, 'Amount'); v.change('Amount', '80');
  await v.click('Approve');
  assert(v.approvals.length === 0, 'Approved before save response');
  v.releaseSave();
  await wait(() => v.approvals.length === 1, 'Approval never resumed');
  assert(v.approvals[0].amountCents === 8000 && v.approvals[0].revision > 1, 'Approval used stale amount/revision');
}, { pendingComplete: true });
await check('Pending failure retains draft and Retry saves once after recovery', async v => {
  await v.click('Pending (1)'); v.failSave();
  v.change('Store', 'Retry shop'); finishField(v, 'Store');
  await wait(() => !!v.buttons('Retry').length, 'Retry missing');
  assert(v.field('Store').value === 'Retry shop', 'Failure lost draft');
  v.allowSave(); await v.click('Retry');
  await wait(() => v.stored().queue[0].store === 'Retry shop', 'Retry did not save');
});
await check('external Pending revision retains local values until explicit Cancel', async v => {
  await v.click('Pending (1)'); v.change('Store', 'Local draft'); await v.externalPendingEdit();
  await wait(() => v.host.textContent!.includes('Saved values changed'), 'Conflict missing');
  finishField(v, 'Store'); await tick();
  assert(v.saves.length === 0 && v.field('Store').value === 'Local draft', 'Conflict overwrote saved/local value');
  await v.click('Cancel'); assert(v.field('Store').value === 'Saved by Sam', 'Cancel did not load authoritative value');
});
await check('returned Pending keeps orange edit history', async v => {
  await v.click('Pending (1)');
  assert(v.buttons('View edit history')[0].className.includes('orange'), 'Returned history lacks edit color');
  assert(v.host.textContent?.includes('Edited by Sam'), 'Returned edit attribution lost');
}, { returned: true });
for (const lost of [false, true]) await check(`Pending breakdown ${lost ? 'lost response' : 'failure'} retries same identity and exact total`, async v => {
  await v.click('Pending (1)'); v.change('Amount', '100'); finishField(v, 'Amount');
  await wait(() => v.stored().queue[0].amountCents === 10000 && !v.host.textContent?.includes('Saving…'), 'Amount completion missing');
  await v.click('Break down Cafe'); v.change('Amount to separate', '30'); v.failSplit(lost);
  await v.click('Confirm Split');
  await wait(() => v.host.textContent!.includes(lost ? 'Lost split response' : 'Forced split failure'), 'Split failure missing');
  await v.click('Confirm Split');
  await wait(() => v.stored().queue.length === 2 && !v.buttons('Confirm Split').length, 'Retry did not finish');
  assert(v.splits[0].transactionId === v.splits[1].transactionId, 'Retry changed child identity');
  assert(v.stored().queue.reduce((sum, row) => sum + row.amountCents!, 0) === 10000 && v.stored().queue[0].amountCents === 7000, 'Pending total changed');
  assert(v.stored().queue[1].parentExpenseId === 'e1' && v.stored().transactions.length === 1, 'Child lifecycle/source lost');
  const childRow = [...v.host.querySelectorAll('li')].find(row => row.querySelector<HTMLInputElement>('[aria-label="Amount"]')?.value === '30.00')!;
  const category = childRow.querySelector('select[aria-label="Category"]') as unknown as HTMLSelectElement;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(category, 'Other');
    category.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await wait(() => v.stored().queue[1].category === 'Other', 'Child category did not save independently');
  assert(v.stored().queue[0].category === 'Dining', 'Child category changed source');
}, { pendingComplete: true });
for (const stage of ['Pending (1)', 'Approved (1)']) {
  await check(`numeric blank and blur validation in ${stage}`, async v => {
    await v.click(stage);
    v.change('Amount', '50');
    v.change('Amount', '');
    assert(v.field('Amount').value === '', 'Blank amount replaced while typing');
    assert(!v.host.querySelector('[role="alert"]'), 'Validation appeared before completion');
    finishField(v, 'Amount');
    assert(v.host.querySelector('[role="alert"]'), 'Missing inline blur validation');
    assert(v.saves.length === 0, 'Invalid blank was written');
    v.change('Amount', '80');
    finishField(v, 'Amount');
    if (stage.startsWith('Approved')) await v.click('Save changes');
    await wait(() => v.saves.length === 1, 'Valid numeric edit did not save');
    assert((v.saves[0].patch as { amountCents: number }).amountCents === 8000, 'Wrong saved cents');
  });
}
await check('numeric custom draft and explicit Save gate', async v => {
  await v.click('Approved (1)');
  v.change('Split', 'custom');
  v.change('Alex percentage', '');
  assert(v.field('Alex percentage').value === '', 'Blank percentage became zero');
  finishField(v, 'Alex percentage');
  assert(v.buttons('Save allocation')[0].disabled, 'Blank custom allocation can save');
  assert(v.host.querySelector('[role="alert"]'), 'Missing inline allocation warning');
  for (const value of ['79', '81']) {
    v.change('Alex percentage', value);
    v.change('Sam percentage', '20');
    finishField(v, 'Sam percentage');
    assert(v.buttons('Save allocation')[0].disabled, '99/101 allocation can save');
  }
  v.change('Alex percentage', '80');
  assert(!v.buttons('Save allocation')[0].disabled, 'Exact 100 cannot save');
  assert(v.saves.length === 0, 'Allocation persisted before dialog completion');
  await v.click('Save allocation');
  await v.click('Save changes');
  await wait(() => v.saves.length === 1, 'Completed allocation did not persist');
  assert(JSON.parse(v.stored().transactions[0].splitRuleJson!).percentages.m1 === 80, 'Wrong completed allocation');
});
await check('numeric custom Cancel preserves prior allocation', async v => {
  await v.click('Approved (1)');
  v.change('Split', 'custom');
  v.change('Alex percentage', '');
  await v.click('Cancel allocation');
  assert(v.stored().transactions[0].splitType === 'equal' && v.saves.length === 0, 'Cancel changed saved allocation');
  assert(!v.buttons('Save changes').length, 'Cancel left an allocation-only dirty row');
});
await check('numeric invalid custom text survives stage switches', async v => {
  await v.click('Approved (1)');
  v.change('Split', 'custom');
  v.change('Alex percentage', '-');
  await v.click('Pending (1)');
  await v.click('Approved (1)');
  v.change('Split', 'custom');
  assert(v.field('Alex percentage').value === '-', 'Stage switch lost invalid allocation text');
});
await check('numeric unchanged legacy allocation permits unrelated edit', async v => {
  await v.click('Approved (1)');
  v.change('Amount', '-12.34');
  await v.click('Save changes');
  await wait(() => v.saves.length === 1, 'Legacy unrelated edit blocked');
  assert(!('splitRule' in v.saves[0].patch) && !('splitType' in v.saves[0].patch), 'Legacy allocation was rewritten');
  assert(JSON.parse(v.stored().transactions[0].splitRuleJson!).percentages.m1 === 20, 'Legacy percentage changed');
}, { allocation: { m1: 20, m2: 20 } });
await check('numeric thirds retain existing precision', async v => {
  await v.click('Approved (1)');
  v.change('Split', 'custom');
  assert(!v.buttons('Save allocation')[0].disabled, 'Default thirds rejected');
  assert(v.field('Alex percentage').value === String(100 / 3), 'Default precision rounded');
}, { third: true });
await check('numeric zero-percent archived participant remains visible', async v => {
  await v.click('Approved (1)');
  v.change('Split', 'custom');
  assert(v.field('Sam percentage').value === '0', 'Archived zero participant lost');
  assert(!v.buttons('Save allocation')[0].disabled, 'Valid zero percentage rejected');
}, { allocation: { m1: 100, m2: 0 }, archived: true });
await check('numeric manual drafts retain incomplete text and validate on blur', async v => {
  await v.click('Manual');
  v.change('manual-store', 'Manual purchase');
  v.change('manual-amount', '-');
  assert(v.field('manual-amount').value === '-', 'Incomplete manual amount was replaced');
  finishField(v, 'manual-amount');
  assert(v.host.querySelector('[role="alert"]'), 'Manual amount lacks inline feedback');
  assert(v.stored().queue.length === 1, 'Invalid manual amount was written');
});
await check('numeric breakdown validates on blur and retains draft', async v => {
  await v.click('Approved (1)');
  await v.click('Break down Cafe');
  v.change('Amount to separate', '-');
  finishField(v, 'Amount to separate');
  assert(v.field('Amount to separate').value === '-', 'Invalid breakdown draft lost');
  assert(v.host.querySelector('[role="alert"]'), 'Breakdown lacks completion feedback');
  assert(v.splits.length === 0, 'Invalid breakdown was submitted');
});
await check('numeric Cancel clears the completed field error', async v => {
  await v.click('Approved (1)');
  v.change('Amount', '-');
  finishField(v, 'Amount');
  assert(v.host.querySelector('[role="alert"]'), 'Missing completed error');
  await v.click('Cancel');
  assert(v.field('Amount').value === '10.00', 'Cancel did not restore saved amount');
  assert(!v.host.querySelector('[role="alert"]'), 'Cancel retained stale amount validation');
});
await check('numeric editable history retains empty drafts and validates completion', async v => {
  await openHistory(v);
  await v.click('Edit Transactions');
  v.change('Amount', '');
  assert(v.field('Amount').value === '', 'History blank replaced');
  finishField(v, 'Amount');
  assert(v.host.querySelector('[role="alert"]'), 'History lacks completion validation');
  v.change('Amount', '80');
  finishField(v, 'Amount');
  assert(!v.host.querySelector('[role="alert"]'), 'Valid history draft stayed invalid');
  assert(v.saves.length === 0, 'History saved while typing');
});
await check('numeric bulk custom allocation uses the same Save gate', async v => {
  await v.click('Approved (1)');
  flushSync(() => v.field('Select Cafe').click());
  await v.click('Set bulk split');
  v.change('Split', 'custom');
  v.change('Alex percentage', '');
  assert(v.field('Alex percentage').value === '', 'Bulk blank became zero');
  assert(v.buttons('Apply split to drafts')[0].disabled, 'Bulk action bypassed dialog Save');
  v.change('Alex percentage', '80');
  v.change('Sam percentage', '20');
  await v.click('Save allocation');
  await v.click('Apply split to drafts');
  await v.click('Save changes');
  await wait(() => v.saves.length === 1, 'Bulk allocation did not save');
  assert(JSON.parse(v.stored().transactions[0].splitRuleJson!).percentages.m1 === 80, 'Wrong bulk allocation');
});
const output = `${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed\n${results.join('\n')}`;
document.querySelector('[role="status"]')!.textContent = output;
if (new URLSearchParams(location.search).has('demo')) {
  (document.querySelector('[role="status"]') as HTMLElement).hidden = true;
  await mount({ pendingComplete: true, returned: true });
}
