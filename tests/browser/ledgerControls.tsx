import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import TransactionList from '../../src/components/TransactionList';
import { api } from '../../src/lib/api';
import type { Transaction, QueueItem, Member, TxPatch } from '../../src/types';
import '../../src/index.css';

if (new URLSearchParams(location.search).has('zoom')) document.documentElement.style.zoom = '2';
const members: Member[] = [
  { id: 'm1', displayName: 'Alex', role: 'owner', sortOrder: 0, archivedAt: null },
  { id: 'm2', displayName: 'Sam with a long household name', role: 'member', sortOrder: 1, archivedAt: null },
];
const transaction: Transaction = {
  id: 't1', expenseId: 'e1', revision: 1, hasBeenApproved: true, lastEditedAt: null, parentExpenseId: null,
  date: '2026-10-01', store: 'A long grocery store label', amountCents: 1234567, category: 'Groceries',
  payerId: 'm1', cardId: 'c1', splitType: 'custom', splitRuleJson: '{"percentages":{"m1":60,"m2":40}}',
  splitSharesJson: '{"m1":740740,"m2":493827}', cycleId: null, cardNameSnapshot: 'Visa',
  source: 'csv', sourceFileId: 'f1', sourceFileName: 'A long statement filename October 2026.csv',
  editedByMemberId: null, editedByName: null, updatedAt: 0, reviewNote: null, isStarred: 0, favoriteName: null,
};
api.expenseHistory = async expenseId => [{
  id: 'history-demo', expenseId, eventType: 'edited', actorMemberId: 'm1', actorName: 'Alex',
  timestamp: 1760000000000, reviewNote: null,
  before: { ...transaction, state: 'approved', store: 'Original merchant' },
  after: { ...transaction, state: 'approved', revision: 2 },
}];
const queued: QueueItem = { ...transaction, id: 'q1', expenseId: 'e2', hasBeenApproved: false, isDuplicate: 0,
  category: 'Utilities with a long category label' };
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
const output: string[] = [];
const allocationWrites: string[] = [];
const splitWrites: Array<TxPatch['splitRule']> = [];
const starCalls: Array<{ id: string; starred: boolean; revision: number }> = [];
const breakdownWrites: string[] = [];
const deletionCalls: Array<{ kind: string; ids: string[]; revisions: Record<string, number> }> = [];
let finishDeletion: (() => void) | undefined;
const moveCalls: Array<{ item: Transaction; note?: string }> = [];
let finishMove: (() => void) | undefined;
let finishBreakdown: (() => void) | undefined;
const host = document.querySelector('#fixture') as HTMLDivElement;
let mode: (value: 'pending' | 'approved') => void;
function Fixture({ readOnly = false, refund = false, five = false, edited = false, demo = false, deferBreakdown = false, deferMove = false, deferDelete = false, deleteFailure = false, duplicate = false, moveFailure = false }: { readOnly?: boolean; refund?: boolean; five?: boolean; edited?: boolean; demo?: boolean; deferBreakdown?: boolean; deferMove?: boolean; deferDelete?: boolean; deleteFailure?: boolean; duplicate?: boolean; moveFailure?: boolean }) {
  const [stage, setStage] = useState<'pending' | 'approved'>(demo && new URLSearchParams(location.search).get('stage') === 'approved' ? 'approved' : 'pending'); mode = setStage;
  const [filters, setFilters] = useState(['', '', '', '', '']);
  const moveFailed = useRef(false);
  const setter = (index: number) => (value: string) => setFilters(current => current.map((entry, i) => i === index ? value : entry));
  const amountCents = refund ? -1234567 : 1234567;
  const [demoTransaction, setDemoTransaction] = useState({ ...transaction, lastEditedAt: edited ? 1760000000000 : null, editedByName: edited ? 'Alex' : null });
  const [demoQueue, setDemoQueue] = useState(queued);
  const deleteFixture = async (kind: string, ids: string[], revisions: Record<string, number>) => {
    deletionCalls.push({ kind, ids, revisions });
    if (deferDelete) await new Promise<void>(resolve => { finishDeletion = resolve; });
    if (deleteFailure) throw new Error('Deletion failed.');
  };
  const roster = five ? [...members, ...['Taylor', 'Morgan', 'Robin'].map((displayName, index) => ({ ...members[1], id: `m${index + 3}`, displayName, sortOrder: index + 2 }))] : members;
  return <TransactionList mode={stage} readOnly={readOnly} members={roster}
    transactions={[demo ? demoTransaction : { ...transaction, amountCents, lastEditedAt: edited ? 1760000000000 : null }]} pendingItems={[demo ? demoQueue : { ...queued, amountCents, isDuplicate: duplicate ? 1 : 0, lastEditedAt: edited ? 1760000000000 : null }]}
    cards={[{ id: 'c1', memberId: 'm1', name: 'Visa with a long card name', archived: 0, sortOrder: 0, statementDay: null, historyName: null, historyStatementDay: null, historyAppliedAt: null }]}
    categories={['Groceries', 'Utilities with a long category label']}
    filterDateStart={filters[0]} setFilterDateStart={setter(0)} filterDateEnd={filters[1]} setFilterDateEnd={setter(1)}
    filterCategory={filters[2]} setFilterCategory={setter(2)} filterPayerId={filters[3]} setFilterPayerId={setter(3)}
    filterCardId={filters[4]} setFilterCardId={setter(4)}
    onDelete={async (id, revision) => deleteFixture('approved', [id], { [id]: revision })}
    onQueueDelete={async (id, revision) => deleteFixture('pending', [id], { [id]: revision })}
    onQueueDeleteMany={async (ids, revisions) => deleteFixture('bulk', ids, revisions)}
    onApprove={async () => transaction}
    onQueueUpdate={async (_id, patch, revision) => {
      allocationWrites.push('pending'); splitWrites.push(patch.splitRule); if (!demo) return queued;
      const { splitRule, isDuplicate, ...fields } = patch;
      const next = { ...demoQueue, ...fields, revision: revision + 1,
        ...(splitRule !== undefined ? { splitRuleJson: splitRule === null ? null : JSON.stringify(splitRule) } : {}),
        ...(isDuplicate !== undefined ? { isDuplicate: Number(isDuplicate) } : {}) };
      setDemoQueue(next); return next;
    }}
    onUpdate={async (_id, patch, revision) => {
      allocationWrites.push('approved'); splitWrites.push(patch.splitRule); if (patch.isStarred !== undefined) starCalls.push({ id: _id, starred: patch.isStarred, revision }); if (!demo) return transaction;
      const { splitRule, isStarred, ...fields } = patch;
      const next = { ...demoTransaction, ...fields, revision: revision + 1,
        ...(splitRule !== undefined ? { splitRuleJson: splitRule === null ? null : JSON.stringify(splitRule) } : {}),
        ...(isStarred !== undefined ? { isStarred: Number(isStarred) } : {}) };
      setDemoTransaction(next); return next;
    }}
    onBreakdown={async () => { breakdownWrites.push('approved'); if (deferBreakdown) await new Promise<void>(resolve => { finishBreakdown = resolve; }); return { original: transaction, separated: transaction }; }}
    onQueueBreakdown={async () => { breakdownWrites.push('pending'); if (deferBreakdown) await new Promise<void>(resolve => { finishBreakdown = resolve; }); return { original: queued, separated: queued }; }} onReturnToPending={async (item, note) => { moveCalls.push({ item, note }); if (moveFailure && !moveFailed.current) { moveFailed.current = true; throw new Error('Move failed.'); } if (deferMove) await new Promise<void>(resolve => { finishMove = resolve; }); return queued; }} />;
}
const root = createRoot(host);
const field = (label: string) => (host.querySelector(`[aria-label="${label}"]`) ?? document.querySelector(`.ledger-bulk-portal [aria-label="${label}"]`)) as HTMLInputElement;
const buttons = (label: string) => [...host.querySelectorAll('button'), ...document.querySelectorAll<HTMLButtonElement>('.ledger-bulk-portal button')].filter(button => button.getAttribute('aria-label') === label || button.textContent?.trim() === label);
const click = async (label: string) => { const element = buttons(label)[0] ?? field(label); assert(element, `Missing ${label}`); flushSync(() => element.click()); await tick(); };
const openTransactionBreakdown = async () => {
  await click('Break down A long grocery store label');
  for (let attempt = 0; attempt < 8; attempt++) {
    const dialog = host.querySelector('.ledger-breakdown-region') as HTMLDialogElement | null;
    if (dialog?.open && dialog.matches(':modal')) return;
    await tick();
  }
  throw new Error('Transaction breakdown did not enter the top layer');
};
const change = async (label: string, value: string) => {
  const element = field(label); assert(element, `Missing ${label}`);
  const proto = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  flushSync(() => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });
  await tick();
};
const box = (element: { getBoundingClientRect: () => DOMRect }) => {
  const { x, y, width, height } = element.getBoundingClientRect(); return [x, y, width, height];
};
const common = () => [
  ...host.querySelectorAll('.compact-ledger > div:first-child input, .compact-ledger > div:first-child select, .ledger-color-modes, .ledger-legend, .ledger-selection, .ledger-header button[aria-label="Show filters"], .ledger-header button[aria-label="Show details"], .ledger-header button[aria-label="Hide details"], .ledger-header button[aria-label="Clear filters"]'),
  ...host.querySelectorAll('.ledger-file, .ledger-columns, .ledger-entry > .ledger-grid > .ledger-pick, .ledger-entry > .ledger-grid > .ledger-date, .ledger-entry > .ledger-grid > .ledger-store-cell, .ledger-entry > .ledger-grid > .ledger-category, .ledger-entry > .ledger-grid > .ledger-amount, .ledger-entry > .ledger-grid > .ledger-split'),
];
const aligned = (before: number[][], after: number[][]) => {
  assert(before.length === after.length, 'Shared header/file/row controls missing in one stage');
  before.forEach((values, index) => values.forEach((value, part) =>
    assert(Math.abs(value - after[index][part]) <= 0.5, `Stage geometry shifted control ${index} part ${part}: ${value} → ${after[index][part]}`)));
};
const fits = () => {
  assert(document.documentElement.scrollWidth <= innerWidth, 'Horizontal page overflow');
  for (const element of [...host.querySelectorAll('input, select, button'), ...document.querySelectorAll('.ledger-bulk-portal input, .ledger-bulk-portal select, .ledger-bulk-portal button')]) {
    const rect = element.getBoundingClientRect(); if (!rect.width || !rect.height) continue;
    assert(rect.left >= 0 && rect.right <= innerWidth + 0.5, `Control outside viewport: ${element.getAttribute('aria-label') || element.textContent}`);
  }
};
async function check(name: string, test: () => Promise<void>, options: { readOnly?: boolean; refund?: boolean; five?: boolean; edited?: boolean; deferBreakdown?: boolean; deferMove?: boolean; deferDelete?: boolean; deleteFailure?: boolean; duplicate?: boolean; moveFailure?: boolean } = {}) {
  const query = new URLSearchParams(location.search);
  if (query.get('only') === 'bulk-actions' && !name.startsWith('bulk actions')) return;
  if (query.get('only') === 'bulk-style' && !name.startsWith('bulk style')) return;
  if (query.get('only') === 'bulk-toolbar' && !name.startsWith('bulk toolbar')) return;
  if (query.get('only') === 'delete' && !name.startsWith('delete modal')) return;
  if (query.get('only') === 'edited-note' && !name.startsWith('history/move edited note')) return;
  if (query.get('only') === 'history-move' && !name.startsWith('history/move')) return;
  if (query.get('only') === 'member-color' && !name.startsWith('all five selected member')) return;
  if (query.get('demo') === '1' || (query.get('only') === 'breakdown' && !name.startsWith('transaction breakdown') && !name.startsWith('stacked split previews'))) return;
  flushSync(() => root.render(null)); flushSync(() => root.render(<Fixture {...options} />)); await tick();
  try { await test(); output.push(`PASS ${name}`); }
  catch (error) { output.push(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
}
await check('bulk actions hide menu labels and match Current Cycle button colors', async () => {
  flushSync(() => mode('approved')); await tick(); await click('Select all visible expenses');
  for (const select of document.querySelectorAll('.ledger-bulk-fields>select')) {
    const placeholder = select.querySelector('option[value=""]') as HTMLOptionElement;
    assert(placeholder.hidden && placeholder.disabled, 'Feature name remains selectable in dropdown');
  }
  const reference = document.createElement('button'); reference.className = 'bg-indigo-600'; document.body.appendChild(reference);
  try { for (const label of ['Save selected']) assert(getComputedStyle(buttons(label)[0]).backgroundColor === getComputedStyle(reference).backgroundColor, `${label} differs from Current Cycle trigger`); }
  finally { reference.remove(); }
  const actions = document.querySelector('.ledger-bulk-actions')!;
  assert([...actions.children].map(button => button.getAttribute('aria-label')).join('|') === 'Move selected to Pending|Star selected expenses|Delete selected|Save selected|Clear selection', 'Toolbar actions out of order');
  assert(buttons('Clear selection')[0].querySelector('svg.lucide-x') && !buttons('Clear selection')[0].textContent?.trim(), 'Clear is not close icon');
  assert(Math.abs(actions.getBoundingClientRect().right - document.querySelector('.ledger-bulk-portal')!.getBoundingClientRect().right + 11) < 2, 'Actions not right aligned');
  for (const label of ['Move selected to Pending', 'Star selected expenses', 'Delete selected']) assert(buttons(label)[0]?.querySelector('svg'), `${label} is not an icon action`);
});
await check('bulk actions expose star and move only for Approved and preserve star revision', async () => {
  await click('Select all visible expenses'); assert(!buttons('Move selected to Pending').length && !buttons('Star selected expenses').length, 'Pending exposes Approved-only actions');
  flushSync(() => mode('approved')); await tick(); await click('Select all visible expenses'); const before = starCalls.length;
  await click('Star selected expenses'); await tick();
  assert(starCalls.length === before + 1 && starCalls[before].id === 't1' && starCalls[before].revision === 1 && starCalls[before].starred, 'Bulk star changed revision, id or intended state');
});
await check('bulk actions keep star disabled for unsaved row drafts', async () => {
  flushSync(() => mode('approved')); await tick(); await change('Store', 'Unsaved merchant'); await click('Select all visible expenses');
  assert(buttons('Star selected expenses')[0].disabled, 'Bulk star bypasses unsaved draft guard');
});
await check('bulk actions reuse move confirmation and retain failed selection for retry', async () => {
  flushSync(() => mode('approved')); await tick(); await click('Select all visible expenses');
  const trigger = buttons('Move selected to Pending')[0]; trigger.focus(); await click('Move selected to Pending');
  const dialog = host.querySelector('.ledger-move-dialog') as HTMLDialogElement; assert(dialog.open && dialog.matches(':modal'), 'Bulk move did not reuse floating confirmation');
  await change('Review note', 'Check bulk receipt'); const before = moveCalls.length; await click('Move selected expenses'); await tick();
  assert(dialog.open && dialog.querySelector('[role="alert"]')?.textContent?.includes('Move failed.') && field('Select all visible expenses').checked, 'Failed bulk move closed dialog or lost selection');
  await click('Move selected expenses'); await tick(); await tick();
  assert(moveCalls.length === before + 2 && moveCalls[before + 1].note === 'Check bulk receipt' && moveCalls[before + 1].item.id === 't1', 'Bulk move retry changed note, target or call count');
  assert(!host.querySelector('.ledger-move-dialog'), 'Successful bulk move left dialog open');
}, { moveFailure: true });
await check('bulk style stays dark blue with bounded single-line controls', async () => {
  await click('Select all visible expenses'); await tick(); await tick();
  const toolbar = document.querySelector('.ledger-bulk-portal') as HTMLElement;
  assert(getComputedStyle(toolbar).backgroundColor === 'rgb(15, 23, 42)', 'Toolbar differs from Current Cycle dark blue');
  const controls = [...toolbar.querySelectorAll('.ledger-bulk-fields>select,.ledger-bulk-actions>button')];
  const centers = controls.map(control => { const rect = control.getBoundingClientRect(); return rect.top + rect.height / 2; });
  assert(centers.every(center => Math.abs(center - centers[0]) <= 0.5), 'Bulk controls wrap onto more than one line');
  assert([...toolbar.querySelectorAll('.ledger-bulk-fields>select')].every(select => select.getBoundingClientRect().width <= 120), 'Bulk dropdowns are not bounded');
  assert(field('Set split for selected expenses') && !buttons('Set bulk split').length, 'Split action did not become a dropdown');
});
await check('bulk style equal and member choices update Approved drafts without saving', async () => {
  flushSync(() => mode('approved')); await tick(); await click('Select all visible expenses');
  const writesBefore = allocationWrites.length; await change('Set split for selected expenses', 'equal');
  assert(buttons('Split A long grocery store label equally')[0].getAttribute('aria-pressed') === 'true', 'Bulk equal did not stage row allocation');
  await change('Set split for selected expenses', 'm2');
  assert(buttons('Assign A long grocery store label to Sam with a long household name')[0].getAttribute('aria-pressed') === 'true', 'Bulk member did not stage row allocation');
  assert(allocationWrites.length === writesBefore && buttons('Save selected').length, 'Bulk split bypassed Approved explicit Save');
});
await check('bulk style Custom reuses floating allocation validation and stages a valid split', async () => {
  flushSync(() => mode('approved')); await tick(); await click('Select all visible expenses');
  const trigger = field('Set split for selected expenses'); trigger.focus(); await change('Set split for selected expenses', 'custom');
  const dialog = document.querySelector('[aria-label="Custom allocation for selected expenses"]') as HTMLDialogElement;
  assert(dialog?.open && dialog.matches(':modal') && getComputedStyle(dialog, '::backdrop').backdropFilter.includes('blur'), 'Bulk custom allocation is not the shared floating card');
  const writesBefore = allocationWrites.length; await change('Alex percentage', '');
  flushSync(() => field('Alex percentage').dispatchEvent(new FocusEvent('focusout', { bubbles: true }))); await tick();
  assert(buttons('Save allocation')[0].disabled && dialog.querySelector('[role="alert"]'), 'Bulk custom validation accepted a blank percentage');
  await change('Alex percentage', '70'); await change('Sam with a long household name percentage', '30'); await click('Save allocation');
  assert(!dialog.isConnected && document.activeElement === trigger, 'Bulk custom Save did not close and restore dropdown focus');
  assert(buttons('Custom split for A long grocery store label')[0].title.includes('70%'), 'Bulk custom Save did not stage percentages');
  assert(allocationWrites.length === writesBefore, 'Bulk custom Save persisted an Approved draft');
});
await check('bulk style Custom dismissal discards allocation without changing rows', async () => {
  await click('Select all visible expenses'); const before = allocationWrites.length;
  await change('Set split for selected expenses', 'custom'); await change('Alex percentage', '20'); await click('Cancel allocation');
  assert(!document.querySelector('[aria-label="Custom allocation for selected expenses"]') && allocationWrites.length === before, 'Bulk custom dismissal saved a draft');
  await change('Set split for selected expenses', 'custom'); assert(field('Alex percentage').value === '50', 'Bulk custom reopen retained dismissed values'); await click('Cancel allocation');
});
await check('bulk toolbar follows the ledger width and stays at viewport bottom while scrolling', async () => {
  assert(!document.querySelector('.ledger-bulk-portal'), 'Toolbar visible without selection');
  await click('Select all visible expenses'); await tick(); await tick();
  const toolbar = document.querySelector('.ledger-bulk-portal') as HTMLElement, ledger = host.querySelector('.compact-ledger')!;
  assert(toolbar?.parentElement === document.body && getComputedStyle(toolbar).position === 'fixed', 'Toolbar is not fixed outside ledger container');
  for (const label of ['Set category for selected expenses', 'Set payer for selected expenses', 'Set card for selected expenses']) assert(field(label), `Toolbar lost ${label}`);
  assert(field('Set split for selected expenses') && buttons('Approve selected').length && buttons('Delete selected').length && buttons('Clear selection').length, 'Toolbar lost existing actions');
  const alignedToolbar = () => {
    const actual = toolbar.getBoundingClientRect(), expected = ledger.getBoundingClientRect();
    assert(Math.abs(actual.left - expected.left) <= 0.5 && Math.abs(actual.width - expected.width) <= 0.5, 'Toolbar does not match ledger left/width');
    assert(Math.abs(innerHeight - actual.bottom - 12) <= 1, 'Toolbar is not anchored to viewport bottom');
  };
  alignedToolbar();
  const oldWidth = host.style.width, oldMargin = host.style.marginTop;
  try {
    host.style.width = `${Math.min(innerWidth - 24, 600)}px`; host.style.marginTop = '800px';
    await tick(); await tick(); alignedToolbar();
    window.scrollTo(0, 600); await tick(); alignedToolbar();
    const spacer = host.querySelector('.ledger-bulk-spacer')!;
    assert(spacer.getBoundingClientRect().height >= toolbar.getBoundingClientRect().height + 24, 'Toolbar has no space reserved for final rows');
    window.scrollTo(0, document.documentElement.scrollHeight); await tick();
    const last = host.querySelector('.ledger-entry')!;
    assert(last.getBoundingClientRect().bottom <= toolbar.getBoundingClientRect().top, 'Toolbar obscures final ledger row at bottom');
    assert(toolbar.getBoundingClientRect().height < 90 && getComputedStyle(toolbar).overflowX === 'auto', 'Compact toolbar lost horizontal scrolling');
  } finally { host.style.width = oldWidth; host.style.marginTop = oldMargin; window.scrollTo(0, 0); }
  await click('Clear selection'); assert(!document.querySelector('.ledger-bulk-portal'), 'Clearing selection left toolbar visible');
});
await check('bulk toolbar retains native bulk delete modal after portal', async () => {
  await click('Select all visible expenses'); await tick(); await click('Delete selected');
  const dialog = document.querySelector('.ledger-delete-dialog') as HTMLDialogElement;
  assert(dialog?.open && dialog.matches(':modal'), 'Portalled bulk deletion is not a native modal');
  const before = deletionCalls.length; await click('Cancel deletion');
  assert(!dialog.isConnected && deletionCalls.length === before && document.activeElement === buttons('Delete selected')[0], 'Portalled bulk delete dismissal changed data or focus');
});
await check('bulk toolbar keeps read-only split icons equally dim and custom details inspectable', async () => {
  flushSync(() => mode('approved')); await tick();
  assert(!document.querySelector('.ledger-bulk-portal'), 'Read-only ledger exposes a bulk toolbar');
  const split = host.querySelector('.ledger-split[data-read-only]')!;
  assert(split && [...split.querySelectorAll('button')].every(button => getComputedStyle(button).opacity === '0.45'), 'Read-only split icons have different opacity');
  const custom = buttons('Custom split for A long grocery store label')[0]; assert(!custom.disabled, 'Read-only inspection disabled');
  custom.focus(); await tick(); assert(getComputedStyle(custom.querySelector('[role="tooltip"]')!).visibility === 'visible', 'Read-only allocation tooltip hidden');
  await click('Custom split for A long grocery store label');
  assert((host.querySelector('.ledger-allocation-dialog') as HTMLDialogElement).open && host.textContent?.includes('60%'), 'Read-only custom details did not open');
  assert(!buttons('Save allocation').length, 'Read-only custom details expose Save'); await click('Close allocation');
}, { readOnly: true });
await check('display controls precede filters with a labelled clear action and visible result count', async () => {
  const details = buttons('Show details')[0], from = field('Filter date from'), clear = buttons('Clear filters')[0];
  assert(details.textContent?.includes('payer') && clear.textContent?.includes('Clear filters'), 'Display or clear action is icon-only');
  assert(details.getBoundingClientRect().bottom <= from.getBoundingClientRect().top, 'Display controls follow filters');
  assert(clear.getBoundingClientRect().top >= from.getBoundingClientRect().bottom, 'Clear action is not below filters');
  assert(host.textContent?.includes('1 of 1 expenses'), 'Filtered result count missing');
  await change('Filter category', 'Groceries');
  assert(host.textContent?.includes('0 of 1 expenses'), 'Filtered result count did not update');
  await click('Clear filters'); assert(host.textContent?.includes('1 of 1 expenses'), 'Clear filters did not restore expenses');
});
if (innerWidth >= 800) await check('800px desktop ledger retains one row without overflow', async () => {
  host.style.width = '800px'; await tick();
  try {
    const row = host.querySelector('.ledger-entry > .ledger-grid')!;
    const cells = [...row.children].map(element => element.getBoundingClientRect());
    assert(cells.every(rect => Math.abs(rect.top + rect.height / 2 - (cells[0].top + cells[0].height / 2)) <= 0.5), '800px ledger fell into mobile rows');
    fits();
  } finally { host.style.width = ''; }
});
await check('first-time Pending hides edit metadata while Approved history keeps orange', async () => {
  assert(!host.querySelector('.ledger-edited-note.text-orange-600'), 'First-time Pending exposes edited metadata');
  flushSync(() => mode('approved')); await tick();
  assert(getComputedStyle(buttons('View edit history')[0]).color === 'rgb(234, 88, 12)', 'Edited history icon lost orange');
}, { edited: true });
await check('filters are visible and shared header aligns despite different stage legends', async () => {
  assert(box(field('Filter date from'))[2] > 0, 'Approved demo date filters hidden by default');
  for (const color of ['category', 'payer', 'card', 'none']) {
    await click(color); const before = common().map(box);
    flushSync(() => mode('approved')); await tick(); aligned(before, common().map(box)); fits();
    flushSync(() => mode('pending')); await tick();
  }
});
await check('selected toolbar and row geometry align between stages', async () => {
  await click('Show filters'); await click('Show filters');
  await click('Select all visible expenses'); const before = common().map(box);
  assert(!field('Select all visible expenses').closest('.bg-blue-50'), 'Selection remains in decorative blue card');
  flushSync(() => mode('approved')); await tick(); assert(!field('Select all visible expenses').checked, 'Stage selection leaked');
  await click('Select all visible expenses'); aligned(before, common().map(box)); fits();
});
await check('selection clears after filtering and never includes hidden expenses', async () => {
  await click('Select all visible expenses'); await change('Filter category', 'Groceries');
  assert(!field('Select all visible expenses') || !field('Select all visible expenses').checked, 'Filter retained hidden selection');
  assert(!buttons('Approve selected').length, 'Hidden row remained actionable');
});
await check('selected person has readable white letter and white underline', async () => {
  flushSync(() => mode('approved')); await tick(); await click('Assign A long grocery store label to Alex');
  const selected = buttons('Assign A long grocery store label to Alex')[0];
  const style = getComputedStyle(selected), line = getComputedStyle(selected.querySelector('.ledger-split-line')!);
  assert(style.color === 'rgb(255, 255, 255)' && line.backgroundColor === 'rgb(255, 255, 255)', 'Selected letter/underline are not white');
  assert(style.backgroundColor !== 'rgb(239, 246, 255)', 'Selected person still uses generic selection blue'); fits();
});
await check('equal and custom selections use approved colors with white icons and underlines', async () => {
  flushSync(() => mode('approved')); await tick();
  for (const [label, background] of [['Custom split for A long grocery store label', 'rgb(124, 58, 237)'], ['Split A long grocery store label equally', 'rgb(51, 65, 85)']]) {
    if (label.startsWith('Split')) await click(label);
    const selected = buttons(label)[0], style = getComputedStyle(selected);
    assert(style.backgroundColor === background && style.color === 'rgb(255, 255, 255)', 'Equal/custom selected icon lost its approved colors');
    assert(getComputedStyle(selected.querySelector('.ledger-split-line')!).backgroundColor === 'rgb(255, 255, 255)', 'Equal/custom selected underline is not white');
  }
  const custom = buttons('Custom split for A long grocery store label')[0];
  assert(getComputedStyle(custom.querySelector('.ledger-split-line')!).backgroundColor === 'rgb(124, 58, 237)', 'Unselected custom underline lost purple');
});
await check('custom allocation tooltip shows saved percentages on keyboard focus', async () => {
  const trigger = buttons('Custom split for A long grocery store label')[0]; trigger.focus(); await tick();
  const tooltip = trigger.querySelector('[role="tooltip"]')!;
  assert(getComputedStyle(tooltip).visibility === 'visible' && tooltip.textContent?.includes('60%') && tooltip.textContent?.includes('40%'), 'Visible allocation tooltip missing');
});
await check('custom split by item amounts previews the full bill and saves proportional percentages', async () => {
  await click('Custom split for A long grocery store label'); await click('Item amounts ($)');
  const dialog = host.querySelector('dialog') as HTMLDialogElement;
  assert(!field('Alex percentage') && field('Alex amount').value === '', 'Amount mode did not replace percentage fields');
  await change('Alex amount', '40'); await change('Sam with a long household name amount', '25');
  assert(dialog.textContent?.includes('Subtotal$65.00'), 'Amount mode subtotal missing');
  // $12345.67 split 40:25.
  assert(dialog.textContent?.includes('pays $7597.34') && dialog.textContent?.includes('pays $4748.33'), 'Amount mode share preview missing');
  await click('Percentage (%)'); assert(field('Alex percentage').value === '60', 'Switching back lost percentages');
  await click('Item amounts ($)'); assert(field('Alex amount').value === '40', 'Switching modes lost amounts');
  await change('Alex amount', '-5');
  flushSync(() => field('Alex amount').dispatchEvent(new FocusEvent('focusout', { bubbles: true }))); await tick();
  assert(buttons('Save allocation')[0].disabled && dialog.querySelector('[role="alert"]'), 'Amount mode accepted a negative amount');
  await change('Alex amount', '40'); await click('Save allocation');
  if (buttons('Save changes').length) await click('Save changes');
  await tick();
  const percentages = splitWrites.at(-1)?.percentages;
  assert(percentages && Math.abs(percentages.m1 - 4000 / 65) < 1e-9 && percentages.m1 + percentages.m2 === 100, `Wrong saved percentages: ${JSON.stringify(percentages)}`);
});
for (const stage of ['pending', 'approved'] as const) for (const dismissal of ['Close custom split', 'Cancel allocation', 'Escape', 'outside']) await check(`${stage} custom modal ${dismissal} discards only allocation drafts without saving`, async () => {
  flushSync(() => mode(stage)); await tick(); await change('Store', 'Merchant draft');
  const trigger = buttons('Custom split for Merchant draft')[0]; trigger.focus(); await click('Custom split for Merchant draft');
  const dialog = host.querySelector('dialog') as HTMLDialogElement;
  assert(dialog?.open && dialog.matches(':modal'), 'Custom split is not in the top layer');
  assert(getComputedStyle(dialog).backgroundColor === 'rgb(255, 255, 255)' && dialog.getBoundingClientRect().width <= 460, 'Custom modal lost white compact card');
  assert(getComputedStyle(dialog, '::backdrop').backdropFilter.includes('blur'), 'Custom modal backdrop is not blurred');
  assert(!dialog.querySelector('[aria-label="Split"]'), 'Custom modal exposes redundant split-type selector');
  const writesBefore = allocationWrites.length;
  field('Alex percentage').focus(); await change('Alex percentage', '20');
  if (dismissal === 'Escape') flushSync(() => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  else if (dismissal === 'outside') flushSync(() => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -1, clientY: -1 })));
  else await click(dismissal);
  await tick();
  assert(!host.querySelector('dialog') && field('Store').value === 'Merchant draft', 'Dismissal removed other edits or left modal open');
  assert(allocationWrites.length === writesBefore, 'Dismissal saved a draft');
  assert(document.activeElement === trigger, 'Dismissal did not restore trigger focus');
  await click('Custom split for Merchant draft'); assert(field('Alex percentage').value === '60', 'Dismissal retained unsaved allocation');
  await click('Cancel allocation');
});
await check('stage switch clears hidden allocation drafts and keeps approval available', async () => {
  await click('Custom split for A long grocery store label'); await change('Alex percentage', '20');
  flushSync(() => mode('approved')); await tick(); flushSync(() => mode('pending')); await tick();
  assert(!buttons('Approve')[0].disabled, 'Hidden allocation draft blocks approval after stage switch');
});
await check('all five selected member backgrounds match their exact user color', async () => {
  flushSync(() => mode('approved')); await tick();
  for (const name of ['Alex', 'Sam with a long household name', 'Taylor', 'Morgan', 'Robin']) {
    await click(`Assign A long grocery store label to ${name}`);
    const selected = buttons(`Assign A long grocery store label to ${name}`)[0];
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d')!;
    context.fillStyle = selected.style.getPropertyValue('--member-color');
    const expected = context.fillStyle;
    context.fillStyle = getComputedStyle(selected).backgroundColor;
    assert(context.fillStyle === expected, `${name} selected background differs from user color`);
    assert(getComputedStyle(selected).color === 'rgb(255, 255, 255)', 'Selected letter is not white');
    assert(getComputedStyle(selected.querySelector('.ledger-split-line')!).backgroundColor === 'rgb(255, 255, 255)', 'Selected underline is not white');
  }
  fits();
}, { five: true });
await check('read-only custom allocation is compact and inspectable on click', async () => {
  flushSync(() => mode('approved')); await tick();
  const trigger = buttons('Custom split for A long grocery store label')[0];
  assert(!trigger.disabled, 'Read-only allocation inspection disabled');
  assert(trigger.title.includes('60%') && trigger.title.includes('40%'), 'Hover/focus allocation details missing');
  await click('Custom split for A long grocery store label');
  assert(host.textContent?.includes('60%') && host.textContent?.includes('40%'), 'Tap failed to reveal allocation');
  assert(!buttons('Save allocation').length && !field('Alex percentage'), 'Read-only details expose mutation controls'); fits();
}, { readOnly: true });
await check('allocation input, inline warning and footer remain separated', async () => {
  flushSync(() => mode('approved')); await tick(); await click('Custom split for A long grocery store label');
  await change('Alex percentage', '');
  flushSync(() => field('Alex percentage').dispatchEvent(new FocusEvent('focusout', { bubbles: true }))); await tick();
  const save = buttons('Save allocation')[0], alert = host.querySelector('[role="alert"]')!;
  assert(save.disabled && field('Alex percentage').value === '', 'Blank allocation accepted or replaced');
  assert(alert.getBoundingClientRect().bottom <= save.getBoundingClientRect().top, 'Allocation warning overlaps Save');
  for (const input of host.querySelectorAll('input[aria-label$="percentage"]'))
    assert(input.getBoundingClientRect().bottom <= alert.getBoundingClientRect().top, 'Allocation fields overlap footer');
  await click('Cancel allocation'); assert(!field('Alex percentage'), 'Cancel left editor open'); fits();
});
for (const kind of ['single', 'bulk'] as const) for (const dismissal of ['X', 'Cancel', 'Escape', 'outside']) await check(`delete modal ${kind} ${dismissal} preserves expenses and restores focus`, async () => {
  if (kind === 'bulk') await click('Select all visible expenses');
  const label = kind === 'bulk' ? 'Delete selected' : 'Delete A long grocery store label', trigger = buttons(label)[0]; trigger.focus();
  await click(label); const dialog = document.querySelector('.ledger-delete-dialog') as HTMLDialogElement;
  for (let attempt = 0; attempt < 8 && !dialog.open; attempt++) await tick();
  assert(dialog.open && dialog.matches(':modal'), 'Deletion is not a floating modal');
  assert(getComputedStyle(dialog).backgroundColor === 'rgb(255, 255, 255)' && getComputedStyle(dialog, '::backdrop').backdropFilter.includes('blur'), 'Deletion lost white card or blur');
  const before = deletionCalls.length;
  if (dismissal === 'Escape') flushSync(() => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  else if (dismissal === 'outside') flushSync(() => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -1, clientY: -1 })));
  else await click(dismissal === 'X' ? (kind === 'bulk' ? 'Close bulk deletion' : 'Close deletion') : 'Cancel deletion');
  await tick(); assert(!dialog.isConnected && deletionCalls.length === before, 'Dismissal left card open or deleted an expense');
  assert(document.activeElement === trigger, 'Deletion did not restore trigger focus');
});
await check('delete modal duplicate removal uses the same floating confirmation', async () => {
  const disclosure = host.querySelector('.ledger-duplicate') as HTMLDetailsElement; disclosure.open = true;
  const trigger = buttons('Remove duplicate')[0]; trigger.focus(); await click('Remove duplicate');
  assert((document.querySelector('.ledger-delete-dialog') as HTMLDialogElement).open, 'Duplicate removal did not open deletion card');
  await click('Cancel deletion'); assert(document.activeElement === trigger, 'Duplicate removal did not restore trigger focus');
}, { duplicate: true });
for (const stage of ['pending', 'approved'] as const) for (const kind of ['single', 'bulk'] as const) await check(`delete modal confirmed ${stage} ${kind} preserves identifiers and revision`, async () => {
  flushSync(() => mode(stage)); await tick(); if (kind === 'bulk') await click('Select all visible expenses');
  await click(kind === 'bulk' ? 'Delete selected' : 'Delete A long grocery store label'); const before = deletionCalls.length;
  await click('Confirm delete'); await tick();
  const call = deletionCalls[before], id = stage === 'pending' ? 'q1' : 't1';
  assert(deletionCalls.length === before + 1 && call.ids.length === 1 && call.ids[0] === id && call.revisions[id] === 1, 'Deletion changed identifiers, revisions or call count');
  assert(call.kind === (stage === 'pending' && kind === 'bulk' ? 'bulk' : stage), 'Pending bulk deletion bypassed atomic API');
  assert(!document.querySelector('.ledger-delete-dialog'), 'Successful deletion left confirmation open');
});
for (const kind of ['single', 'bulk'] as const) await check(`delete modal ${kind} blocks dismissal while deleting`, async () => {
  if (kind === 'bulk') await click('Select all visible expenses'); await click(kind === 'bulk' ? 'Delete selected' : 'Delete A long grocery store label');
  await click('Confirm delete'); const dialog = document.querySelector('.ledger-delete-dialog') as HTMLDialogElement;
  assert(buttons('Cancel deletion')[0].disabled, 'Deleting permits button dismissal');
  flushSync(() => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  flushSync(() => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -1, clientY: -1 })));
  await tick(); assert(dialog.open, 'Escape or outside dismissed an active deletion');
  finishDeletion!(); await tick(); await tick(); assert(!document.querySelector('.ledger-delete-dialog'), 'Finished deletion left card open');
}, { deferDelete: true });
for (const kind of ['single', 'bulk'] as const) await check(`delete modal ${kind} keeps failures visible inside the card`, async () => {
  if (kind === 'bulk') await click('Select all visible expenses'); await click(kind === 'bulk' ? 'Delete selected' : 'Delete A long grocery store label');
  await click('Confirm delete'); await tick(); const dialog = document.querySelector('.ledger-delete-dialog') as HTMLDialogElement;
  assert(dialog.open && dialog.querySelector('[role="alert"]')?.textContent?.includes('Deletion failed.'), 'Delete failure is hidden outside the card');
  await click('Cancel deletion');
}, { deleteFailure: true });
await check('history/move edited note keeps its gap and aligns with the date', async () => {
  flushSync(() => mode('approved')); await tick();
  const cell = host.querySelector('.ledger-store-cell')!, note = cell.querySelector('.ledger-edited-note')!;
  assert(note?.textContent?.includes('Edited by'), 'Edited note is outside merchant cell');
  assert(Math.abs(note.getBoundingClientRect().top - field('Store').getBoundingClientRect().bottom - 8) <= 0.5, 'Edited note does not have an 8px gap');
  assert(Math.abs(note.getBoundingClientRect().left - field('Date').getBoundingClientRect().left) <= 0.5, 'Edited note is not aligned with the date');
  if (host.getBoundingClientRect().width > 760) assert(Math.abs(field('Store').getBoundingClientRect().top - field('Date').getBoundingClientRect().top) <= 3, 'Store and date no longer align');
  const orange = document.createElement('span'); orange.className = 'text-orange-600'; host.appendChild(orange);
  try { assert(getComputedStyle(note).color === getComputedStyle(orange).color, 'Edited note lost orange'); }
  finally { orange.remove(); }
}, { edited: true });
for (const kind of ['history', 'move'] as const) for (const dismissal of ['X', 'Cancel', 'Escape', 'outside']) await check(`history/move ${kind} ${dismissal} closes without a write and restores focus`, async () => {
  flushSync(() => mode('approved')); await tick();
  const label = kind === 'history' ? 'View edit history' : 'Move to Pending', trigger = buttons(label)[0];
  trigger.focus(); await click(label);
  const dialog = host.querySelector(kind === 'history' ? '.ledger-history-dialog' : '.ledger-move-dialog') as HTMLDialogElement;
  for (let attempt = 0; attempt < 8 && !dialog.open; attempt++) await tick();
  assert(dialog.open && dialog.matches(':modal'), 'History/move is not in the top layer');
  assert(getComputedStyle(dialog).backgroundColor === 'rgb(255, 255, 255)' && getComputedStyle(dialog, '::backdrop').backdropFilter.includes('blur'), 'History/move lost white card or blurred backdrop');
  const writesBefore = allocationWrites.length, movesBefore = moveCalls.length;
  if (kind === 'move') await change('Review note', 'Discard this note');
  else { await tick(); assert(dialog.textContent?.includes('Original merchant'), 'History stopped rendering saved differences'); }
  if (dismissal === 'Escape') flushSync(() => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  else if (dismissal === 'outside') flushSync(() => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -1, clientY: -1 })));
  else await click(kind === 'history' ? (dismissal === 'X' ? 'Close expense history' : 'Close history') : (dismissal === 'X' ? 'Close move to Pending' : 'Cancel move'));
  await tick(); assert(!dialog.isConnected, 'History/move dismissal left card open');
  assert(document.activeElement === trigger, 'History/move did not restore trigger focus');
  assert(allocationWrites.length === writesBefore && moveCalls.length === movesBefore, 'History/move dismissal wrote an edit');
});
await check('history/move submitting move preserves the note and saved expense', async () => {
  flushSync(() => mode('approved')); await tick(); await click('Move to Pending'); await change('Review note', 'Check receipt');
  const before = moveCalls.length; await click('Move expense'); await tick();
  assert(moveCalls.length === before + 1 && moveCalls[before].note === 'Check receipt', 'Move did not pass the exact review note once');
  assert(moveCalls[before].item.id === 't1' && moveCalls[before].item.amountCents === 1234567, 'Move changed financial values');
  assert(!host.querySelector('.ledger-move-dialog'), 'Successful move left card open');
});
await check('history/move prevents dismissal while moving the expense', async () => {
  flushSync(() => mode('approved')); await tick(); await click('Move to Pending'); await click('Move expense');
  const dialog = host.querySelector('.ledger-move-dialog') as HTMLDialogElement;
  assert(buttons('Close move to Pending')[0].disabled && buttons('Cancel move')[0].disabled, 'Moving expense permits button dismissal');
  flushSync(() => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  flushSync(() => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -1, clientY: -1 })));
  await tick(); assert(dialog.open, 'Escape or outside dismissed a moving expense');
  finishMove!(); await tick(); await tick(); assert(!host.querySelector('.ledger-move-dialog'), 'Completed move left card open');
}, { deferMove: true });
for (const stage of ['pending', 'approved'] as const) for (const dismissal of ['Close split transaction', 'Cancel breakdown', 'Escape', 'outside']) await check(`transaction breakdown ${stage} ${dismissal} discards amount without splitting`, async () => {
  flushSync(() => mode(stage)); await tick();
  const trigger = buttons('Break down A long grocery store label')[0]; trigger.focus(); await openTransactionBreakdown();
  const dialog = host.querySelector('.ledger-breakdown-region') as HTMLDialogElement;
  assert(dialog?.open && dialog.matches(':modal'), 'Transaction breakdown is not a floating modal');
  assert(getComputedStyle(dialog, '::backdrop').backdropFilter.includes('blur'), 'Transaction breakdown backdrop is not blurred');
  const writesBefore = breakdownWrites.length; await change('Amount to separate', '30');
  if (dismissal === 'Escape') flushSync(() => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  else if (dismissal === 'outside') flushSync(() => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -1, clientY: -1 })));
  else await click(dismissal);
  await tick(); assert(!host.querySelector('.ledger-breakdown-region'), 'Dismissal left transaction breakdown open');
  assert(breakdownWrites.length === writesBefore, 'Dismissal split the transaction');
  assert(document.activeElement === trigger, 'Dismissal did not restore transaction trigger focus');
  await openTransactionBreakdown(); assert(field('Amount to separate').value === '', 'Reopen retained discarded amount');
  await click('Cancel breakdown');
});
await check('transaction breakdown cannot dismiss while a split is saving', async () => {
  await openTransactionBreakdown(); await change('Amount to separate', '30'); await click('Confirm Split');
  const dialog = host.querySelector('.ledger-breakdown-region') as HTMLDialogElement;
  assert(buttons('Close split transaction')[0].disabled && buttons('Cancel breakdown')[0].disabled, 'Saving permits button dismissal');
  flushSync(() => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
  flushSync(() => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -1, clientY: -1 })));
  await tick(); assert(dialog.open, 'Escape or outside dismissed a saving split');
  finishBreakdown!(); await tick(); await tick(); assert(!host.querySelector('.ledger-breakdown-region'), 'Successful split left modal open');
}, { deferBreakdown: true });
for (const refund of [false, true]) await check(`stacked split previews conserve ${refund ? 'refund' : 'expense'} amount without overlap`, async () => {
  await openTransactionBreakdown(); await change('Amount to separate', '30');
  const region = host.querySelector('[aria-labelledby="breakdown-title"]')!;
  const original = region.querySelector('[aria-label="Original entry preview"]');
  const separated = region.querySelector('[aria-label="New entry preview"]');
  const footer = region.querySelector('footer');
  const card = region.querySelector('.ledger-breakdown')!;
  assert(getComputedStyle(card).backgroundColor === 'rgb(255, 255, 255)' && card.getBoundingClientRect().width <= 460.5, 'Split form lost white compact card');
  assert(getComputedStyle(footer!).backgroundColor === 'rgb(250, 251, 252)', 'Split footer lost distinct pale surface');
  assert(getComputedStyle(buttons('Confirm Split')[0]).backgroundColor === 'rgb(37, 99, 235)', 'Split confirmation lost primary blue');
  assert(original && separated && footer, 'Stacked original/new preview and distinct footer missing');
  assert(field('Amount to separate').getBoundingClientRect().bottom < original!.getBoundingClientRect().top, 'Input overlaps preview');
  assert(original!.getBoundingClientRect().bottom <= separated!.getBoundingClientRect().top, 'Original/new previews overlap');
  assert(separated!.getBoundingClientRect().bottom < footer!.getBoundingClientRect().top, 'Result overlaps footer');
  assert(original!.textContent?.includes('12315.67') && separated!.textContent?.includes('30.00'), 'Preview amount is incorrect');
  assert(!refund || separated!.textContent?.includes('-'), 'Refund preview lost sign');
  await change('Amount to separate', ''); assert(field('Amount to separate').value === '', 'Blank split amount replaced');
  assert(buttons('Confirm Split')[0].disabled, 'Invalid split completion enabled'); fits();
}, { refund });
document.querySelector('#results')!.textContent = `${output.filter(line => line.startsWith('PASS')).length}/${output.length} passed at ${innerWidth}px\n${output.join('\n')}`;
if (new URLSearchParams(location.search).get('demo') === '1') {
  flushSync(() => root.render(null)); flushSync(() => root.render(<Fixture demo edited />)); await tick();
  (document.querySelector('#results') as HTMLElement).hidden = true;
}
