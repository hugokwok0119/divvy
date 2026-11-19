import React, { useState } from 'react';
import type { Member } from '../types';
import { memberColorAt } from '../lib/memberColors';
import { ModalCard, secondaryButton } from './ModalCard';

interface Props {
  members: Member[];
  groupName: string;
  locked: boolean;
  canEdit: boolean;
  onSave(inIds: string[]): Promise<void>;
  onClose(): void;
  restoreFocus(): HTMLElement | null;
}

/** Who is in the open cycle. Members left out sit out: no share, no split button, still a payer. */
const MembersCard: React.FC<Props> = ({ members, groupName, locked, canEdit, onSave, onClose, restoreFocus }) => {
  const [inIds, setInIds] = useState(() => new Set(members.filter((m) => m.archivedAt === null && m.sittingOutAt === null).map((m) => m.id)));
  const [saving, setSaving] = useState(false);
  // Shown in the card: a toast would sit under the modal's top layer.
  const [error, setError] = useState<string | null>(null);
  const editable = canEdit && !locked;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(members.filter((m) => inIds.has(m.id)).map((m) => m.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save who is in.');
    } finally {
      setSaving(false);
    }
  };
  const toggle = (id: string) => setInIds((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const footer = editable ? <>
    <button type="button" className={secondaryButton} disabled={saving} onClick={onClose}>Cancel</button>
    <button type="button" disabled={saving || inIds.size === 0} aria-busy={saving} onClick={() => void save()}
      className="min-h-9 pointer-coarse:min-h-11 rounded-lg bg-slate-900 px-4 py-1.5 text-white font-semibold hover:bg-slate-800 disabled:opacity-50">
      Save
    </button>
  </> : <button type="button" className={secondaryButton} onClick={onClose}>Close</button>;
  return (
    <ModalCard title="Who is in this cycle?" busy={saving} onClose={onClose} restoreFocus={restoreFocus} footer={footer}>
      <p className="-mt-2 mb-3 text-body2 text-slate-500">{groupName}</p>
      <ul className="space-y-1">
        {members.map((member, index) => member.archivedAt === null && (
          <li key={member.id}>
            <label className="flex min-h-11 items-center gap-3 rounded-lg px-2 hover:bg-slate-50">
              <input type="checkbox" className="h-4 w-4 shrink-0 accent-blue-600" checked={inIds.has(member.id)} disabled={!editable || saving} onChange={() => toggle(member.id)} />
              <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: memberColorAt(index) }} />
              {member.displayName}
            </label>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-body2 text-slate-500">Anyone left out sits out this cycle. They get no share and no split button, and they can still be the payer.</p>
      {editable && inIds.size === 0 && <p role="alert" className="mt-2 text-body2 text-red-700">At least one person must be in.</p>}
      {locked && <p className="mt-3 text-body1 text-slate-700">Locked while this cycle has Pending or Approved expenses. Close the cycle to change who is in.</p>}
      {!locked && !canEdit && <p className="mt-3 text-body1 text-slate-700">Only the group owner can change who is in.</p>}
      {error && <p role="alert" className="mt-3 text-body1 text-red-700">{error}</p>}
    </ModalCard>
  );
};

export default MembersCard;
