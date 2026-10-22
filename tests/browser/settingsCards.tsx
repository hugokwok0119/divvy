import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import SettingsPage from '../../src/components/SettingsPage';
import { api } from '../../src/lib/api';
import type { Card, Member } from '../../src/types';
import '../../src/index.css';

// Serve with npm run dev, then open /tests/browser/settingsCards.html.
const members: Member[] = [{ id: 'm1', displayName: 'Alex', role: 'owner', sortOrder: 0, archivedAt: null }];
const card: Card = { id: 'c1', memberId: 'm1', name: 'Amex', archived: 0, sortOrder: 0, statementDay: null, historyName: null, historyStatementDay: null, historyAppliedAt: null };
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const results: string[] = [];

type Options = { cards?: Card[]; members?: Member[]; customCategories?: string[] };
async function check(name: string, run: (view: ReturnType<typeof mount>) => Promise<void>, options: Options = {}) {
  const view = mount(options);
  try { await run(view); results.push(`PASS ${name}`); } catch (error) { results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  view.unmount();
}

function mount({ cards = [card], members: people = members, customCategories = [] }: Options = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const saved: unknown[] = [];
  const previews: unknown[] = [];
  let release: (() => void) | null = null;
  const deleted: string[] = [];
  const removedMembers: string[] = [];
  const cardOrders: string[][] = [];
  const memberOrders: string[][] = [];
  const households: unknown[] = [];
  const toasts: string[] = [];
  let releaseDelete: (() => void) | null = null;
  api.deleteCard = async (id) => { deleted.push(id); await new Promise<void>((resolve) => { releaseDelete = resolve; }); };
  api.deleteMember = async (id) => { removedMembers.push(id); };
  api.reorderCards = async (ids) => { cardOrders.push(ids); };
  api.reorderMembers = async (ids) => { memberOrders.push(ids); };
  api.updateHousehold = async (patch) => { households.push(patch); return patch; };
  api.upsertCard = async (input) => { saved.push(input); if (release === null) await new Promise<void>((resolve) => { release = resolve; }); return input; };
  api.previewCardHistory = async (input) => { previews.push(input); return { cycles: 1, expenses: 2 }; };
  flushSync(() => root.render(<SettingsPage members={people} cards={cards} customCategories={customCategories} rentReminder role="owner"
    onBack={() => {}} onChanged={async () => {}} showToast={(message) => { toasts.push(message); }} />));
  const set = (element: HTMLInputElement | HTMLSelectElement, value: string) => flushSync(() => {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
  const choice = (title: string) => [...host.querySelectorAll('[role="radiogroup"] label')].find((l) => l.textContent?.includes(title))?.querySelector('input') as unknown as HTMLInputElement | undefined;
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
  return {
    host, saved, previews, deleted, removedMembers, cardOrders, memberOrders, households, toasts,
    finishDelete: () => releaseDelete?.(),
    name: () => host.querySelector<HTMLInputElement>('#card-name-c1')!,
    day: () => host.querySelector('select[aria-label="Ends on for Amex"]') as unknown as HTMLSelectElement,
    dialog: () => host.querySelector<HTMLDialogElement>('dialog'),
    set, button, choice,
    click: (b: HTMLButtonElement | undefined) => { assert(b, 'Missing button'); flushSync(() => b!.click()); },
    finishSave: () => { release?.(); release = () => {}; },
    unmount: () => { root.unmount(); host.remove(); },
  };
}

await check('unchanged card shows no save and no prompt', async (view) => {
  assert(view.day(), 'Statement day select missing');
  assert(view.day().value === '', 'Unset statement day should be blank');
  assert(!view.button('Save card'), 'Save shown for unchanged card');
});
await check('rename and day change share one prompt with preview; cancel saves nothing', async (view) => {
  view.set(view.name(), 'Visa'); view.set(view.day(), '31');
  view.click(view.button('Save card')); await flush(); await flush();
  assert(view.dialog()?.open, 'Confirmation card did not open');
  assert(view.previews.length === 1, 'Preview not requested once');
  assert(JSON.stringify(view.previews[0]).includes('"statementDay":31') && JSON.stringify(view.previews[0]).includes('"name":"Visa"'), 'Preview input wrong');
  const text = view.dialog()!.textContent!;
  assert(text.includes('Save Amex changes') && text.includes('Amex → Visa') && text.includes('– → 31'), 'Title or changed-field summary missing');
  assert(text.includes('Relabels 1 cycle · 2 expenses'), 'Preview counts missing');
  assert(view.choice('Current and future')?.checked && view.choice('Also past cycles') && !view.choice('Also past cycles')!.checked, 'Choices or default missing');
  view.click(view.button('Cancel')); await flush();
  assert(!view.dialog(), 'Cancel did not close');
  assert(view.saved.length === 0, 'Cancel saved');
});
await check('Escape dismisses without saving', async (view) => {
  view.set(view.name(), 'Visa');
  view.click(view.button('Save card')); await flush(); await flush();
  flushSync(() => view.dialog()!.dispatchEvent(new Event('cancel', { cancelable: true })));
  assert(!view.dialog(), 'Escape did not close');
  assert(view.saved.length === 0, 'Escape saved');
});
await check('blank name shows no save', async (view) => {
  view.set(view.name(), '   ');
  assert(!view.button('Save card'), 'Save shown for blank name');
});
await check('focus falls back to the card name when the opener is body', async (view) => {
  view.set(view.day(), '12');
  (document.activeElement as HTMLElement | null)?.blur();
  flushSync(() => view.name().form!.requestSubmit()); await flush(); await flush();
  assert(view.dialog()?.open, 'Confirmation card did not open');
  flushSync(() => view.dialog()!.dispatchEvent(new Event('cancel', { cancelable: true })));
  assert(document.activeElement === view.name(), `Focus went to ${document.activeElement?.tagName}`);
});
for (const [choice, applyToHistory] of [['Current and future', false], ['Also past cycles', true]] as const) {
  await check(`${choice} saves the chosen scope and blocks dismissal while saving`, async (view) => {
    view.set(view.day(), '15');
    view.click(view.button('Save card')); await flush(); await flush();
    flushSync(() => view.choice(choice)!.click());
    view.click(view.button('Save')); await flush();
    assert(view.saved.length === 1, 'Save not sent');
    const body = view.saved[0] as Record<string, unknown>;
    assert(body.applyToHistory === applyToHistory && body.statementDay === 15 && body.name === 'Amex', `Wrong body ${JSON.stringify(body)}`);
    flushSync(() => view.dialog()!.dispatchEvent(new Event('cancel', { cancelable: true })));
    assert(view.dialog()?.open, 'Dismissed while saving');
    view.finishSave(); await flush(); await flush();
    assert(!view.dialog(), 'Dialog stayed open after save');
  });
}
const visa: Card = { ...card, id: 'c2', name: 'Visa', sortOrder: 1 };
const hugo: Member = { id: 'm2', displayName: 'Hugo', role: 'member', sortOrder: 1, archivedAt: null };
const key = (element: Element, k: string) => flushSync(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
const pointer = (element: Element, type: string, target: Element) => {
  target.scrollIntoView({ block: 'center' });
  const box = target.getBoundingClientRect();
  flushSync(() => element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 })));
};
const handle = (view: ReturnType<typeof mount>, label: string) => view.host.querySelector(`[aria-label="${label}"]`)!;

await check('delete asks first; cancel deletes nothing and restores focus', async (view) => {
  const opener = handle(view, 'Delete card Amex') as HTMLButtonElement;
  assert(opener, 'Delete button missing');
  opener.focus(); view.click(opener); await flush();
  assert(view.dialog()?.open, 'Delete confirmation did not open');
  assert(view.dialog()!.textContent!.includes('Delete Amex?'), 'Delete title missing');
  view.click(view.button('Cancel')); await flush();
  assert(!view.dialog(), 'Cancel did not close');
  assert(view.deleted.length === 0, 'Cancel deleted');
  assert(document.activeElement === opener, `Focus went to ${document.activeElement?.tagName}`);
});
await check('Escape on delete confirmation deletes nothing', async (view) => {
  view.click(handle(view, 'Delete card Amex') as HTMLButtonElement); await flush();
  flushSync(() => view.dialog()!.dispatchEvent(new Event('cancel', { cancelable: true })));
  assert(!view.dialog(), 'Escape did not close');
  assert(view.deleted.length === 0, 'Escape deleted');
});
await check('confirmed delete sends once and blocks dismissal while deleting', async (view) => {
  view.click(handle(view, 'Delete card Amex') as HTMLButtonElement); await flush();
  view.click(view.button('Delete card')); await flush();
  assert(view.deleted.length === 1 && view.deleted[0] === 'c1', `Wrong delete ${JSON.stringify(view.deleted)}`);
  flushSync(() => view.dialog()!.dispatchEvent(new Event('cancel', { cancelable: true })));
  assert(view.dialog()?.open, 'Dismissed while deleting');
  view.finishDelete(); await flush(); await flush();
  assert(!view.dialog(), 'Dialog stayed open after delete');
});
await check('member added from Settings can be removed after confirming; cancel removes nothing', async (view) => {
  const opener = handle(view, 'Remove member Hugo') as HTMLButtonElement;
  assert(opener, 'Remove member button missing');
  opener.focus(); view.click(opener); await flush();
  assert(view.dialog()?.open && view.dialog()!.textContent!.includes('Remove Hugo?'), 'Remove confirmation did not open');
  view.click(view.button('Cancel')); await flush();
  assert(!view.dialog() && view.removedMembers.length === 0, 'Cancel removed');
  assert(document.activeElement === opener, `Focus went to ${document.activeElement?.tagName}`);
  view.click(opener); await flush();
  view.click(view.button('Remove member')); await flush(); await flush();
  assert(JSON.stringify(view.removedMembers) === '["m2"]', `Wrong removal ${JSON.stringify(view.removedMembers)}`);
  assert(!view.dialog(), 'Dialog stayed open after removal');
}, { members: [...members, hugo] });
await check('the signed-in owner cannot remove themself', async (view) => {
  assert(!handle(view, 'Remove member Alex'), 'Owner remove button shown');
});
await check('ArrowDown on a card handle saves the new card order', async (view) => {
  key(handle(view, 'Reorder card Amex'), 'ArrowDown'); await flush();
  assert(JSON.stringify(view.cardOrders) === '[["c2","c1"]]', `Wrong order ${JSON.stringify(view.cardOrders)}`);
}, { cards: [card, visa] });
await check('dragging a card onto the next one saves the new card order', async (view) => {
  const grip = handle(view, 'Reorder card Amex');
  pointer(grip, 'pointerdown', grip);
  pointer(grip, 'pointermove', view.host.querySelector('#card-name-c2')!);
  pointer(grip, 'pointerup', view.host.querySelector('#card-name-c2')!); await flush();
  assert(JSON.stringify(view.cardOrders) === '[["c2","c1"]]', `Wrong order ${JSON.stringify(view.cardOrders)}`);
}, { cards: [card, visa] });
await check('ArrowUp on a member handle saves the new member order', async (view) => {
  key(handle(view, 'Reorder member Hugo'), 'ArrowUp'); await flush();
  assert(JSON.stringify(view.memberOrders) === '[["m2","m1"]]', `Wrong order ${JSON.stringify(view.memberOrders)}`);
}, { members: [...members, hugo] });
await check('new card is added after the existing cards', async (view) => {
  view.click(view.button('+ Add Another Card')); await flush();
  const body = view.saved[0] as Record<string, unknown>;
  assert(body.sortOrder === 2, `Wrong sortOrder ${JSON.stringify(body)}`);
  view.finishSave();
}, { cards: [card, visa] });
await check('duplicate category opens a dialog, saves nothing, and returns focus to the field', async (view) => {
  const input = view.host.querySelector<HTMLInputElement>('#new-category-name')!;
  view.set(input, 'groceries'); input.focus();
  view.click(handle(view, 'Add category') as HTMLButtonElement); await flush();
  assert(view.dialog()?.open, 'Duplicate dialog did not open');
  assert(view.dialog()!.textContent!.includes('Category already exists') && view.dialog()!.textContent!.includes('"Groceries" is already a category.'), 'Duplicate text missing');
  assert(view.households.length === 0 && view.toasts.length === 0, 'Saved or toasted');
  view.click(view.button('OK')); await flush();
  assert(!view.dialog(), 'OK did not close');
  assert(document.activeElement === input, `Focus went to ${document.activeElement?.tagName}`);
});
document.querySelector('[role="status"]')!.textContent = `${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed\n${results.join('\n')}`;
