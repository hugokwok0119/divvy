import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import ReminderCalendar from '../../src/components/ReminderCalendar';
import { api } from '../../src/lib/api';
import { shiftMonth, todayIn } from '../../src/lib/reminders';
import type { Card, Member } from '../../src/types';
import '../../src/index.css';

// Serve with npm run dev, then open /tests/browser/reminderCalendar.html.
const TZ = 'UTC';
const members: Member[] = [{ id: 'm1', displayName: 'Alex', role: 'owner', sortOrder: 0, archivedAt: null, sittingOutAt: null }];
const cards: Card[] = [{ id: 'c1', memberId: 'm1', name: 'Amex', archived: 0, sortOrder: 0, statementDay: 15, historyName: null, historyStatementDay: null, historyAppliedAt: null }];
const current = todayIn(TZ).slice(0, 7);
const back1 = shiftMonth(current, -1);
const back2 = shiftMonth(current, -2);
const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const results: string[] = [];

async function check(name: string, run: (view: ReturnType<typeof mount>) => Promise<void>) {
  const view = mount();
  try { await flush(); await run(view); results.push(`PASS ${name}`); } catch (error) { results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  view.unmount();
}

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const asked: string[] = [];
  const saves: Array<[string, string, boolean]> = [];
  api.reminders = async (month) => { asked.push(month); return []; };
  api.setReminder = async (month, reminderId, done) => {
    saves.push([month, reminderId, done]);
    return done ? [{ month, reminderId, completedByMemberId: 'm1', completedAt: 1 }] : [];
  };
  flushSync(() => root.render(<ReminderCalendar cards={cards} members={members} timezone={TZ} rentReminder />));
  const find = (prefix: string) => host.querySelector<HTMLButtonElement>(`button[aria-label^="${prefix}"]`);
  return {
    host, asked, saves,
    prev: () => find('Previous month'),
    next: () => find('Next month'),
    heading: () => host.querySelector<HTMLElement>('#reminder-calendar-title'),
    list: () => host.querySelector<HTMLUListElement>('ul[aria-label^="Reminders"]'),
    find,
    click: async (b: HTMLElement | null) => { assert(b, 'Missing button'); flushSync(() => b!.click()); await flush(); },
    unmount: () => { root.unmount(); host.remove(); },
  };
}

await check('previous goes back two months and stops', async (view) => {
  assert(view.heading()?.getAttribute('aria-live') === 'polite', 'Heading is not a polite live region');
  assert(view.heading()!.textContent!.includes(monthName(current)), `Heading shows ${view.heading()!.textContent}`);
  assert(view.prev()?.getAttribute('aria-label') === `Previous month, ${monthName(back1)}`, `Wrong label ${view.prev()?.getAttribute('aria-label')}`);
  await view.click(view.prev());
  assert(view.heading()!.textContent!.includes(monthName(back1)), `Heading shows ${view.heading()!.textContent} after one step`);
  assert(view.prev()?.getAttribute('aria-label') === `Previous month, ${monthName(back2)}`, `Wrong label ${view.prev()?.getAttribute('aria-label')}`);
  await view.click(view.prev());
  assert(view.heading()!.textContent!.includes(monthName(back2)), `Heading shows ${view.heading()!.textContent} after two steps`);
  assert(view.prev()!.disabled, 'Previous stayed enabled two months back');
  await view.click(view.prev());
  assert(view.heading()!.textContent!.includes(monthName(back2)), 'Went back more than two months');
});
await check('next is disabled on the current month', async (view) => {
  assert(view.next()?.disabled, 'Next is enabled on the current month');
  assert(view.next()!.getAttribute('aria-label') === `Next month, ${monthName(shiftMonth(current, 1))}`, `Wrong label ${view.next()!.getAttribute('aria-label')}`);
  await view.click(view.prev());
  assert(!view.next()!.disabled, 'Next is disabled on a past month');
  assert(view.next()!.getAttribute('aria-label') === `Next month, ${monthName(current)}`, `Wrong label ${view.next()!.getAttribute('aria-label')}`);
  await view.click(view.next());
  assert(view.heading()!.textContent!.includes(monthName(current)) && view.next()!.disabled, 'Next did not return to the current month');
});
await check('ticks load for the shown month', async (view) => {
  assert(JSON.stringify(view.asked) === JSON.stringify([current]), `Asked ${JSON.stringify(view.asked)} on mount`);
  assert(view.list()?.getAttribute('aria-label') === `Reminders in ${monthName(current)}`, `List label ${view.list()?.getAttribute('aria-label')}`);
  await view.click(view.prev());
  await view.click(view.prev());
  assert(JSON.stringify(view.asked) === JSON.stringify([current, back1, back2]), `Asked ${JSON.stringify(view.asked)} after stepping back`);
  assert(view.list()!.getAttribute('aria-label') === `Reminders in ${monthName(back2)}`, `List label ${view.list()!.getAttribute('aria-label')}`);
  assert(view.host.querySelector(`button[aria-label*="Amex statement"]`) && [...view.host.querySelectorAll('button[aria-label*="Amex statement"]')].length === 1, 'Statement day missing');
  window.dispatchEvent(new Event('focus')); await flush();
  assert(JSON.stringify(view.asked.slice(3)) === JSON.stringify([back2]), `Focus asked ${JSON.stringify(view.asked.slice(3))}`);
});
await check('ticking a past month saves to that month', async (view) => {
  await view.click(view.prev());
  await view.click(view.host.querySelector<HTMLButtonElement>('button[aria-label*="Amex statement"]'));
  const box = view.host.querySelector<HTMLInputElement>('dialog input[type="checkbox"]');
  assert(box, 'Day card did not open with a tick');
  flushSync(() => box!.click()); await flush(); await flush();
  assert(JSON.stringify(view.saves) === JSON.stringify([[back1, 'card:c1', true]]), `Saved ${JSON.stringify(view.saves)}`);
  assert(view.host.querySelector('dialog')!.textContent!.includes('Done'), 'Tick did not show as done');
});
await check('today is ringed only on the current month', async (view) => {
  const ringed = () => [...view.host.querySelectorAll('[aria-current="date"]')];
  assert(ringed().length === 1 && ringed()[0].className.includes('ring-2'), 'Today is not ringed on the current month');
  await view.click(view.prev());
  assert(ringed().length === 0 && !view.host.querySelector('.ring-2'), 'A day is ringed on a past month');
});
document.querySelector('[role="status"]')!.textContent = `${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed\n${results.join('\n')}`;
