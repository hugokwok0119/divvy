import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { statementDateFor } from '../lib/money';
import { monthReminders, todayIn, type Reminder } from '../lib/reminders';
import { distinctColors } from './ledger';
import type { Card, Member, ReminderCompletion } from '../types';

const RENT_COLOR = '#0f172a';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const format = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });

interface ReminderCalendarProps {
  cards: Card[];
  members: Member[];
  timezone: string;
}

/** Current-month statement and rent reminders with shared, manual ticks. */
export default function ReminderCalendar({ cards, members, timezone }: ReminderCalendarProps) {
  const today = todayIn(timezone);
  const monthKey = today.slice(0, 7);
  const [year, month] = monthKey.split('-').map(Number);
  const reminders = monthReminders(year, month, cards);
  const colors = distinctColors(reminders.flatMap((r) => r.cardId ?? []));
  const colorOf = (r: Reminder) => (r.cardId ? colors[r.cardId] : RENT_COLOR);
  const lastDay = Number(statementDateFor(year, month, 31).slice(8));
  const offset = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();

  const [completions, setCompletions] = useState<ReminderCompletion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const completion = (r: Reminder) => completions.find((c) => c.reminderId === r.id);

  // Refetch on focus like App's bootstrap, so another member's ticks show up.
  const load = useCallback(() => api.reminders(monthKey).then(
    (rows) => { setCompletions(rows); setError(null); },
    () => setError('Could not load reminder ticks.'),
  ), [monthKey]);
  useEffect(() => {
    void load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  useEffect(() => {
    const box = dialog.current, opener = trigger.current;
    if (!openDate || !box) return;
    box.showModal();
    return () => { box.close(); opener?.focus(); };
  }, [openDate]);

  const close = () => { if (!saving) { setOpenDate(null); setError(null); } };
  const toggle = async (r: Reminder, done: boolean) => {
    setSaving(r.id);
    setError(null);
    try {
      setCompletions(await api.setReminder(monthKey, r.id, done));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this tick.');
    } finally { setSaving(null); }
  };

  // On desktop the day grid shrinks (never scrolls) when the sticky column runs short of height.
  return (
    <section aria-labelledby="reminder-calendar-title" className="flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <h2 id="reminder-calendar-title" className="flex items-center gap-2 text-heading2 text-slate-800">
        <CalendarDays size={18} className="text-blue-600" aria-hidden="true" />
        {format(today, { month: 'long', year: 'numeric' })}
      </h2>
      <div className="mt-2 grid shrink-0 grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((day) => <abbr key={day} title={day} className="text-body2 text-slate-500 no-underline">{day[0]}</abbr>)}
      </div>
      <div className="mt-1 grid min-h-0 grid-cols-7 auto-rows-[2.75rem] gap-1 text-center lg:auto-rows-[minmax(0,2rem)]">
        {Array.from({ length: offset }, (_, i) => <span key={`blank-${i}`} />)}
        {Array.from({ length: lastDay }, (_, i) => {
          const date = `${monthKey}-${String(i + 1).padStart(2, '0')}`;
          const due = reminders.filter((r) => r.date === date);
          const style = `flex h-full min-h-0 min-w-0 overflow-hidden flex-col items-center justify-center gap-0.5 rounded-md text-body1 ${date === today ? 'font-semibold ring-2 ring-blue-600' : ''}`;
          const content = <>
            <span>{i + 1}</span>
            <span className="flex h-1.5 max-w-full justify-center gap-0.5 overflow-hidden" aria-hidden="true">
              {due.map((r) => <span key={r.id} className="h-1.5 w-1.5 shrink-0 rounded-full" style={completion(r) ? { boxShadow: `inset 0 0 0 1.5px ${colorOf(r)}` } : { background: colorOf(r) }} />)}
            </span>
          </>;
          if (!due.length) return <span key={date} aria-current={date === today ? 'date' : undefined} className={`${style} text-slate-400`}>{content}</span>;
          return (
            <button
              key={date}
              type="button"
              aria-current={date === today ? 'date' : undefined}
              aria-label={`${format(date, { weekday: 'long', month: 'long', day: 'numeric' })}: ${due.map((r) => `${r.label}${completion(r) ? ', done' : ''}`).join('; ')}`}
              onClick={(e) => { trigger.current = e.currentTarget; setOpenDate(date); }}
              className={`${style} text-slate-800 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-500`}
            >
              {content}
            </button>
          );
        })}
      </div>
      <ul aria-label="Reminders this month" className="mt-2 shrink-0 space-y-0.5 border-t border-slate-100 pt-2 text-body2 text-slate-600">
        {reminders.map((r) => (
          <li key={r.id} className="flex items-center gap-2">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorOf(r) }} />
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            <span className="shrink-0">{format(r.date, { month: 'short', day: 'numeric' })}{completion(r) && <span className="font-semibold text-emerald-700"> · Done</span>}</span>
          </li>
        ))}
      </ul>
      {error && !openDate && <p role="alert" className="mt-2 text-body2 text-red-700">{error}</p>}

      {openDate && (
        <dialog
          ref={dialog}
          aria-labelledby="reminder-day-title"
          className="m-auto w-[calc(100vw-32px)] max-w-[380px] rounded-xl border border-slate-200 bg-white p-0 text-slate-700 shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
          onCancel={(e) => { e.preventDefault(); close(); }}
          onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            const box = e.currentTarget.getBoundingClientRect();
            if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) close();
          }}
        >
          <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-3">
            <h2 id="reminder-day-title" className="text-heading2 text-slate-800">{format(openDate, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
            <button type="button" aria-label="Close reminders" disabled={!!saving} onClick={close} className="inline-flex h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-50">
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          <div className="space-y-3 px-5 py-4">
            <ul className="space-y-2">
              {reminders.filter((r) => r.date === openDate).map((r) => {
                const done = completion(r);
                const by = members.find((m) => m.id === done?.completedByMemberId)?.displayName;
                return (
                  <li key={r.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 has-checked:border-blue-600 has-checked:bg-blue-50 has-focus-visible:ring-2 has-focus-visible:ring-blue-500 has-disabled:cursor-wait">
                      <input type="checkbox" className="h-4 w-4 shrink-0 accent-blue-600" checked={!!done} disabled={!!saving} aria-busy={saving === r.id} onChange={(e) => void toggle(r, e.target.checked)} />
                      <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorOf(r) }} />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-body1 font-semibold text-slate-800">{r.label}</span>
                        <span className="block text-body2 text-slate-500">{done ? `Done${by ? ` · ticked by ${by}` : ''}` : r.cardId ? 'Tick when the statement is added' : 'Tick when rent is added'}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="text-body2 text-slate-500">Ticks are shared with your household. They never approve, close or pay anything.</p>
            {error && <p role="alert" className="text-body1 text-red-700">{error}</p>}
          </div>
          <footer className="flex justify-end border-t border-slate-200 px-5 py-3">
            <button type="button" disabled={!!saving} onClick={close} className="min-h-9 pointer-coarse:min-h-11 rounded-lg bg-slate-900 px-4 py-1.5 font-semibold text-white hover:bg-slate-800 disabled:opacity-50">
              Done
            </button>
          </footer>
        </dialog>
      )}
    </section>
  );
}
