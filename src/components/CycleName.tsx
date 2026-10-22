import React, { useId, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { ModalCard, secondaryButton } from './ModalCard';

interface Props {
  /** Saved name, or null while the cycle shows its default. */
  name: string | null;
  defaultName: string;
  /** Names the cycle in the button label, such as "current cycle". */
  label: string;
  /** Rejects to keep the card open with the error message. */
  onSave: (name: string | null) => Promise<void>;
  className?: string;
}

/** Cycle name with a rename card. A blank name saves null, which restores the default. */
const CycleName: React.FC<Props> = ({ name, defaultName, label, onSave, className = 'text-body1 font-semibold text-slate-800' }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const formId = useId();
  const inputId = useId();

  const close = () => { setDraft(null); setError(null); };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(draft!.trim() || null);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename this cycle.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className={`min-w-0 break-words ${className}`}>{name ?? defaultName}</span>
      <button
        ref={opener}
        type="button"
        aria-label={`Rename ${label}`}
        onClick={() => setDraft(name ?? '')}
        className="inline-flex h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
      >
        <Pencil size={14} aria-hidden="true" />
      </button>
      {draft !== null && (
        <ModalCard
          title="Rename cycle"
          busy={saving}
          onClose={close}
          restoreFocus={() => opener.current}
          footer={<>
            <button type="button" disabled={saving} onClick={close} className={secondaryButton}>Cancel</button>
            <button type="submit" form={formId} disabled={saving} aria-busy={saving} className="min-h-9 pointer-coarse:min-h-11 rounded-lg bg-slate-900 px-4 py-1.5 text-white font-semibold hover:bg-slate-800 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>}
        >
          <form id={formId} onSubmit={(e) => void save(e)} className="space-y-2">
            <label htmlFor={inputId} className="block text-body2 font-semibold text-slate-600">Cycle name</label>
            <input
              id={inputId}
              autoFocus
              maxLength={80}
              value={draft}
              placeholder={defaultName}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-body1 focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-60"
            />
            <p className="text-body2 text-slate-500">Leave blank to use the default name.</p>
            {error && <p role="alert" className="text-body1 text-red-700">{error}</p>}
          </form>
        </ModalCard>
      )}
    </div>
  );
};

export default CycleName;
