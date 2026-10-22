import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { X } from 'lucide-react';
import type { ExpenseHistoryEvent, Member, Card, ClosingSnapshot, Transaction } from '../types';
import { expenseDifferences, visibleExpenseHistory } from './ledger';

export default function ExpenseHistory({
  expenseId,
  members,
  cards,
  onClose,
  closingSnapshot,
  current,
  client = api,
}: {
  expenseId: string;
  members: Member[];
  cards: Card[];
  onClose: () => void;
  closingSnapshot?: ClosingSnapshot | null;
  current?: Transaction;
  /** The group the expense belongs to; a section for another group passes its pinned client. */
  client?: typeof api;
}) {
  const [events, setEvents] = useState<ExpenseHistoryEvent[] | null>(null);
  const [error, setError] = useState('');
  const historyDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let active = true;
    void client
      .expenseHistory(expenseId)
      .then((rows) => {
        if (active) setEvents(visibleExpenseHistory(rows).sort((a, b) => b.timestamp - a.timestamp || b.after.revision - a.after.revision));
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Could not load edit history.');
      });
    return () => {
      active = false;
    };
  }, [expenseId, client]);
  useEffect(() => {
    const dialog = historyDialog.current, trigger = document.activeElement as HTMLElement | null;
    if (!dialog) return;
    dialog.showModal();
    return () => { dialog.close(); if (trigger?.isConnected) trigger.focus(); };
  }, []);
  const names = Object.fromEntries([
    ...members.map((m) => [m.id, m.displayName]),
    ...cards.map((c) => [c.id, c.name]),
  ]);
  const original = closingSnapshot?.transactions.find((tx) => tx.expenseId === expenseId);
  const eventView = (event: ExpenseHistoryEvent) => (
    <article key={event.id} className="space-y-2 border-t border-slate-200 py-3">
      <p className={`font-semibold ${['edited', 'category_suggestion'].includes(event.eventType) ? 'text-orange-600' : ''}`}>
        {event.eventType === 'legacy_baseline'
          ? 'Legacy baseline · actor unknown'
          : `${event.eventType.replaceAll('_', ' ')} · ${event.actorName ?? 'Actor unknown'}`}
      </p>
      {event.expenseId !== expenseId && <p className="text-xs text-slate-500">Source expense · {event.expenseId}</p>}
      {!!event.after.parentExpenseId && <p className="text-xs text-slate-500">Separated from source · {String(event.after.parentExpenseId)}</p>}
      <time className="text-xs text-slate-500">{new Date(event.timestamp).toLocaleString()}</time>
      <dl className="space-y-1 text-sm">
        {(['edited', 'category_suggestion', 'split'].includes(event.eventType) ? expenseDifferences(event.before, event.after, names) : []).map((diff) => (
          <div key={diff.field}>
            <dt className="font-semibold">{diff.field}</dt>
            <dd className="break-words">
              {diff.before} → {diff.after}
            </dd>
          </div>
        ))}
      </dl>
      {event.reviewNote !== null && event.before?.reviewNote !== event.after.reviewNote && (
        <p className="text-sm">Review note: {event.reviewNote || '(cleared)'}</p>
      )}
    </article>
  );
  return (
    <dialog
      ref={historyDialog}
      aria-labelledby="expense-history-title"
      className="ledger-history-dialog"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
      }}
    >
      <div
        className="w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between gap-4">
          <h2 id="expense-history-title" className="text-heading2 font-bold">
            Expense history
          </h2>
          <button className="ledger-icon" aria-label="Close expense history" onClick={onClose}><X size={18} aria-hidden="true" /></button>
        </div>
        {original && current && original.revision !== current.revision && <section className="mt-4 space-y-2">
          <h3 className="font-bold">Changed since closing</h3>
          <dl className="text-sm space-y-1">
            {expenseDifferences(original, { ...current }, names).map((diff) => <div key={diff.field}><dt className="font-semibold">{diff.field}</dt><dd className="break-words">{diff.before} → {diff.after}</dd></div>)}
          </dl>
        </section>}
        {closingSnapshot && !original && <p className="mt-4 text-sm text-amber-700">Added after closing.</p>}
        {error && <p role="alert">{error}</p>}
        {!error && !events && <p>Loading history…</p>}
        {events?.length === 0 && <p>No saved history.</p>}
        {events?.[0] && (
          <>
            <h3 className="mt-4 font-bold">Latest saved change</h3>
            {eventView(events[0])}
          </>
        )}
        {events && events.length > 1 && (
          <details>
            <summary>Earlier history ({events.length - 1})</summary>
            {events.slice(1).map(eventView)}
          </details>
        )}
        <footer className="ledger-allocation-footer"><button onClick={onClose}>Close history</button></footer>
      </div>
    </dialog>
  );
}
