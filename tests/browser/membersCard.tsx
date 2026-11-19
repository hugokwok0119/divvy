import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import MembersCard from '../../src/components/MembersCard';
import type { Member } from '../../src/types';
import '../../src/index.css';

// Serve with npm run dev, then open /tests/browser/membersCard.html.
const members: Member[] = [
  { id: 'm1', displayName: 'Alex', role: 'owner', sortOrder: 0, archivedAt: null, sittingOutAt: null },
  { id: 'm2', displayName: 'Sam', role: 'member', sortOrder: 1, archivedAt: null, sittingOutAt: null },
  { id: 'm3', displayName: 'Morgan', role: 'member', sortOrder: 2, archivedAt: 5, sittingOutAt: null },
];
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const results: string[] = [];

type Options = { locked?: boolean; canEdit?: boolean; slowSave?: boolean; failSave?: boolean };
function mount({ locked = false, canEdit = true, slowSave = false, failSave = false }: Options = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const saves: string[][] = [];
  let closes = 0;
  let release = () => {};
  flushSync(() => root.render(<MembersCard
    members={members} groupName="Home" locked={locked} canEdit={canEdit}
    onSave={(ids) => { saves.push(ids); if (failSave) return Promise.reject(new Error('Who is in is locked while this cycle has expenses')); return slowSave ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve(); }}
    onClose={() => { closes++; }}
    restoreFocus={() => null}
  />));
  const dialog = () => host.querySelector('dialog')!;
  const box = (name: string) => [...dialog().querySelectorAll('label')].find((label) => label.textContent?.includes(name))?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  const footer = () => [...dialog().querySelectorAll<HTMLButtonElement>('footer button')];
  return {
    dialog, box, footer, saves, closes: () => closes, release: () => release(),
    text: () => dialog().textContent ?? '',
    click: (element: HTMLElement) => flushSync(() => element.click()),
    escape: () => flushSync(() => dialog().dispatchEvent(new Event('cancel', { cancelable: true }))),
    unmount: () => { release(); root.unmount(); host.remove(); },
  };
}
async function check(name: string, run: (view: ReturnType<typeof mount>) => Promise<void>, options: Options = {}) {
  const view = mount(options);
  try { await run(view); results.push(`PASS ${name}`); } catch (error) { results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  view.unmount();
}
const save = (view: ReturnType<typeof mount>) => view.footer().find((button) => button.textContent === 'Save')!;

await check('saves the ticked members', async (view) => {
  assert(view.text().includes('Who is in this cycle?') && view.text().includes('Home'), 'Missing heading or group name');
  assert(view.box('Alex')?.checked && view.box('Sam')?.checked, 'Members who are in must start ticked');
  assert(!view.box('Morgan'), 'Archived member listed');
  view.click(view.box('Sam')!);
  view.click(save(view));
  await flush();
  assert(view.saves.length === 1 && JSON.stringify(view.saves[0]) === '["m1"]', `Saved ${JSON.stringify(view.saves)}`);
});
await check('save is disabled with nobody ticked', async (view) => {
  view.click(view.box('Alex')!);
  view.click(view.box('Sam')!);
  assert(save(view).disabled, 'Save enabled with nobody in');
  assert(view.text().includes('At least one person must be in.'), 'Missing empty note');
});
await check('locked shows the note and only Close', async (view) => {
  assert(view.text().includes('Locked while this cycle has Pending or Approved expenses. Close the cycle to change who is in.'), 'Missing locked note');
  assert(view.box('Alex')!.disabled && view.box('Sam')!.disabled, 'Checkboxes editable while locked');
  assert(view.footer().map((button) => button.textContent).join() === 'Close', 'Footer must hold only Close');
  view.click(view.footer()[0]);
  assert(view.closes() === 1 && view.saves.length === 0, 'Close saved or stayed open');
}, { locked: true });
await check('a member sees the list read-only', async (view) => {
  assert(view.text().includes('Only the group owner can change who is in.'), 'Missing owner note');
  assert(view.box('Alex')!.disabled && view.box('Sam')!.disabled, 'Checkboxes editable for a member');
  assert(view.footer().map((button) => button.textContent).join() === 'Close', 'Footer must hold only Close');
}, { canEdit: false });
await check('cannot be dismissed while saving', async (view) => {
  view.click(save(view));
  view.escape();
  assert(view.closes() === 0, 'Escape dismissed during save');
  assert(view.dialog().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.disabled, 'Close button enabled during save');
  view.release();
  await flush();
}, { slowSave: true });
await check('Escape closes without saving', async (view) => {
  view.click(view.box('Sam')!);
  view.escape();
  assert(view.closes() === 1 && view.saves.length === 0, 'Escape saved or stayed open');
});
await check('shows the server message when saving fails', async (view) => {
  view.click(save(view));
  await flush();
  const alert = view.dialog().querySelector('[role="alert"]');
  assert(alert?.textContent === 'Who is in is locked while this cycle has expenses', `Missing inline error: ${alert?.textContent}`);
  assert(view.dialog().open && view.closes() === 0, 'Card closed after a failed save');
  assert(!save(view).disabled, 'Save stayed busy after a failed save');
}, { failSave: true });
document.querySelector('[role="status"]')!.textContent = `${results.filter((result) => result.startsWith('PASS')).length}/${results.length} passed\n${results.join('\n')}`;
