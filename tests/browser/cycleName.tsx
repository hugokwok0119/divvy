import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import CycleName from '../../src/components/CycleName';
import '../../src/index.css';

// Serve with npm run dev, then open /tests/browser/cycleName.html.
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const results: string[] = [];
const DEFAULT = 'Alex · Visa · expenses Sep 16–Oct 15, 2026';

async function check(name: string, run: (view: ReturnType<typeof mount>) => Promise<void>, saved: string | null = null) {
  const view = mount(saved);
  try { await run(view); results.push(`PASS ${name}`); } catch (error) { results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  view.unmount();
}

function mount(saved: string | null) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const saves: Array<string | null> = [];
  let release: (() => void) | null = null;
  let fail = false;
  const onSave = async (name: string | null) => {
    saves.push(name);
    await new Promise<void>((resolve) => { release = resolve; });
    if (fail) throw new Error('Could not rename that cycle.');
  };
  flushSync(() => root.render(<CycleName name={saved} defaultName={DEFAULT} label="current cycle" onSave={onSave} />));
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
  return {
    host, saves,
    failNext: () => { fail = true; },
    finish: () => release?.(),
    opener: () => host.querySelector<HTMLButtonElement>('[aria-label="Rename current cycle"]'),
    dialog: () => host.querySelector<HTMLDialogElement>('dialog'),
    input: () => host.querySelector<HTMLInputElement>('dialog input'),
    button,
    set: (value: string) => flushSync(() => {
      const input = host.querySelector<HTMLInputElement>('dialog input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }),
    click: (b: HTMLButtonElement | null | undefined) => { assert(b, 'Missing button'); flushSync(() => b!.click()); },
    escape: () => flushSync(() => host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))),
    unmount: () => { root.unmount(); host.remove(); },
  };
}

await check('shows the default name until one is saved', async (view) => {
  assert(view.host.textContent!.includes(DEFAULT), 'Default name missing');
  assert(view.opener(), 'Rename button missing');
});
await check('shows a saved name', async (view) => {
  assert(view.host.textContent!.includes('Japan trip') && !view.host.textContent!.includes(DEFAULT), 'Saved name not shown');
}, 'Japan trip');
await check('Escape dismisses unsaved input and restores focus', async (view) => {
  view.opener()!.focus(); view.click(view.opener()); await flush();
  assert(view.dialog()?.open && view.dialog()!.textContent!.includes('Rename cycle'), 'Rename card did not open');
  assert(view.input()?.placeholder === DEFAULT && view.input()!.value === '', 'Input should be blank with the default as placeholder');
  assert(document.activeElement === view.input(), `Opening focused ${document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName}, not the name field`);
  view.set('October'); view.escape(); await flush();
  assert(!view.dialog() && view.saves.length === 0, 'Escape saved or stayed open');
  assert(document.activeElement === view.opener(), `Focus went to ${document.activeElement?.tagName}`);
  view.click(view.opener()); await flush();
  assert(view.input()!.value === '', 'Dismissed input came back');
});
await check('saves a trimmed name and blocks dismissal while saving', async (view) => {
  view.click(view.opener()); await flush();
  view.set('  October  ');
  view.click(view.button('Save')); await flush();
  assert(JSON.stringify(view.saves) === '["October"]', `Wrong save ${JSON.stringify(view.saves)}`);
  view.escape();
  assert(view.dialog()?.open, 'Dismissed while saving');
  view.finish(); await flush(); await flush();
  assert(!view.dialog(), 'Card stayed open after save');
});
await check('a blank name resets to the default', async (view) => {
  view.click(view.opener()); await flush();
  assert(view.input()!.value === 'Japan trip', 'Saved name not prefilled');
  view.set('   ');
  view.click(view.button('Save')); await flush();
  assert(JSON.stringify(view.saves) === '[null]', `Wrong save ${JSON.stringify(view.saves)}`);
  view.finish(); await flush(); await flush();
}, 'Japan trip');
await check('a failed save keeps the card open with the error', async (view) => {
  view.failNext();
  view.click(view.opener()); await flush();
  view.set('October');
  view.click(view.button('Save')); await flush();
  view.finish(); await flush(); await flush();
  assert(view.dialog()?.open, 'Card closed after a failed save');
  assert(view.dialog()!.querySelector('[role="alert"]')?.textContent === 'Could not rename that cycle.', 'Error not shown');
  assert(view.input()!.value === 'October', 'Draft lost after a failed save');
});
document.querySelector('[role="status"]')!.textContent = `${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed\n${results.join('\n')}`;
