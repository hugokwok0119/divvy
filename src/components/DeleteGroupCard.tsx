import React, { useEffect, useId, useRef, useState } from 'react';
import { ModalCard, secondaryButton } from './ModalCard';
import { api, ApiError } from '../lib/api';
import { isDemoMode } from '../lib/demo-mode';

const DeleteGroupCard: React.FC<{
  groupName: string;
  people: string[];
  onClose(): void;
  onDeleted(): void;
  restoreFocus(): HTMLElement | null;
}> = ({ groupName, people, onClose, onDeleted, restoreFocus }) => {
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmInput = useRef<HTMLInputElement>(null);
  // After ModalCard's showModal(), which would otherwise move focus to its Close button.
  useEffect(() => { confirmInput.current?.focus(); }, []);
  const formId = useId();
  const confirmId = useId();
  const matches = typed.trim() === groupName;

  const erase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!matches) return;
    setDeleting(true);
    setError(null);
    try {
      await api.deleteGroup();
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete this group.');
      setDeleting(false);
    }
  };

  return (
    <ModalCard
      title={`Delete ${groupName}?`}
      busy={deleting}
      onClose={onClose}
      restoreFocus={restoreFocus}
      footer={<>
        <button type="button" disabled={deleting} onClick={onClose} className={secondaryButton}>Cancel</button>
        <button type="submit" form={formId} disabled={deleting || !matches} aria-busy={deleting} className="min-h-9 pointer-coarse:min-h-11 rounded-lg bg-red-600 px-4 py-1.5 text-white font-semibold hover:bg-red-700 disabled:opacity-50">
          {deleting ? 'Deleting…' : 'Delete group'}
        </button>
      </>}
    >
      <form id={formId} onSubmit={(e) => void erase(e)} className="space-y-3">
        <p className="text-body1">This erases every expense, Pending item, cycle, member, card, category and reminder tick in this group, for everyone. This cannot be undone.</p>
        {people.length > 0 && (
          <p className="text-body1">{new Intl.ListFormat('en', { type: 'conjunction' }).format(people)} will lose access.</p>
        )}
        {!isDemoMode() && (
          <a href={api.exportUrl()} download="divvy-export.json" className="inline-flex min-h-9 pointer-coarse:min-h-11 items-center text-body1 font-semibold text-blue-700 underline hover:text-blue-800">
            Download this group's data first
          </a>
        )}
        <div className="space-y-1">
          <label htmlFor={confirmId} className="block text-body2 font-semibold text-slate-600">Type {groupName} to confirm</label>
          <input id={confirmId} ref={confirmInput} value={typed} disabled={deleting} autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-body1 focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-60" />
        </div>
        {error && <p role="alert" className="text-body1 text-red-700">{error}</p>}
      </form>
    </ModalCard>
  );
};

export default DeleteGroupCard;
