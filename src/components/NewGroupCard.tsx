import React, { useEffect, useId, useRef, useState } from 'react';
import { ModalCard, secondaryButton } from './ModalCard';
import { api, ApiError } from '../lib/api';
import type { GroupSummary } from '../types';

const field = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-body1 focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-60';
const label = 'block text-body2 font-semibold text-slate-600';

const NewGroupCard: React.FC<{
  defaultCurrency: string;
  onClose(): void;
  onCreated(group: GroupSummary): void;
  restoreFocus(): HTMLElement | null;
}> = ({ defaultCurrency, onClose, onCreated, restoreFocus }) => {
  const [name, setName] = useState('');
  const [currencyCode, setCurrencyCode] = useState(defaultCurrency);
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  // After ModalCard's showModal(), which would otherwise move focus to its Close button.
  useEffect(() => { nameInput.current?.focus(); }, []);
  const formId = useId();
  const nameId = useId();
  const currencyId = useId();
  const timezoneId = useId();

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onCreated(await api.createGroup({ name: name.trim(), currencyCode: currencyCode.trim().toUpperCase(), timezone: timezone.trim() }));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 400
        ? 'Check the name, the three-letter currency code and the time zone.'
        : err instanceof Error ? err.message : 'Could not create this group.');
      setSaving(false);
    }
  };

  return (
    <ModalCard
      title="New group"
      busy={saving}
      onClose={onClose}
      restoreFocus={restoreFocus}
      footer={<>
        <button type="button" disabled={saving} onClick={onClose} className={secondaryButton}>Cancel</button>
        <button type="submit" form={formId} disabled={saving} aria-busy={saving} className="min-h-9 pointer-coarse:min-h-11 rounded-lg bg-slate-900 px-4 py-1.5 text-white font-semibold hover:bg-slate-800 disabled:opacity-50">
          {saving ? 'Creating…' : 'Create'}
        </button>
      </>}
    >
      <form id={formId} onSubmit={(e) => void create(e)} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor={nameId} className={label}>Name</label>
          <input id={nameId} ref={nameInput} required maxLength={80} value={name} disabled={saving}
            onChange={(e) => setName(e.target.value)} className={field} />
        </div>
        <div className="space-y-1">
          <label htmlFor={currencyId} className={label}>Currency</label>
          <input id={currencyId} required pattern="[A-Za-z]{3}" maxLength={3} value={currencyCode} disabled={saving}
            autoCapitalize="characters" title="A three-letter code such as CAD"
            onChange={(e) => setCurrencyCode(e.target.value)} className={`${field} uppercase`} />
        </div>
        <div className="space-y-1">
          <label htmlFor={timezoneId} className={label}>Timezone</label>
          <input id={timezoneId} required value={timezone} disabled={saving}
            onChange={(e) => setTimezone(e.target.value)} className={field} />
          <p className="text-body2 text-slate-500">Such as America/Vancouver.</p>
        </div>
        {error && <p role="alert" className="text-body1 text-red-700">{error}</p>}
      </form>
    </ModalCard>
  );
};

export default NewGroupCard;
