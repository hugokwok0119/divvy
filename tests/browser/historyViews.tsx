import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import HistoryPage from '../../src/components/HistoryModal';
import type { Card, ClosingSnapshot, Cycle, ExpenseHistoryEvent, Member, Transaction } from '../../src/types';
import '../../src/index.css';

const members: Member[] = [
  { id: 'm1', displayName: 'Alex', role: 'owner', sortOrder: 0, archivedAt: null },
  { id: 'm2', displayName: 'Sam', role: 'member', sortOrder: 1, archivedAt: null },
];
const cards: Card[] = [{ id: 'c1', memberId: 'm1', name: 'Visa', archived: 0, sortOrder: 0, statementDay: null, historyName: null, historyStatementDay: null, historyAppliedAt: null }];
const transaction: Transaction = {
  id: 't1', expenseId: 'e1', revision: 3, hasBeenApproved: true, lastEditedAt: 1791986400000,
  parentExpenseId: null, date: '2026-10-01', store: 'Corner market', amountCents: 12000,
  category: 'Groceries', payerId: 'm1', cardId: 'c1', splitType: 'custom',
  splitRuleJson: '{"percentages":{"m1":60,"m2":40}}', splitSharesJson: '{"m1":7200,"m2":4800}',
  cycleId: 'closed-cycle', cardNameSnapshot: 'Visa', source: 'csv', sourceFileId: 'f1',
  sourceFileName: 'October statement.csv', editedByMemberId: 'm2', editedByName: 'Sam',
  updatedAt: 1791986400000, reviewNote: null, isStarred: 0, favoriteName: null,
};
const original = { ...transaction, state: 'approved' as const, revision: 2, store: 'Original market',
  amountCents: 10000, splitSharesJson: '{"m1":6000,"m2":4000}' };
const closingSnapshot: ClosingSnapshot = { transactions: [original], members };
const settlement = { balances: { m1: 4800, m2: -4800 }, transfers: [{ from: 'm2', to: 'm1', amountCents: 4800 }] };
const cycles: Cycle[] = [
  { id: 'closed-cycle', status: 'closed', settlementJson: null, closedByMemberId: 'm1', closedByName: 'Alex',
    closingSnapshotJson: JSON.stringify(closingSnapshot), closedAt: 1791806400000, settledAt: null },
  { id: 'paid-cycle', status: 'settled', settlementJson: JSON.stringify(settlement), closedByMemberId: 'm1', closedByName: 'Alex',
    closingSnapshotJson: JSON.stringify(closingSnapshot), closedAt: 1791720000000, settledAt: 1791892800000 },
];
const events: ExpenseHistoryEvent[] = [
  { id: 'edited', expenseId: 'e1', eventType: 'edited', actorMemberId: 'm2', actorName: 'Sam',
    timestamp: 1791986400000, reviewNote: null, before: original,
    after: { ...transaction, state: 'approved' } },
  { id: 'closed', expenseId: 'e1', eventType: 'closed', actorMemberId: 'm1', actorName: 'Alex',
    timestamp: 1791806400000, reviewNote: null, before: original, after: original },
  { id: 'approved', expenseId: 'e1', eventType: 'approved', actorMemberId: 'm1', actorName: 'Alex',
    timestamp: 1791720000000, reviewNote: null, before: { ...original, state: 'pending', revision: 1 }, after: original },
];
let historyFailure = false;
let historyEmpty = false;
const writes: string[] = [];
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);
  if ((init?.method ?? (input instanceof Request ? input.method : 'GET')) !== 'GET') {
    writes.push(url.pathname); throw new Error('History fixture rejects mutations.');
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/api/cycles') return json(cycles.map(cycle => ({ ...cycle, settlement, groups: [] })));
  const cycle = cycles.find(cycle => url.pathname === `/api/cycles/${cycle.id}`);
  if (cycle) return json({ cycle, settlement, transactions: [{ ...transaction, cycleId: cycle.id }] });
  if (url.pathname === '/api/transactions/history/e1') {
    if (historyFailure) return json({ error: 'History temporarily unavailable.' }, 503);
    return json(historyEmpty ? [] : events);
  }
  return json({ error: `Unexpected fixture request: ${url.pathname}` }, 404);
};
const host = document.querySelector('#fixture') as HTMLElement;
const root = createRoot(host);
const output: string[] = [];
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 20));
const button = (label: string) => [...host.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === label || element.textContent?.trim() === label);
const click = async (label: string) => { const element = button(label); assert(element, `Missing ${label}`); flushSync(() => element!.click()); await tick(); };
async function until(predicate: () => unknown) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('History view did not finish loading.');
}
function mount() {
  flushSync(() => root.render(null));
  flushSync(() => root.render(<HistoryPage members={members} cards={cards} categories={['Groceries']} role="member"
    onBack={() => {}} onChanged={async () => { throw new Error('Inspection triggered refresh after a mutation.'); }}
    showToast={message => { throw new Error(message); }} />));
}
async function selectCycle(status: Cycle['status']) {
  await until(() => host.querySelector('button[aria-pressed]'));
  const label = [...host.querySelectorAll('button')].find(element => element.getAttribute('aria-label')?.endsWith(status === 'closed' ? ', not settled' : ', settled'))!.getAttribute('aria-label')!;
  await click(label);
  await until(() => button('View edit history'));
}
async function openHistory() {
  const trigger = button('View edit history')!; trigger.focus(); await click('View edit history');
  await until(() => (host.querySelector('.ledger-history-dialog') as HTMLDialogElement)?.open);
  await until(() => !host.querySelector('.ledger-history-dialog')?.textContent?.includes('Loading history'));
  return { trigger, dialog: host.querySelector('.ledger-history-dialog') as HTMLDialogElement };
}
async function check(name: string, test: () => Promise<void>) {
  historyFailure = false; historyEmpty = false; mount();
  try { await test(); output.push(`PASS ${name}`); }
  catch (error) { output.push(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
}
const query = new URLSearchParams(location.search);
if (query.get('demo') !== '1') {
  for (const status of ['closed', 'settled'] as const) {
    await check(`${status} cycle transaction history shows differences without full snapshots`, async () => {
      await selectCycle(status); const { dialog } = await openHistory();
      assert(dialog.matches(':modal'), 'History is not a native floating modal.');
      assert(getComputedStyle(dialog).backgroundColor === 'rgb(255, 255, 255)', 'History card is not white.');
      assert(getComputedStyle(dialog, '::backdrop').backdropFilter.includes('blur'), 'History backdrop lost its blur.');
      assert(!dialog.textContent?.includes('Values at closing'), 'History repeats the whole closing snapshot.');
      assert(![...dialog.querySelectorAll('dt')].some(element => ['Date', 'Category', 'Payer', 'Card', 'Split', 'Source', 'Source file'].includes(element.textContent!)), 'History lists unchanged fields.');
      assert(dialog.textContent?.includes('Original market → Corner market') && dialog.textContent?.includes('100.00 → 120.00'), 'Relevant field differences missing.');
      assert(dialog.textContent?.includes('Alex $60.00 · Sam $40.00 → Alex $72.00 · Sam $48.00'), 'Shares still expose raw identifiers or JSON.');
      assert(dialog.textContent?.includes('edited · Sam') && dialog.querySelector('time')?.textContent, 'Change actor or timestamp missing.');
      const earlier = dialog.querySelector('details')!; earlier.open = true;
      assert(earlier.textContent?.includes('closed · Alex') && earlier.textContent?.includes('approved · Alex'), 'Lifecycle history missing.');
      assert(!dialog.querySelector('input, select, textarea') && !button('Save changes'), 'History inspection exposes mutation controls.');
      if (status === 'settled') assert(!button('Edit Transactions'), 'Paid cycle exposes transaction editing.');
      const originalDisclosure = [...host.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent === 'Values at closing');
      assert(originalDisclosure?.textContent?.includes('Original market') && originalDisclosure.textContent.includes('100.00'), 'Cycle disclosure lost original closing values.');
    });
  }
  for (const dismissal of ['Close expense history', 'Close history', 'Escape', 'outside']) await check(`${dismissal} dismisses closed-cycle history and restores focus`, async () => {
    await selectCycle('closed'); const { dialog, trigger } = await openHistory();
    if (dismissal === 'Escape') flushSync(() => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
    else if (dismissal === 'outside') flushSync(() => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -1, clientY: -1 })));
    else await click(dismissal);
    await tick(); assert(!dialog.isConnected && document.activeElement === trigger, 'Dismissal failed or focus was not restored.');
  });
  await check('history request failure stays in the floating card', async () => {
    historyFailure = true; await selectCycle('settled'); const { dialog } = await openHistory();
    assert(dialog.querySelector('[role="alert"]')?.textContent === 'History temporarily unavailable.', 'History error is hidden.');
    await click('Close history');
  });
  await check('empty event history retains closing differences without inventing events', async () => {
    historyEmpty = true; await selectCycle('closed'); const { dialog } = await openHistory();
    assert(dialog.textContent?.includes('No saved history.') && dialog.textContent.includes('Original market → Corner market'), 'Empty history loses closing differences.');
    assert(!dialog.querySelector('article'), 'Empty history invents an event.');
  });
  assert(writes.length === 0, 'History inspection issued a mutation.');
  document.querySelector('#results')!.textContent = `${output.filter(line => line.startsWith('PASS')).length}/${output.length} passed at ${innerWidth}px\n${output.join('\n')}`;
} else {
  (document.querySelector('#results') as HTMLElement).hidden = true;
  mount(); await selectCycle(query.get('status') === 'settled' ? 'settled' : 'closed');
  if (query.get('history') !== '0') await openHistory();
}
