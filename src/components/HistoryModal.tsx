
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Member, Card, Cycle, CycleGroup, Settlement, Transaction, TxPatch, ClosingSnapshot } from '../types';
import { api, ApiError } from '../lib/api';
import {
  formatCentsWithSymbol, closedDateOf, cycleGroupLabel,
  disambiguatedClosedDates, summarizeCycleTransactions, cycleName,
} from '../lib/money';
import { ArrowLeft, Calendar, ChevronRight, ChevronDown, CheckCircle, Download, Edit2, Lock, X } from 'lucide-react';
import TransactionList from './TransactionList';
import CycleName from './CycleName';
import CycleSummaryDialog from './CycleSummaryDialog';
import { buildCycleSummary } from '../lib/cycleSummary';
import { permissionsFor, type Role } from '../lib/permissions';
import { combinedSettlement } from '../lib/settlement';

interface Props {
  members: Member[];
  cards: Card[];
  categories: string[];
  role: Role;
  onBack: () => void;
  onChanged: () => Promise<void>;
  showToast: (message: string, type?: 'error' | 'success') => void;
  householdName: string;
}

type CycleRow = Cycle & { settlement: Settlement; groups: CycleGroup[] };
type CycleDetail = { cycle: Cycle; transactions: Transaction[]; settlement: Settlement };

const transferTotal = (s: Settlement) => s.transfers.reduce((sum, t) => sum + t.amountCents, 0);

// How many cycles the list shows before "Show more" reveals the next batch.
// The list endpoint already returns every cycle, so this only bounds the
// DOM/render cost of a growing history — not a network page size.
const PAGE_SIZE = 20;

const HistoryPage: React.FC<Props> = ({ members, cards, categories, role, onBack, onChanged, showToast, householdName }) => {
  const perms = permissionsFor(role);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [cycleList, setCycleList] = useState<CycleRow[] | null>(null);
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CycleDetail | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // Unpaid cycles picked for the combined preview; empty means all unpaid.
  const [pickedIds, setPickedIds] = useState<string[]>([]);

  const [cycleDateStart, setCycleDateStart] = useState('');
  const [cycleDateEnd, setCycleDateEnd] = useState('');

  const [filterDateStart, setFilterDateStart] = useState('');
  const [filterDateEnd, setFilterDateEnd] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterPayerId, setFilterPayerId] = useState('');
  const [filterCardId, setFilterCardId] = useState('');

  const loadList = useCallback(async () => {
    try {
      setCycleList(await api.cycles());
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not load history.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void loadList(); }, [loadList]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await api.cycle(id));
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not load that cycle.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedCycleId) void loadDetail(selectedCycleId);
    else setDetail(null);
  }, [selectedCycleId, loadDetail]);

  const filteredList = useMemo(() => {
    if (!cycleList) return [];
    return cycleList.filter((cy) => {
      const d = closedDateOf(cy.closedAt);
      if (cycleDateStart && d < cycleDateStart) return false;
      if (cycleDateEnd && d > cycleDateEnd) return false;
      return true;
    });
    // Most recently closed first.
  }, [cycleList, cycleDateStart, cycleDateEnd]);

  // Disambiguated over the full unfiltered list so an id's suffix never
  // shifts as the date filter changes.
  const closedLabels = useMemo(
    () => disambiguatedClosedDates(cycleList ?? []),
    [cycleList],
  );

  const visibleList = filteredList.slice(0, visibleCount);

  // Drop picks that became settled or left the loaded list.
  useEffect(() => {
    if (cycleList) setPickedIds((ids) => combinedSettlement(cycleList, ids).cycleIds);
  }, [cycleList]);

  // Computed over the full loaded list, so filters and "Show more" never change it.
  const outstanding = useMemo(
    // No picks means all unpaid cycles (undefined), never an empty selection.
    () => combinedSettlement(cycleList ?? [], pickedIds.length ? pickedIds : undefined),
    [cycleList, pickedIds],
  );
  const outstandingNotShown = outstanding.cycleIds.filter((id) => !visibleList.some((cy) => cy.id === id)).length;
  const togglePicked = (id: string) =>
    setPickedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const groupLabels = useMemo(() => Object.fromEntries((cycleList ?? []).map((cy) => [
    cy.id, cy.groups.map((g) => cycleGroupLabel(g, cy.closedAt, members, cards)),
  ])), [cycleList, members, cards]);
  const groupText = (g: { label: string; statementDay: number | null }) =>
    g.statementDay === null ? g.label : `${g.label} · statement day ${g.statementDay}`;

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [cycleDateStart, cycleDateEnd]);

  const cycleSummary = useMemo(
    () => (detail ? summarizeCycleTransactions(detail.transactions) : null),
    [detail],
  );

  const clearCycleFilters = () => {
    setCycleDateStart('');
    setCycleDateEnd('');
  };

  const handleMarkSettled = async () => {
    if (!detail || !window.confirm(
      'Mark this cycle as settled? This freezes its current settlement and locks transaction edits.',
    )) return;
    try {
      await api.settleCycle(detail.cycle.id);
      await Promise.all([loadList(), loadDetail(detail.cycle.id), onChanged()]);
      setIsEditing(false);
      showToast('Cycle settled.', 'success');
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not settle this cycle.');
    }
  };

  const handleUndoSettlement = async () => {
    if (!detail || !window.confirm(
      'Undo this settlement? The cycle will return to review and its transactions will become editable.',
    )) return;
    try {
      await api.unsettleCycle(detail.cycle.id);
      await Promise.all([loadList(), loadDetail(detail.cycle.id), onChanged()]);
      setIsEditing(false);
      showToast('Settlement undone.', 'success');
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not undo that settlement.');
    }
  };

  const handleTransactionUpdate = async (id: string, patch: TxPatch, revision: number) => {
    if (!detail) throw new Error('Cycle detail is unavailable.');
    const saved = await api.updateTransaction(id, patch, revision);
    // The list carries the payer/card group labels, so corrections refresh it too.
    await Promise.all([loadList(), loadDetail(detail.cycle.id), onChanged()]);
    return saved;
  };

  const handleTransactionDelete = async (id: string, revision: number) => {
    if (!detail) throw new Error('Cycle detail is unavailable.');
    await api.deleteTransaction(id, revision);
    await Promise.all([loadList(), loadDetail(detail.cycle.id), onChanged()]);
  };

  const nameOf = (id: string) => members.find((m) => m.id === id)?.displayName ?? 'Unknown';
  const canEdit = detail?.cycle.status === 'closed';
  const closingSnapshot = useMemo<ClosingSnapshot | null>(() => {
    try { return detail?.cycle.closingSnapshotJson ? JSON.parse(detail.cycle.closingSnapshotJson) : null; }
    catch { return null; }
  }, [detail?.cycle.closingSnapshotJson]);
  const changedSinceClosing = !!closingSnapshot && (
    closingSnapshot.transactions.length !== detail?.transactions.length ||
    detail?.transactions.some((tx) => closingSnapshot.transactions.find((original) => original.expenseId === tx.expenseId)?.revision !== tx.revision)
  );


  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">

      {/* Header */}
      <div className="flex items-center gap-4 border-b border-slate-200 pb-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-700 font-bold transition-colors shadow-sm"
        >
          <ArrowLeft size={18} />
          Back to Dashboard
        </button>
        <h2 className="text-heading1 font-bold text-slate-800 flex items-center gap-2">
          <Calendar className="text-blue-600" />
          History Archive
        </h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">

        {/* Left List of Cycles */}
        <div className="lg:col-span-1 space-y-4">
          <h3 className="font-bold text-slate-500 uppercase text-xs tracking-wide pl-1">Past Cycles</h3>

          <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm space-y-2">
            <div className="text-xs font-semibold text-slate-500 mb-1">Filter by closing date</div>
            <div className="grid grid-cols-2 gap-2">
              <input type="date" value={cycleDateStart} onChange={(e) => setCycleDateStart(e.target.value)} aria-label="Filter cycles closed from date" className="text-xs p-1.5 border border-slate-200 rounded bg-slate-50 text-slate-700" />
              <input type="date" value={cycleDateEnd} onChange={(e) => setCycleDateEnd(e.target.value)} aria-label="Filter cycles closed to date" className="text-xs p-1.5 border border-slate-200 rounded bg-slate-50 text-slate-700" />
            </div>
            {(cycleDateStart || cycleDateEnd) && (
              <button onClick={clearCycleFilters} className="text-xs text-blue-600 font-medium flex items-center gap-1 hover:underline w-full justify-center pt-1">
                <X size={10} aria-hidden="true" /> Clear Filters
              </button>
            )}
          </div>

          {cycleList?.some((cy) => cy.status !== 'settled') && (
            <section aria-label="Outstanding settlement" className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-heading2 font-semibold text-slate-800">Outstanding</h3>
                {pickedIds.length > 0 && (
                  <button type="button" onClick={() => setPickedIds([])} className="text-body2 text-blue-600 font-semibold hover:underline">
                    Clear selection
                  </button>
                )}
              </div>
              <p aria-live="polite" className="text-body2 text-slate-500">
                {pickedIds.length ? `Selected (${outstanding.cycleIds.length})` : `All unpaid cycles (${outstanding.cycleIds.length})`}
                {outstandingNotShown > 0 && ` · ${outstandingNotShown} not shown in the list below`}
              </p>
              {outstanding.transfers.length === 0 ? (
                <p className="text-body1 font-semibold text-slate-700">Nothing outstanding</p>
              ) : (
                <ul className="space-y-1">
                  {outstanding.transfers.map((t) => (
                    <li key={`${t.from}-${t.to}`} className="text-body1 text-slate-700">
                      {nameOf(t.from)} owes {nameOf(t.to)} <span className="font-semibold text-slate-900">{formatCentsWithSymbol(t.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-body2 text-slate-500">
                Preview only. {perms.canSettleCycle
                  ? 'Mark each cycle settled from its details.'
                  : 'Only the household owner can mark cycles settled.'}
              </p>
            </section>
          )}

          {cycleList === null ? (
            <div className="bg-white p-8 rounded-xl border border-slate-200 text-center text-slate-400">Loading…</div>
          ) : filteredList.length === 0 ? (
            <div className="bg-white p-8 rounded-xl border border-slate-200 text-center text-slate-500">
              {cycleList.length === 0 ? 'No history yet.' : 'No cycles match your filter.'}
            </div>
          ) : (
            <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1 custom-scrollbar">
              {visibleList.map((cycle) => {
                const labels = groupLabels[cycle.id] ?? [];
                const title = cycleName(cycle.name, cycle.groups, cycle.closedAt, members, cards);
                // A saved name replaces the first group label, so every group moves under "more".
                const more = cycle.name ? labels.length : labels.length - 1;
                const closed = closedLabels[cycle.id] ?? closedDateOf(cycle.closedAt);
                const selected = selectedCycleId === cycle.id;
                return (
                <div
                  key={cycle.id}
                  className={`border rounded-xl transition-all duration-200 ${
                    selected
                      ? 'bg-blue-50 border-blue-500 shadow-md ring-1 ring-blue-500'
                      : 'bg-white border-slate-200 hover:border-blue-300 hover:shadow-sm'
                  }`}
                >
                <button
                  type="button"
                  onClick={() => { setSelectedCycleId(cycle.id); setIsEditing(false); }}
                  aria-pressed={selected}
                  aria-label={`${title}${more > 0 ? ` and ${more} more` : ''}, closed ${closed}, ${cycle.status === 'settled' ? 'settled' : 'not settled'}`}
                  className="w-full text-left cursor-pointer rounded-xl p-4 group"
                >
                  <div className="flex justify-between items-start gap-2 mb-2">
                    <div className="min-w-0">
                      <div className="text-body1 font-semibold text-slate-800 break-words">
                        {title}
                        {cycle.status === 'settled' && <CheckCircle size={14} className="inline ml-1 fill-green-600 text-white" aria-hidden="true" />}
                      </div>
                      <p className="text-body2 text-slate-500">Closed {closed} by {cycle.closedByName ?? 'unknown member'}</p>
                    </div>
                    <div className="bg-slate-100 rounded-full p-1 text-slate-400 group-hover:text-blue-500">
                      {selected ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                    </div>
                  </div>
                  <div className="text-body2 text-slate-400">
                    {cycle.status === 'settled' ? 'Settled (paid)' : 'Unpaid'} · {cycle.settlement.transfers.length === 0
                      ? 'nothing outstanding'
                      : `${formatCentsWithSymbol(transferTotal(cycle.settlement))} across ${cycle.settlement.transfers.length} transfer(s)`}
                  </div>
                </button>
                {cycle.status !== 'settled' && (
                  <label className="flex items-center gap-2 px-4 pb-3 pointer-coarse:min-h-11 text-body2 text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      aria-label={`Include ${title}, closed ${closed}, in outstanding total`}
                      checked={pickedIds.includes(cycle.id)}
                      onChange={() => togglePicked(cycle.id)}
                      className="h-4 w-4 accent-blue-600"
                    />
                    Include in outstanding total
                  </label>
                )}
                {more > 0 && (
                  <details className="px-4 pb-3 text-body2 text-slate-600">
                    <summary className="cursor-pointer font-semibold text-blue-700">+{more} more</summary>
                    <ul className="mt-1 space-y-1 break-words">
                      {labels.map((g, i) => <li key={i}>{groupText(g)}</li>)}
                    </ul>
                  </details>
                )}
                </div>
              );})}
              {filteredList.length > visibleCount && (
                <button
                  onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
                  className="w-full text-xs text-blue-600 font-semibold py-2 hover:underline"
                >
                  Show more ({filteredList.length - visibleCount} remaining)
                </button>
              )}
            </div>
          )}
        </div>

        {/* Right Detail View */}
        <div className="lg:col-span-3">
          {selectedCycleId && detail ? (
            <div className="space-y-6 animate-in fade-in duration-300">

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${
                    detail.cycle.status === 'settled' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-slate-50 border-slate-200 text-slate-500'
                  }`}>
                    <CheckCircle size={18} className={detail.cycle.status === 'settled' ? 'fill-green-600 text-white' : ''} />
                    <span className="font-bold text-sm">{detail.cycle.status === 'settled' ? 'Settled' : 'Not settled'}</span>
                  </div>
                  {detail.cycle.status !== 'settled' && perms.canSettleCycle && (
                    <button
                      onClick={() => void handleMarkSettled()}
                      className="px-3 py-1.5 rounded-lg text-sm font-bold bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
                    >
                      Mark as Settled
                    </button>
                  )}
                  {detail.cycle.status === 'settled' && perms.canSettleCycle && (
                    <button
                      onClick={() => void handleUndoSettlement()}
                      className="px-3 py-1.5 rounded-lg text-sm font-bold bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      Undo Settlement
                    </button>
                  )}
                  {!perms.canSettleCycle && (
                    <span className="text-xs text-slate-400 italic">Only the household owner can settle or undo settlement.</span>
                  )}
                </div>

                {canEdit && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400 font-medium">Need corrections?</span>
                    <button
                      onClick={() => setIsEditing(!isEditing)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-bold transition-colors ${
                        isEditing ? 'bg-indigo-600 text-white shadow-md' : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {isEditing ? <Lock size={14} /> : <Edit2 size={14} />}
                      {isEditing ? 'Done Editing' : 'Edit Transactions'}
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setSummaryOpen(true)}
                  // A stale detail stays rendered while the next cycle loads; never export it.
                  disabled={detail.cycle.id !== selectedCycleId || detail.transactions.length === 0}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-bold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40"
                >
                  <Download size={14} aria-hidden="true" />
                  Download summary
                </button>
                {summaryOpen && (
                  <CycleSummaryDialog
                    summary={buildCycleSummary({
                      householdName, cycle: detail.cycle, transactions: detail.transactions,
                      settlement: detail.settlement, members,
                    })}
                    closedLabel={closedLabels[detail.cycle.id] ?? closedDateOf(detail.cycle.closedAt)}
                    onClose={() => setSummaryOpen(false)}
                  />
                )}
              </div>

              <div className="text-sm space-y-2">
                <CycleName
                  name={detail.cycle.name}
                  defaultName={cycleName(null, cycleList?.find((cy) => cy.id === detail.cycle.id)?.groups ?? [], detail.cycle.closedAt, members, cards)}
                  label="this cycle"
                  className="text-heading2 text-slate-800"
                  onSave={async (name) => {
                    await api.renameCycle(detail.cycle.id, name);
                    await Promise.all([loadList(), loadDetail(detail.cycle.id)]);
                  }}
                />
                <ul aria-label="Payer and card groups" className="text-body1 font-semibold text-slate-800 space-y-1 break-words">
                  {(groupLabels[detail.cycle.id] ?? []).map((g, i) => <li key={i}>{groupText(g)}</li>)}
                </ul>
                <p className="font-semibold">Closed by {detail.cycle.closedByName ?? 'unknown member'}</p>
                <p className="text-slate-600">Closed {new Date(detail.cycle.closedAt).toLocaleString()}. Closing does not mark expenses as paid.</p>
                {changedSinceClosing && <p className="font-semibold text-amber-700">Changed since closing. Totals and transfers below use current saved values.</p>}
                {closingSnapshot ? <details className="bg-white border border-slate-200 rounded-lg p-3">
                  <summary className="cursor-pointer font-semibold">Values at closing</summary>
                  <ul className="space-y-3 mt-3">
                    {closingSnapshot.transactions.map((original) => <li key={original.expenseId} className="text-sm break-words">
                      <p className="font-semibold">{String(original.date ?? '')} · {String(original.store ?? '')} · {formatCentsWithSymbol(Number(original.amountCents ?? 0))}</p>
                      <p>{String(original.category ?? '')} · Paid by {closingSnapshot.members.find((m) => m.id === original.payerId)?.displayName ?? 'Unknown'} · {String(original.cardNameSnapshot ?? 'No card')} · {String(original.splitType ?? '')}</p>
                      <p>Shares: {(() => { try { return Object.entries(JSON.parse(String(original.splitSharesJson)) as Record<string, number>).map(([id, amount]) => `${closingSnapshot.members.find((m) => m.id === id)?.displayName ?? 'Unknown'} ${formatCentsWithSymbol(amount)}`).join(', '); } catch { return 'Allocation unavailable'; } })()}</p>
                    </li>)}
                  </ul>
                </details> : <p className="text-slate-500">Original closing values were not recorded for this legacy cycle.</p>}
              </div>

              {cycleSummary && (
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-white rounded-lg border border-slate-200 p-3">
                    <div className="text-xs text-slate-400 font-semibold uppercase">Date range</div>
                    <div className="text-sm font-bold text-slate-800">
                      {cycleSummary.dateStart
                        ? cycleSummary.dateStart === cycleSummary.dateEnd
                          ? cycleSummary.dateStart
                          : `${cycleSummary.dateStart} – ${cycleSummary.dateEnd}`
                        : 'No transactions'}
                    </div>
                  </div>
                  <div className="bg-white rounded-lg border border-slate-200 p-3">
                    <div className="text-xs text-slate-400 font-semibold uppercase">Cycle total</div>
                    <div className="text-sm font-bold text-slate-800">{formatCentsWithSymbol(cycleSummary.totalCents)}</div>
                  </div>
                  <div className="bg-white rounded-lg border border-slate-200 p-3">
                    <div className="text-xs text-slate-400 font-semibold uppercase">Transactions</div>
                    <div className="text-sm font-bold text-slate-800">{cycleSummary.count}</div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">

                <div className="xl:col-span-2 bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden order-2 xl:order-1">
                  <TransactionList
                    transactions={detail.transactions}
                    members={members}
                    cards={cards}
                    categories={categories}
                    filterDateStart={filterDateStart}
                    setFilterDateStart={setFilterDateStart}
                    filterDateEnd={filterDateEnd}
                    setFilterDateEnd={setFilterDateEnd}
                    filterCategory={filterCategory}
                    setFilterCategory={setFilterCategory}
                    filterPayerId={filterPayerId}
                    setFilterPayerId={setFilterPayerId}
                    filterCardId={filterCardId}
                    setFilterCardId={setFilterCardId}
                    onChanged={async () => { await Promise.all([loadList(), loadDetail(detail.cycle.id)]); }}
                    closingSnapshot={closingSnapshot}
                    closedCycleAt={detail.cycle.closedAt}
                    readOnly={!isEditing || !canEdit}
                    onUpdate={isEditing && canEdit ? handleTransactionUpdate : undefined}
                    onDelete={isEditing && canEdit ? handleTransactionDelete : undefined}
                    showToast={showToast}
                  />
                </div>

                <div className="xl:col-span-1 order-1 xl:order-2">
                  <div className="bg-slate-900 text-white rounded-xl shadow-lg p-6">
                    <h2 className="text-heading2 font-bold mb-1">Settlement</h2>
                    {detail.settlement.transfers.length === 0 ? (
                      <p className="text-sm text-slate-400">Nothing outstanding.</p>
                    ) : (
                      <>
                      <p className="text-sm text-slate-400 mb-5">
                        {formatCentsWithSymbol(transferTotal(detail.settlement))} total to settle
                      </p>
                      <ul className="space-y-3">
                        {detail.settlement.transfers.map((t) => (
                          <li key={`${t.from}-${t.to}`} className="text-sm">
                            <span className="font-medium text-slate-200">{nameOf(t.from)}</span> owes{' '}
                            <span className="font-medium text-slate-200">{nameOf(t.to)}</span>{' '}
                            <span className="font-semibold text-white">{formatCentsWithSymbol(t.amountCents)}</span>
                          </li>
                        ))}
                      </ul>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 p-12 border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50 min-h-[400px]">
              <Calendar size={48} className="mb-4 text-slate-300" />
              <p className="text-lg font-bold text-slate-500">Select a cycle to view details</p>
              <p className="text-sm">Settlement summaries and transaction ledgers will appear here.</p>
            </div>
          )}
        </div>

      </div>
    </div>
  );
};

export default HistoryPage;
