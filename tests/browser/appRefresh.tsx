import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { api, ApiError } from '../../src/lib/api';
import type { Bootstrap, QueueItem } from '../../src/types';

// Serve with npm run dev and open /tests/browser/appRefresh.html.
// Only API/session I/O is replaced; App, its hooks, children, and DOM remain real.
const session = {
  session: { id: 's1', userId: 'u1', token: 'test-token', expiresAt: '2099-01-01T00:00:00Z', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
  user: { id: 'u1', name: 'Test user', email: 'test@example.com', emailVerified: true, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
};
window.fetch = async () => new Response(JSON.stringify(session), { headers: { 'content-type': 'application/json' } });
const { default: App } = await import('../../src/App');
const row: QueueItem = {
  hasBeenApproved: false, lastEditedAt: null, parentExpenseId: null,
  expenseId: 'expense-test', revision: 1, editedByMemberId: null, editedByName: null, sourceFileId: null, sourceFileName: null, reviewNote: null, splitRuleJson: null, updatedAt: 0,
  id: 'q1', date: '2024-06-09', store: 'Uber', amountCents: 586, category: 'Transport',
  payerId: 'm1', cardId: null, splitType: 'equal', isDuplicate: 0, source: 'csv',
};
const initial: Bootstrap = {
  me: { memberId: 'm1', role: 'owner' },
  household: { id: 'h1', name: 'Test household', currencyCode: 'CAD', timezone: 'America/Vancouver', customCategories: [], currentCycleName: null, rentReminder: true },
  members: [{ id: 'm1', displayName: 'Test user', role: 'owner', sortOrder: 0, archivedAt: null }],
  cards: [], transactions: [], queue: [row, { ...row, id: 'q2', expenseId: 'expense-test-2', store: 'Lyft' }], cycles: [], categoryPreferences: {},
};
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function waitFor(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await tick();
  }
  throw new Error(message);
}

async function mount() {
  let stored = structuredClone(initial);
  let first = true;
  const requests: Array<{ snapshot: Bootstrap; resolve: () => void; reject: (error: Error) => void }> = [];
  const confirmations: Array<{ id: string; date: string }> = [];
  api.bootstrap = () => {
    if (first) { first = false; return Promise.resolve(structuredClone(stored)); }
    const snapshot = structuredClone(stored);
    return new Promise<Bootstrap>((resolve, reject) => requests.push({ snapshot, resolve: () => resolve(snapshot), reject }));
  };
  api.updateQueueItem = async (id, patch) => {
    const date = (patch as { date: string | null }).date;
    stored = { ...stored, queue: stored.queue.map((item) => item.id === id ? { ...item, date, revision: item.revision + 1 } : item) };
    return stored.queue.find((item) => item.id === id)!;
  };
  api.confirmQueueItem = async (id, _transactionId, input) => {
    confirmations.push({ id, date: (input as { date: string }).date });
    return {} as Awaited<ReturnType<typeof api.confirmQueueItem>>;
  };
  api.groups = async () => ({ groups: [{ id: 'h1', name: 'Test household', role: 'owner', memberId: 'm1', peopleCount: 1, pendingCount: 0 }], canCreate: false });
  api.reminders = async () => [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<App />));
  const rowFor = (store: string) => [...host.querySelectorAll('li')].find((row) => row.querySelector<HTMLInputElement>('input[aria-label="Store"]')?.value === store);
  const dates = () => ['Uber', 'Lyft'].flatMap((store) => { const input = rowFor(store)?.querySelector<HTMLInputElement>('input[aria-label="Date"]'); return input ? [input] : []; });
  await waitFor(() => dates().length === 2, `App did not load: ${host.textContent}`);
  const change = (index: number, value: string) => flushSync(() => {
    const input = dates()[index];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const confirms = () => ['Uber', 'Lyft'].map((store) => rowFor(store)!.querySelector<HTMLButtonElement>('button[aria-label="Approve"]')!);
  const save = (index: number) => flushSync(() => { dates()[index].focus(); dates()[index].blur(); });
  const all = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Approve All')!;
  return {
    host, dates, confirms, all, requests, confirmations, change, save,
    focus: () => window.dispatchEvent(new Event('focus')),
    close: async () => {
      root.unmount();
      for (let index = 0; index < requests.length; index++) { requests[index].resolve(); await tick(); }
      host.remove();
    },
  };
}

const results: string[] = [];
async function check(name: string, test: (view: Awaited<ReturnType<typeof mount>>) => Promise<void>) {
  let view: Awaited<ReturnType<typeof mount>> | undefined;
  try { view = await mount(); await test(view); results.push(`PASS ${name}`); }
  catch (error) { results.push(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
  finally { await view?.close(); }
}

for (const date of ['2024-06-11', '']) {
  await check(`serialized concurrent saves preserve ${date || 'cleared date'}`, async (view) => {
    view.change(0, '2024-06-10'); view.save(0);
    await waitFor(() => view.requests.length === 1, 'First date refresh did not start');
    view.change(1, date); view.save(1); await tick();
    assert(view.requests.length === 1, 'Later refresh must wait for the earlier response');
    assert(!view.dates()[0].disabled && !view.dates()[1].disabled, 'Autosave must retain typing during refresh');
    view.requests[0].resolve();
    await waitFor(() => view.requests.length === 2, 'Second refresh did not start after the first');
    assert(view.requests[1].snapshot.queue[1].date === (date || null), 'Later request must capture the latest date');
    assert(view.host.textContent?.includes('Saving…'), 'Second save must await its own response');
    view.requests[1].resolve();
    await waitFor(() => !view.host.textContent?.includes('Saving…'), 'Second save did not finish');
    assert(view.dates()[0].value === '2024-06-10' && view.dates()[1].value === date, 'Displayed dates must retain the newer snapshot');
    flushSync(() => view.confirms()[1].click()); await tick();
    if (date) assert(view.confirmations[0]?.date === '2024-06-11', 'Confirmation must use the edited date');
    else {
      assert(view.confirmations.length === 0, 'A cleared date must never be sent for confirmation');
      assert(view.host.textContent?.includes('Fill in date, store, amount, category, payer and split'), 'Missing date must retain its warning');
    }
  });
}
await check('date save waits behind an older focus refresh', async (view) => {
  view.focus(); await waitFor(() => view.requests.length === 1, 'Focus refresh did not start');
  view.change(0, '2024-06-10'); view.save(0); await tick();
  assert(view.requests.length === 1, 'Save refresh must queue behind focus refresh');
  view.requests[0].resolve(); await waitFor(() => view.requests.length === 2, 'Save refresh did not start');
  assert(view.dates()[0].value === '2024-06-10' && view.host.textContent?.includes('Saving…'), 'Older refresh must retain pending save');
  view.requests[1].resolve(); await waitFor(() => !view.host.textContent?.includes('Saving…'), 'Date save did not finish');
  assert(view.dates()[0].value === '2024-06-10', 'Own refresh must install the edited date');
});
for (const error of [new Error('Bootstrap failed'), new ApiError(401, 'Signed out')]) {
  await check(`refresh queue recovers after ${error.message}`, async (view) => {
    view.focus(); await waitFor(() => view.requests.length === 1, 'First focus refresh did not start');
    view.focus(); await tick();
    assert(view.requests.length === 1, 'Recovery refresh must wait behind the failed request');
    view.requests[0].reject(error); await waitFor(() => view.requests.length === 2, 'Queued refresh must start after a failure');
    await tick();
    if (error instanceof ApiError) assert(view.dates().length === 0 && view.host.textContent?.includes('Loading'), '401 must clear the loaded data');
    else assert(view.host.textContent?.includes('Bootstrap failed'), 'Ordinary failure must preserve the load-error message');
    view.requests[1].resolve(); await waitFor(() => view.dates().length === 2, 'Successful queued refresh must recover the dashboard');
    assert(!view.host.textContent?.includes('Bootstrap failed'), 'Successful refresh must clear the prior error');
  });
}
document.getElementById('result')!.textContent = `${results.filter((result) => result.startsWith('PASS')).length}/${results.length} passed\n${results.join('\n')}`;
