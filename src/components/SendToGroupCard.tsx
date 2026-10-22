import React, { useMemo, useRef, useState } from 'react';
import { ModalCard, secondaryButton } from './ModalCard';
import { apiFor } from '../lib/api';
import { planSend, rowsPaidBy, sendRows } from '../lib/sendToGroup';
import { generateId } from '../constants';
import type { GroupSummary, Member, QueueItem } from '../types';

const rowCount = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

/** Moves Pending rows to another group: copies them there, then deletes the originals. */
const SendToGroupCard: React.FC<{
  rows: QueueItem[];
  fromGroup: GroupSummary;
  groups: GroupSummary[];
  sourceMembers: Member[];
  onClose(): void;
  onSent(targetId: string): void;
  restoreFocus(): HTMLElement | null;
  showToast(message: string, type?: 'error' | 'success'): void;
}> = ({ rows, fromGroup, groups, sourceMembers, onClose, onSent, restoreFocus, showToast }) => {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [targetMembers, setTargetMembers] = useState<Member[] | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<string | null>(null);
  const target = groups.find((g) => g.id === targetId);
  const plan = useMemo(
    () => (targetMembers ? planSend(rows, sourceMembers, targetMembers, generateId) : null),
    [rows, sourceMembers, targetMembers],
  );

  const choose = async (id: string) => {
    latest.current = id;
    setTargetId(id);
    setTargetMembers(null);
    setError(null);
    try {
      const { members } = await apiFor(id).bootstrap();
      if (latest.current === id) setTargetMembers(members); // a slower earlier choice must not win
    } catch (err) {
      if (latest.current !== id) return;
      setTargetId(null); // so picking the same group again retries
      setError(err instanceof Error ? err.message : 'Could not load this group.');
    }
  };

  const send = async () => {
    if (!plan || !target) return;
    setSending(true);
    setError(null);
    try {
      const client = apiFor(target.id);
      const outcome = await sendRows({
        create: (inputs) => client.createQueueItems(inputs).then((r) => r.created.map((row) => row.id)),
        remove: async (ids, revisions) => { await apiFor(fromGroup.id).deleteQueueItems(ids, revisions); },
      }, rows, plan.inputs);
      const sent = rows.length - outcome.notCopied;
      if (sent === 0) {
        showToast(`Nothing was sent to ${target.name}. ${rowCount(rows.length)} stayed in ${fromGroup.name}.`, 'error');
      } else if (outcome.result === 'copied-not-removed') {
        showToast(`Copied to ${target.name}, but the originals are still in ${fromGroup.name}. Delete them there.`, 'error');
      } else if (outcome.notCopied > 0) {
        showToast(`Sent ${rowCount(sent)} to ${target.name}. ${outcome.notCopied} stayed in ${fromGroup.name}.`, 'error');
      } else {
        showToast(`Sent ${rowCount(sent)} to ${target.name}`, 'success');
      }
      onSent(target.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send these rows.');
      setSending(false);
    }
  };

  return (
    <ModalCard
      title="Send to group"
      busy={sending}
      onClose={onClose}
      restoreFocus={restoreFocus}
      footer={<>
        <button type="button" disabled={sending} onClick={onClose} className={secondaryButton}>Cancel</button>
        <button type="button" disabled={sending || !plan} aria-busy={sending} onClick={() => void send()} className="min-h-9 pointer-coarse:min-h-11 rounded-lg bg-slate-900 px-4 py-1.5 text-white font-semibold hover:bg-slate-800 disabled:opacity-50">
          {sending ? 'Sending…' : 'Send'}
        </button>
      </>}
    >
      <fieldset disabled={sending} className="space-y-1">
        <legend className="mb-2 text-body1">Send {rowCount(rows.length)} from {fromGroup.name} to:</legend>
        {groups.filter((g) => g.id !== fromGroup.id).map((g) => (
          <label key={g.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-slate-200 px-3 has-[:checked]:border-slate-900 has-[:checked]:bg-slate-50">
            <input type="radio" name="send-target" value={g.id} checked={targetId === g.id} onChange={() => void choose(g.id)} className="h-4 w-4 accent-slate-900" />
            <span className="font-semibold">{g.name}</span>
          </label>
        ))}
      </fieldset>
      <div role="status" aria-atomic="true" className="mt-3 space-y-1 text-body1">
        {target && !plan && !error && <p className="text-slate-500">Loading {target.name}…</p>}
        {target && plan && <>
          <p>{rowCount(rows.length)} will move to {target.name}. Card and split reset to the group's equal split.</p>
          {plan.unmatchedPayers.map((name) => (
            <p key={name} className="text-amber-800">
              {name} is not in {target.name}. {rowCount(rowsPaidBy(rows, sourceMembers, name))} will arrive without a payer.
            </p>
          ))}
        </>}
      </div>
      {error && <p role="alert" className="mt-3 text-body1 text-red-700">{error}</p>}
    </ModalCard>
  );
};

export default SendToGroupCard;
