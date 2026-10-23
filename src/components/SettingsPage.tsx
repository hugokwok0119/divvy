
import React, { useEffect, useRef, useState } from 'react';
import { Member, Card } from '../types';
import { api, ApiError } from '../lib/api';
import { Settings, CreditCard, User as UserIcon, Tag, Plus, X, ArrowLeft, Download, RefreshCw, Trash2, GripVertical } from 'lucide-react';
import { CATEGORIES, generateId } from '../constants';
import { permissionsFor, type Role } from '../lib/permissions';
import { isDemoMode } from '../lib/demo-mode';
import { useReorder } from './useReorder';
import { ModalCard, secondaryButton } from './ModalCard';

interface Props {
  members: Member[];
  cards: Card[];
  customCategories: string[];
  rentReminder: boolean;
  role: Role;
  onBack: () => void;
  onChanged: () => Promise<void>;
  showToast: (message: string, type?: 'error' | 'success') => void;
}

const gripButton = 'inline-flex h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600 active:cursor-grabbing';

const SettingsPage: React.FC<Props> = ({ members, cards, customCategories, rentReminder, role, onBack, onChanged, showToast }) => {
  const perms = permissionsFor(role);
  const [newCategory, setNewCategory] = useState('');
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [dayDrafts, setDayDrafts] = useState<Record<string, string>>({});
  const [cardSave, setCardSave] = useState<{
    card: Card;
    input: { id: string; memberId: string; name: string; statementDay: number | null };
    preview: { cycles: number; expenses: number } | null;
    applyToHistory: boolean;
    saving: boolean;
  } | null>(null);
  const [cardDelete, setCardDelete] = useState<{ card: Card; opener: HTMLElement | null; deleting: boolean } | null>(null);
  const [memberRemove, setMemberRemove] = useState<{ member: Member; opener: HTMLElement | null; removing: boolean } | null>(null);
  const [duplicateCategory, setDuplicateCategory] = useState<string | null>(null);
  const cardDialog = useRef<HTMLDialogElement>(null);
  const cardTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = cardDialog.current, trigger = cardTrigger.current, id = cardSave?.input.id;
    if (!cardSave || !dialog) return;
    dialog.showModal();
    return () => {
      dialog.close();
      (trigger?.isConnected && trigger !== document.body ? trigger : document.getElementById(`card-name-${id}`))?.focus();
    };
  }, [cardSave?.input]);

  const withErrorToast = async (action: () => Promise<void>, fallback: string) => {
    try {
      await action();
      await onChanged();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : fallback);
    }
  };

  const activeMembers = members.filter((m) => !m.archivedAt);
  const activeCards = new Map(cards.filter((c) => !c.archived).map((c) => [c.id, c]));
  const memberOrder = useReorder('members', activeMembers.map((m) => m.id), () => '',
    (ids) => withErrorToast(() => api.reorderMembers(ids).then(() => undefined), 'Could not reorder members.'));
  const cardOrder = useReorder('cards', [...activeCards.keys()], (id) => activeCards.get(id)!.memberId,
    (ids) => withErrorToast(() => api.reorderCards(ids).then(() => undefined), 'Could not reorder cards.'));
  const nextSortOrder = (rows: { sortOrder: number }[]) => Math.max(-1, ...rows.map((row) => row.sortOrder)) + 1;

  const confirmCardDelete = async () => {
    if (!cardDelete) return;
    setCardDelete({ ...cardDelete, deleting: true });
    await withErrorToast(() => api.deleteCard(cardDelete.card.id), 'Could not delete that card.');
    setCardDelete(null);
  };

  const confirmMemberRemove = async () => {
    if (!memberRemove) return;
    setMemberRemove({ ...memberRemove, removing: true });
    await withErrorToast(() => api.deleteMember(memberRemove.member.id), 'Could not remove that member.');
    setMemberRemove(null);
  };

  const renameMember = (member: Member, displayName: string) => {
    if (!displayName.trim() || displayName === member.displayName) return;
    void withErrorToast(
      () => api.upsertMember({ id: member.id, displayName: displayName.trim() }).then(() => undefined),
      'Could not rename that member.',
    );
  };

  const cardDraft = (card: Card) => ({
    name: (nameDrafts[card.id] ?? card.name).trim(),
    day: dayDrafts[card.id] ?? String(card.statementDay ?? ''),
  });
  const cardDirty = (card: Card) => {
    const draft = cardDraft(card);
    return draft.name !== card.name || draft.day !== String(card.statementDay ?? '');
  };

  // Name or statement day changes always ask whether closed-cycle labels follow.
  const saveCard = async (card: Card) => {
    const draft = cardDraft(card);
    if (!draft.name || !cardDirty(card)) return;
    const input = { id: card.id, memberId: card.memberId, name: draft.name, statementDay: draft.day ? Number(draft.day) : null };
    cardTrigger.current = document.activeElement as HTMLElement | null;
    setCardSave({ card, input, preview: null, applyToHistory: false, saving: false });
    try {
      const preview = await api.previewCardHistory(input);
      setCardSave((current) => current?.input === input ? { ...current, preview } : current);
    } catch (err) {
      setCardSave((current) => current?.input === input ? null : current);
      showToast(err instanceof ApiError ? err.message : 'Could not check past cycles for that card.');
    }
  };

  const closeCardSave = () => { if (!cardSave?.saving) setCardSave(null); };

  const confirmCardSave = async () => {
    if (!cardSave) return;
    setCardSave({ ...cardSave, saving: true });
    await withErrorToast(
      () => api.upsertCard({ ...cardSave.input, applyToHistory: cardSave.applyToHistory }).then(() => undefined),
      'Could not save that card.',
    );
    setCardSave(null);
  };

  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const dayText = (day: number | null) => (day === null ? '–' : String(day));

  const addCard = (memberId: string) => {
    void withErrorToast(
      () => api.upsertCard({ id: generateId(), memberId, name: 'New Card', sortOrder: nextSortOrder(cards) }).then(() => undefined),
      'Could not add a card.',
    );
  };

  const addMember = () => {
    void withErrorToast(
      () => api.upsertMember({ id: generateId(), displayName: 'New Member', sortOrder: nextSortOrder(members) }).then(() => undefined),
      'Could not add a member.',
    );
  };

  const addCategory = () => {
    const value = newCategory.trim();
    if (!value) return;
    const existing = [...CATEGORIES, ...customCategories].find((c) => c.toLowerCase() === value.toLowerCase());
    if (existing) { setDuplicateCategory(existing); return; }
    void withErrorToast(
      () => api.updateHousehold({ customCategories: [...customCategories, value] }).then(() => undefined),
      'Could not add that category.',
    );
    setNewCategory('');
  };

  const removeCategory = (cat: string) => {
    void withErrorToast(
      () => api.updateHousehold({ customCategories: customCategories.filter((c) => c !== cat) }).then(() => undefined),
      'Could not remove that category.',
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300 pb-10">

      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-200 pb-4">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-700 font-bold transition-colors shadow-sm"
          >
            <ArrowLeft size={18} />
            Back
          </button>
          <h2 className="text-heading1 font-bold text-slate-800 flex items-center gap-2">
            <Settings className="text-blue-600" />
            Settings
          </h2>
        </div>
      </div>

      {cardSave && (
        <dialog
          ref={cardDialog}
          aria-labelledby="card-save-title"
          className="m-auto w-[calc(100vw-32px)] max-w-[420px] rounded-xl border border-slate-200 bg-white p-0 text-slate-700 shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
          onCancel={(e) => { e.preventDefault(); closeCardSave(); }}
          onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            const box = e.currentTarget.getBoundingClientRect();
            if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) closeCardSave();
          }}
        >
          <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-3">
            <h2 id="card-save-title" className="text-heading2 text-slate-800">Save {cardSave.card.name} changes</h2>
            <button type="button" aria-label="Close card changes" disabled={cardSave.saving} onClick={closeCardSave} className="inline-flex h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-50">
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          <div className="space-y-3 px-5 py-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-body1">
              {cardSave.input.name !== cardSave.card.name && (<>
                <dt className="text-slate-500">Name</dt>
                <dd className="min-w-0 break-words">{cardSave.card.name} → {cardSave.input.name}</dd>
              </>)}
              {cardSave.input.statementDay !== cardSave.card.statementDay && (<>
                <dt className="text-slate-500">Ends on</dt>
                <dd>{dayText(cardSave.card.statementDay)} → {dayText(cardSave.input.statementDay)}</dd>
              </>)}
            </dl>
            <div role="radiogroup" aria-label="Apply changes to" className="grid gap-2">
              {([
                [false, 'Current and future', 'Past cycles keep old labels'],
                [true, 'Also past cycles', !cardSave.preview ? 'Counting past cycles…'
                  : cardSave.preview.expenses === 0 ? 'No past cycles to relabel'
                    : `Relabels ${plural(cardSave.preview.cycles, 'cycle')} · ${plural(cardSave.preview.expenses, 'expense')}`],
              ] as const).map(([value, title, subtitle]) => (
                <label key={title} className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 px-3 py-2 has-checked:border-blue-600 has-checked:bg-blue-50 has-focus-visible:ring-2 has-focus-visible:ring-blue-500 has-disabled:cursor-not-allowed has-disabled:opacity-60">
                  <input
                    type="radio"
                    name="card-save-scope"
                    className="mt-1 accent-blue-600"
                    checked={cardSave.applyToHistory === value}
                    disabled={cardSave.saving || (value && !cardSave.preview)}
                    onChange={() => setCardSave((current) => current && { ...current, applyToHistory: value })}
                  />
                  <span>
                    <span className="block text-body1 font-semibold text-slate-800">{title}</span>
                    <span className="block text-body2 text-slate-500">{subtitle}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
            <button type="button" disabled={cardSave.saving} onClick={closeCardSave} className="min-h-9 pointer-coarse:min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold hover:bg-slate-50 disabled:opacity-50">
              Cancel
            </button>
            <button type="button" disabled={cardSave.saving} aria-busy={cardSave.saving} onClick={() => void confirmCardSave()} className="min-h-9 pointer-coarse:min-h-11 rounded-lg bg-slate-900 px-4 py-1.5 text-white font-semibold hover:bg-slate-800 disabled:opacity-50">
              {cardSave.saving ? 'Saving…' : 'Save'}
            </button>
          </footer>
        </dialog>
      )}

      {cardDelete && (
        <ModalCard
          title={`Delete ${cardDelete.card.name}?`}
          busy={cardDelete.deleting}
          onClose={() => setCardDelete(null)}
          restoreFocus={() => (cardDelete.opener?.isConnected ? cardDelete.opener : document.getElementById(`add-card-${cardDelete.card.memberId}`))}
          footer={<>
            <button type="button" disabled={cardDelete.deleting} onClick={() => setCardDelete(null)} className={secondaryButton}>Cancel</button>
            <button type="button" disabled={cardDelete.deleting} aria-busy={cardDelete.deleting} onClick={() => void confirmCardDelete()} className="min-h-9 pointer-coarse:min-h-11 rounded-lg bg-red-600 px-4 py-1.5 text-white font-semibold hover:bg-red-700 disabled:opacity-50">
              {cardDelete.deleting ? 'Deleting…' : 'Delete card'}
            </button>
          </>}
        >
          <p>It disappears from card pickers and reminders. Past expenses keep showing this card's name.</p>
        </ModalCard>
      )}

      {memberRemove && (
        <ModalCard
          title={`Remove ${memberRemove.member.displayName}?`}
          busy={memberRemove.removing}
          onClose={() => setMemberRemove(null)}
          restoreFocus={() => (memberRemove.opener?.isConnected ? memberRemove.opener : document.getElementById('add-member'))}
          footer={<>
            <button type="button" disabled={memberRemove.removing} onClick={() => setMemberRemove(null)} className={secondaryButton}>Cancel</button>
            <button type="button" disabled={memberRemove.removing} aria-busy={memberRemove.removing} onClick={() => void confirmMemberRemove()} className="min-h-9 pointer-coarse:min-h-11 rounded-lg bg-red-600 px-4 py-1.5 text-white font-semibold hover:bg-red-700 disabled:opacity-50">
              {memberRemove.removing ? 'Removing…' : 'Remove member'}
            </button>
          </>}
        >
          <p>They lose access to this household, and they and their cards leave member lists, split choices and card pickers. Expenses they paid or share keep their name and still count in balances.</p>
        </ModalCard>
      )}

      {duplicateCategory && (
        <ModalCard
          title="Category already exists"
          onClose={() => setDuplicateCategory(null)}
          restoreFocus={() => document.getElementById('new-category-name')}
          footer={<button type="button" onClick={() => setDuplicateCategory(null)} className="min-h-9 pointer-coarse:min-h-11 rounded-lg bg-slate-900 px-4 py-1.5 text-white font-semibold hover:bg-slate-800">OK</button>}
        >
          <p>"{duplicateCategory}" is already a category.</p>
        </ModalCard>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">

        <div className="space-y-8">
          {/* Member Profiles Section */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-800">Members</h3>
              {perms.canManageMembers && (
                <button type="button" id="add-member" onClick={addMember} className="text-sm bg-blue-50 text-blue-700 px-3 py-1.5 rounded-lg font-semibold hover:bg-blue-100 transition-colors">
                  + Add Member
                </button>
              )}
            </div>
            {!perms.canManageMembers && (
              <p className="text-xs text-slate-400 italic">Only the household owner can rename members or add cards.</p>
            )}

            <div className="space-y-4">
              {memberOrder.order.map((id) => activeMembers.find((m) => m.id === id)!).map((member) => (
                <div key={member.id} {...memberOrder.item(member.id)} className={`bg-white border border-slate-200 rounded-xl p-5 shadow-sm relative group ${memberOrder.dragging === member.id ? 'opacity-60 ring-2 ring-blue-200' : ''}`}>
                  <div className="flex items-center gap-3 mb-4">
                    {perms.canManageMembers && (
                      <button {...memberOrder.grip(member.id, `member ${member.displayName}`)} className={`${gripButton} -ml-2`}>
                        <GripVertical size={16} aria-hidden="true" />
                      </button>
                    )}
                    <div className="bg-slate-100 p-2 rounded-full">
                      <UserIcon size={20} className="text-slate-500" aria-hidden="true" />
                    </div>
                    <label htmlFor={`member-name-${member.id}`} className="sr-only">Member name</label>
                    <input
                      id={`member-name-${member.id}`}
                      className="font-bold text-lg text-slate-800 bg-transparent border-b border-transparent focus:border-blue-500 outline-none w-full placeholder-slate-400 disabled:cursor-not-allowed disabled:opacity-70"
                      value={nameDrafts[member.id] ?? member.displayName}
                      onChange={(e) => setNameDrafts({ ...nameDrafts, [member.id]: e.target.value })}
                      onBlur={(e) => renameMember(member, e.target.value)}
                      placeholder="Member name"
                      disabled={!perms.canManageMembers}
                    />
                    {perms.canManageMembers && member.role !== 'owner' && (
                      <button
                        type="button"
                        aria-label={`Remove member ${member.displayName}`}
                        onClick={(e) => setMemberRemove({ member, opener: e.currentTarget, removing: false })}
                        className="inline-flex h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    )}
                  </div>

                  <div className="space-y-3 pl-3 border-l-2 border-slate-100 ml-3">
                    {cardOrder.order.map((id) => activeCards.get(id)!).filter((c) => c.memberId === member.id).map((card) => (
                      <form key={card.id} {...cardOrder.item(card.id)} className={`flex flex-wrap items-center gap-2 rounded-lg ${cardOrder.dragging === card.id ? 'opacity-60 ring-2 ring-blue-200' : ''}`} onSubmit={(e) => { e.preventDefault(); void saveCard(card); }}>
                        {perms.canManageCards && (
                          <button {...cardOrder.grip(card.id, `card ${card.name}`)} className={`${gripButton} -ml-1`}>
                            <GripVertical size={14} aria-hidden="true" />
                          </button>
                        )}
                        <CreditCard size={14} className="text-slate-400 shrink-0" aria-hidden="true" />
                        <label htmlFor={`card-name-${card.id}`} className="sr-only">Card name</label>
                        <input
                          id={`card-name-${card.id}`}
                          className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded px-3 py-1.5 flex-1 min-w-40 focus:ring-1 focus:ring-blue-500 outline-none disabled:cursor-not-allowed disabled:opacity-70"
                          value={nameDrafts[card.id] ?? card.name}
                          onChange={(e) => setNameDrafts({ ...nameDrafts, [card.id]: e.target.value })}
                          disabled={!perms.canManageCards}
                        />
                        <span className="flex items-center gap-1.5">
                          <label htmlFor={`card-day-${card.id}`} className="text-body2 text-slate-500 shrink-0">Ends on:</label>
                          <select
                            id={`card-day-${card.id}`}
                            aria-label={`Ends on for ${card.name}`}
                            className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded px-2 py-1.5 focus:ring-1 focus:ring-blue-500 outline-none disabled:cursor-not-allowed disabled:opacity-70"
                            value={cardDraft(card).day}
                            onChange={(e) => setDayDrafts({ ...dayDrafts, [card.id]: e.target.value })}
                            disabled={!perms.canManageCards}
                          >
                            <option value="">–</option>
                            {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
                          </select>
                        </span>
                        {perms.canManageCards && cardDirty(card) && cardDraft(card).name && (
                          <button type="submit" className="text-sm bg-blue-50 text-blue-700 px-3 py-1.5 rounded-lg font-semibold hover:bg-blue-100 transition-colors shrink-0">
                            Save card
                          </button>
                        )}
                        {perms.canManageCards && (
                          <button
                            type="button"
                            aria-label={`Delete card ${card.name}`}
                            onClick={(e) => setCardDelete({ card, opener: e.currentTarget, deleting: false })}
                            className="inline-flex h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        )}
                      </form>
                    ))}
                    {perms.canManageCards && (
                      <button type="button" id={`add-card-${member.id}`} onClick={() => addCard(member.id)} className="text-xs text-blue-600 font-bold hover:underline py-1">
                        + Add Another Card
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Categories Section */}
          <section className="space-y-4">
            <h3 className="text-lg font-bold text-slate-800">Custom Categories</h3>
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              {perms.canManageCategories ? (
                <div className="flex gap-3 mb-4">
                  <label htmlFor="new-category-name" className="sr-only">New category name</label>
                  <input
                    id="new-category-name"
                    type="text"
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } }}
                    className="flex-1 px-4 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="Type category name..."
                  />
                  <button
                    type="button"
                    onClick={addCategory}
                    aria-label="Add category"
                    className="bg-slate-900 hover:bg-slate-800 text-white px-4 rounded-lg transition-colors"
                  >
                    <Plus size={20} aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <p className="text-xs text-slate-400 italic mb-4">Only the household owner can add or remove custom categories.</p>
              )}

              <div className="flex flex-wrap gap-2">
                {customCategories.map((cat) => (
                  <span key={cat} className="bg-blue-50 text-blue-700 px-3 py-1.5 rounded-lg text-sm font-medium flex items-center gap-2 border border-blue-100">
                    <Tag size={12} aria-hidden="true" />
                    {cat}
                    {perms.canManageCategories && (
                      <button type="button" onClick={() => removeCategory(cat)} aria-label={`Remove category ${cat}`} className="hover:text-red-500 hover:bg-red-50 rounded-full p-0.5 transition-colors">
                        <X size={12} aria-hidden="true" />
                      </button>
                    )}
                  </span>
                ))}
                {customCategories.length === 0 && (
                  <span className="text-slate-400 text-sm italic">No custom categories added yet.</span>
                )}
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <h3 className="text-heading2 text-slate-800">Reminders</h3>
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
              <label className="flex min-h-11 items-center gap-3 text-body1 text-slate-700">
                <input
                  type="checkbox"
                  checked={rentReminder}
                  disabled={role !== 'owner'}
                  onChange={(e) => void withErrorToast(
                    () => api.updateHousehold({ rentReminder: e.target.checked }).then(() => undefined),
                    'Could not save the rent reminder.',
                  )}
                  className="h-5 w-5 accent-blue-600"
                />
                Remind me about rent at month end
              </label>
              {role !== 'owner' && (
                <p className="text-body2 text-slate-400 italic">Only the household owner can change reminders.</p>
              )}
            </div>
          </section>
        </div>

        {/* Data Section */}
        <div className="space-y-6">
          <div className="flex items-center gap-2 mb-2">
            <RefreshCw className="text-blue-600" />
            <h3 className="text-lg font-bold text-slate-800">Your Data</h3>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 shadow-sm">
            <p className="text-sm text-slate-600 mb-4">
              Divvy keeps everything on the server, shared with your household. Download a full
              copy any time.
            </p>
            {!isDemoMode() && perms.canExportData ? (
              <a
                href={api.exportUrl()}
                download="divvy-export.json"
                className="block w-full text-center rounded-lg border border-slate-300 py-2 text-sm font-medium hover:bg-slate-50 bg-white"
              >
                <Download size={16} className="inline mr-2 -mt-0.5" />
                Download my data (JSON)
              </a>
            ) : (
              <p className="text-xs text-slate-400 italic">
                {isDemoMode() ? 'Export is off in the demo.' : 'Only the household owner can export the full household data.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
