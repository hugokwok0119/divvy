import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Toast, TOAST_MS, useToast, type ToastType } from '../../src/components/Toast';
import '../../src/index.css';

// Serve with npm run dev, then open /tests/browser/toast.html. Uses real timers, so keep the tab visible.
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const results: string[] = [];

async function check(name: string, run: (view: ReturnType<typeof mount>) => Promise<void>) {
  const view = mount();
  try { await run(view); results.push(`PASS ${name}`); } catch (error) { results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  view.unmount();
}

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let show: (text: string, type?: ToastType) => void = () => {};
  function Harness() {
    const { toast, showToast, clearToast } = useToast();
    show = showToast;
    return <Toast toast={toast} onClose={clearToast} />;
  }
  flushSync(() => root.render(<Harness />));
  const close = () => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]');
  const card = () => close()?.closest<HTMLElement>('[role="alert"], [role="status"]') ?? null;
  // Real pointers send pointerover/pointerout (React's enter/leave source) alongside pointerenter/pointerleave.
  const pointer = (over: boolean) => flushSync(() => {
    const el = card()!;
    el.dispatchEvent(new PointerEvent(over ? 'pointerover' : 'pointerout', { bubbles: true, relatedTarget: document.body }));
    el.dispatchEvent(new PointerEvent(over ? 'pointerenter' : 'pointerleave', { relatedTarget: document.body }));
  });
  return {
    close, card,
    show: (text: string, type?: ToastType) => flushSync(() => show(text, type)),
    shown: (text: string) => card()?.textContent?.includes(text) ?? false,
    hover: () => pointer(true),
    leave: () => pointer(false),
    unmount: () => { root.unmount(); host.remove(); },
  };
}

await check('success closes itself after 4 seconds', async (view) => {
  assert(TOAST_MS.success === 4000, `TOAST_MS.success is ${TOAST_MS.success}`);
  view.show('Saved.', 'success');
  await wait(3500);
  assert(view.shown('Saved.'), 'Closed before 4 seconds');
  await wait(1000);
  assert(!view.card(), 'Still shown after 4.5 seconds');
});
await check('error stays for 8 seconds', async (view) => {
  assert(TOAST_MS.error === 8000, `TOAST_MS.error is ${TOAST_MS.error}`);
  view.show('Could not save.');
  await wait(7500);
  assert(view.shown('Could not save.'), 'Closed before 8 seconds');
  await wait(1000);
  assert(!view.card(), 'Still shown after 8.5 seconds');
});
await check('hover pauses the timer', async (view) => {
  view.show('Saved.', 'success');
  view.hover();
  await wait(5000);
  assert(view.shown('Saved.'), 'Closed while hovered');
  view.leave();
  await wait(3500);
  assert(view.shown('Saved.'), 'Leaving resumed the old timer instead of restarting it');
  await wait(1000);
  assert(!view.card(), 'Still shown 4.5 seconds after the pointer left');
});
await check('focus inside pauses the timer', async (view) => {
  view.show('Saved.', 'success');
  flushSync(() => view.close()!.focus());
  assert(document.activeElement === view.close(), 'Close button did not take focus');
  await wait(5000);
  assert(view.shown('Saved.'), 'Closed while focus was inside');
  flushSync(() => view.close()!.blur());
  await wait(3500);
  assert(view.shown('Saved.'), 'Losing focus resumed the old timer instead of restarting it');
  await wait(1000);
  assert(!view.card(), 'Still shown 4.5 seconds after focus left');
});
await check('a new toast restarts the timer', async (view) => {
  view.show('First.', 'success');
  await wait(3000);
  view.hover();
  view.show('Second.', 'success');
  view.leave();
  await wait(3000);
  assert(view.shown('Second.'), 'New toast closed on the old timer');
  await wait(1500);
  assert(!view.card(), 'New toast still shown after 4.5 seconds');
});
await check('error uses role alert and success uses role status', async (view) => {
  view.show('Could not save.', 'error');
  assert(view.card()?.getAttribute('role') === 'alert', `Error role is ${view.card()?.getAttribute('role')}`);
  view.show('Saved.', 'success');
  assert(view.card()?.getAttribute('role') === 'status', `Success role is ${view.card()?.getAttribute('role')}`);
  assert(view.card()?.getAttribute('aria-live') === 'polite', 'Success is not aria-live polite');
});
await check('close button dismisses', async (view) => {
  view.show('Could not save.', 'error');
  flushSync(() => view.close()!.click());
  await wait(400);
  assert(!view.card(), 'Still shown after the close button');
});
document.querySelector('[role="status"]')!.textContent = `${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed\n${results.join('\n')}`;
