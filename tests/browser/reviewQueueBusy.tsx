import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import ReviewQueue from '../../src/components/ReviewQueue';
import type { QueueItem, QueueItemInput } from '../../src/types';

// Serve with npm run dev, then open /tests/browser/reviewQueueBusy.html.
// Runs automatically against the real component and browser DOM, without dependencies.
const item: QueueItem = {
  hasBeenApproved: false, lastEditedAt: null, parentExpenseId: null,
  expenseId: 'expense-test', revision: 1, editedByMemberId: null, editedByName: null, sourceFileId: null, sourceFileName: null, reviewNote: null, splitRuleJson: null, updatedAt: 0,
  id: 'q1', date: '2024-06-09', store: 'Uber', amountCents: 586, category: 'Transport',
  payerId: 'm1', cardId: null, splitType: 'equal', isDuplicate: 0, source: 'csv',
};
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const saves = new Map<string, ReturnType<typeof deferred>>();
  const approval = deferred();
  const updates: Array<{ id: string; date: unknown }> = [];
  const confirmed: QueueItem[] = [];
  const errors: string[] = [];
  let missingDate = 0;
  let delayApproval = false;
  let queue = [item, { ...item, id: 'q2', expenseId: 'expense-test-2', store: 'Lyft' }];
  const render = () => flushSync(() => root.render(<ReviewQueue
    queue={queue} members={[{ id: 'm1', displayName: 'Alex', role: 'owner', sortOrder: 0, archivedAt: null }]} cards={[]} customCategories={[]} transactions={[]}
    onUpdate={(id: string, patch: Partial<QueueItemInput>) => {
      updates.push({ id, date: patch.date });
      const save = deferred();
      saves.set(id, save);
      const update = save.promise.then(() => {
        queue = queue.map((row) => row.id === id ? { ...row, date: patch.date ?? null, revision: row.revision + 1 } : row);
        render();
        return queue.find((row) => row.id === id)!;
      });
      void update.catch(() => {});
      return update;
    }}
    onConfirm={async (row) => {
      if (!row.date) { missingDate++; throw new Error('Missing date'); }
      confirmed.push(row);
      if (delayApproval) await approval.promise;
      return { ...row, date: row.date!, store: row.store!, amountCents: row.amountCents!, category: row.category!, payerId: row.payerId!, splitType: 'equal', cycleId: null, cardNameSnapshot: null, splitSharesJson: '{}', isStarred: 0, favoriteName: null };
    }}
    onDelete={async () => {}} onDeleteMany={async () => {}}
    showToast={(message) => errors.push(message)}
  />));
  render();
  const rowFor = (store: string) => [...host.querySelectorAll('li')].find((row) => row.querySelector<HTMLInputElement>('input[aria-label="Store"]')?.value === store)!;
  const dates = () => ['Uber', 'Lyft'].map((store) => rowFor(store).querySelector<HTMLInputElement>('input[aria-label="Date"]')!);
  const confirms = () => ['Uber', 'Lyft'].map((store) => rowFor(store).querySelector<HTMLButtonElement>('button[aria-label="Approve"]')!);
  const save = (index: number) => flushSync(() => { dates()[index].focus(); dates()[index].blur(); });
  const all = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Approve All')!;
  const change = (index: number, value: string) => flushSync(() => {
    const input = dates()[index];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return {
    dates, confirms, all, change, save, saves, updates, confirmed, errors: () => [...host.querySelectorAll('[role="alert"]')].map(element => element.textContent!),
    missingDate: () => missingDate,
    delayApproval: () => { delayApproval = true; },
    releaseApproval: approval.resolve,
    click: (button: HTMLButtonElement) => flushSync(() => button.click()),
    close: async () => {
      for (const save of saves.values()) save.resolve();
      approval.resolve();
      await flush();
      root.unmount();
      host.remove();
    },
  };
}

const results: string[] = [];
async function check(name: string, test: (view: ReturnType<typeof mount>) => Promise<void>) {
  const view = mount();
  try { await test(view); results.push(`PASS ${name}`); }
  catch (error) { results.push(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
  finally { await view.close(); }
}

for (const date of ['2024-06-10', '']) {
  await check(`completed ${date || 'cleared date'} saves and approval waits`, async view => {
    view.change(0, date);
    assert(view.updates.length === 0, 'Raw typing must stay local');
    view.save(0);
    assert(view.updates.length === 1, 'Blur must persist completed date');
    assert(view.updates[0].date === (date || null), 'Date patch changed');
    assert(!view.dates()[0].disabled && !view.dates()[1].disabled, 'Autosave must retain typing');
    view.click(view.confirms()[0]);
    assert(view.confirmed.length === 0, 'Approval sent before save');
    view.saves.get('q1')!.resolve(); await flush(); await flush();
    if (date) assert(view.confirmed[0]?.date === date, 'Approval used stale date');
    else assert(view.confirmed.length === 0 && view.errors().some(error => error.includes('Fill in')), 'Cleared date passed approval');
  });
}
await check('independent rows save without freezing typing', async view => {
  view.change(0, '2024-06-10'); view.save(0); view.change(1, '2024-06-11'); view.save(1);
  assert(view.saves.size === 2, 'Rows must save independently');
  assert(!view.dates()[0].disabled && !view.dates()[1].disabled, 'Autosave locked typing');
  view.click(view.all());
  view.saves.get('q1')!.resolve(); await flush();
  assert(view.confirmed.length === 1 && view.all().disabled, 'Batch approval must wait for second save');
  view.saves.get('q2')!.resolve(); await flush(); await flush();
  assert(view.confirmed.length === 2 && !view.all().disabled, 'Batch did not finish saved rows');
});
await check('failed save retains draft and offers explicit retry', async view => {
  view.change(0, ''); view.save(0);
  view.saves.get('q1')!.reject(new Error('Save failed')); await flush();
  assert(!view.dates()[0].disabled, 'Failure locked typing');
  assert(view.errors().some(error => error.includes('Save failed')), 'Failure missing');
  assert(view.dates()[0].value === '', 'Failed save lost draft');
});
for (const kind of ['row', 'all']) {
  await check(`${kind} approval blocks later date edits`, async (view) => {
    view.delayApproval();
    view.click(kind === 'row' ? view.confirms()[0] : view.all());
    assert(view.dates()[0].disabled && view.all().disabled, 'Approval must lock date editing and batch approval');
    if (kind === 'all') assert(view.dates()[1].disabled && view.confirms()[1].disabled, 'Batch approval must lock all rows');
    view.releaseApproval(); await flush();
    assert(!view.dates()[0].disabled && !view.all().disabled, 'Approval completion must release controls');
    assert(view.confirmed.length === (kind === 'row' ? 1 : 2), 'Approval must process intended rows');
  });
}
document.querySelector('[role="status"]')!.textContent = `${results.filter((result) => result.startsWith('PASS')).length}/${results.length} passed\n${results.join('\n')}`;
