
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Settings, History, LogOut, RotateCcw, TrendingUp } from 'lucide-react';

import { signOut, useSession } from './lib/auth-client';
import { api, ApiError, currentGroupId, setCurrentGroup } from './lib/api';
import { pickGroup } from './lib/groups';
import { computeSettlement } from './lib/settlement';
import { formatCentsWithSymbol, cycleGroupsOf, cycleName } from './lib/money';
import { generateId, CATEGORIES, categoryOptions } from './constants';
import type { Bootstrap, GroupSummary, TxInput, TxPatch, QueueItem, QueueItemInput, Settlement, Transaction } from './types';
import { LoginPage } from './components/auth/LoginPage';
import { useToast, Toast } from './components/Toast';
import InputSection from './components/InputSection';
import TransactionList from './components/TransactionList';
import SettlementSummary from './components/SettlementSummary';
import ReminderCalendar from './components/ReminderCalendar';
import SettingsPage from './components/SettingsPage';
import HistoryPage from './components/HistoryModal';
import AnalyticsPage from './components/AnalyticsPage';
import CycleName from './components/CycleName';
import GroupSwitcher from './components/GroupSwitcher';
import NewGroupCard from './components/NewGroupCard';

type View = 'dashboard' | 'history' | 'settings' | 'analytics';

const App: React.FC = () => {
  const { data: session, isPending } = useSession();
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ledgerTab, setLedgerTab] = useState<'pending' | 'approved'>('pending');
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const { toast, showToast, clearToast } = useToast();
  const refreshQueue = useRef<Promise<void>>(Promise.resolve());
  const [demo, setDemo] = useState<typeof import('./demo') | null>(null);
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
  const enterDemo = async () => {
    const m = await import('./demo');
    m.install();
    setDemo(m);
    setHowItWorksOpen(true);
  };

  const [groupList, setGroupList] = useState<{ groups: GroupSummary[]; canCreate: boolean } | null>(null);
  const [choosingGroup, setChoosingGroup] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const loadGroups = useCallback(async () => {
    try {
      const list = await api.groups();
      setGroupList(list);
      return list;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { setData(null); return null; }
      setLoadError(err instanceof Error ? err.message : 'Could not load your groups');
      return null;
    }
  }, []);
  // Reload on open so pending counts are fresh; a failed reload keeps the cached list.
  const openSwitcher = useCallback((open: boolean) => {
    setSwitcherOpen(open);
    if (open) api.groups().then(setGroupList, () => {});
  }, []);

  const refresh = useCallback(() => {
    // Each mutation waits for its own snapshot, after earlier refreshes finish.
    const queued = refreshQueue.current.then(async () => {
      try {
        setData(await api.bootstrap());
        setLoadError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) { setData(null); return; }
        if (err instanceof ApiError && err.reason === 'group_required') {
          setCurrentGroup(null);
          setData(null);
          setChoosingGroup(true);
          openSwitcher(true);
          return;
        }
        setLoadError(err instanceof Error ? err.message : 'Could not load your data');
      }
    });
    refreshQueue.current = queued;
    return queued;
  }, [openSwitcher]);

  // Pick a group before the first bootstrap: with several and no valid stored
  // choice, ask instead of letting the server answer group_required.
  useEffect(() => {
    if (!session && !demo) return;
    void (async () => {
      const list = await loadGroups();
      if (!list) return;
      const pick = pickGroup(currentGroupId(), list.groups);
      setCurrentGroup(pick);
      // No group and nothing to create: bootstrap reports why.
      if (pick || (list.groups.length === 0 && !list.canCreate)) { setChoosingGroup(false); void refresh(); }
      else { setChoosingGroup(true); setSwitcherOpen(true); }
    })();
  }, [session, demo, refresh, loadGroups]);

  // Two people may edit at once, so refetch when the tab regains focus rather
  // than acting on a stale total. This is why there are no websockets.
  useEffect(() => {
    const onFocus = () => { if ((session || demo) && currentGroupId()) void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [session, demo, refresh]);

  // Dashboard Filters
  const [filterDateStart, setFilterDateStart] = useState('');
  const [filterDateEnd, setFilterDateEnd] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterPayerId, setFilterPayerId] = useState('');
  const [filterCardId, setFilterCardId] = useState('');

  const [closeConfirmation, setCloseConfirmation] = useState<{ ids: string[]; cycleId: string } | null>(null);
  const [closeAcknowledgment, setCloseAcknowledgment] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [ledgerDraftState, setLedgerDraftState] = useState<{ dirtyIds: string[]; busyIds: string[] }>({ dirtyIds: [], busyIds: [] });
  const closeRows = useMemo(() => closeConfirmation
    ? closeConfirmation.ids.flatMap((id) => data?.transactions.find((tx) => tx.id === id) ?? [])
    : [], [closeConfirmation, data]);
  const closeVersion = JSON.stringify({ rows: closeRows.map((tx) => [tx.id, tx.revision]), members: data?.members });
  const closeHasDrafts = closeRows.some((tx) => ledgerDraftState.dirtyIds.includes(tx.id));
  const closeHasSaves = closeRows.some((tx) => ledgerDraftState.busyIds.includes(tx.id));
  const closeSettlement = useMemo(() => {
    try {
      return computeSettlement(closeRows.map((tx) => ({ payerId: tx.payerId, amountCents: tx.amountCents, shares: JSON.parse(tx.splitSharesJson) })), data?.members.map((m) => m.id) ?? []);
    } catch { return null; }
  }, [closeRows, data?.members]);
  const closeBlocked = closeHasDrafts || closeHasSaves || !closeRows.length || !closeSettlement;
  useEffect(() => { setCloseAcknowledgment(null); }, [closeVersion, closeBlocked]);

  useEffect(() => {
    if (!closeConfirmation) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape' && !closing) setCloseConfirmation(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeConfirmation, closing]);

  const filteredTransactions = useMemo(() => {
    if (!data) return [];
    return data.transactions.filter((tx) => {
      if (filterDateStart && tx.date < filterDateStart) return false;
      if (filterDateEnd && tx.date > filterDateEnd) return false;
      if (filterCategory && tx.category !== filterCategory) return false;
      if (filterPayerId && tx.payerId !== filterPayerId) return false;
      if (filterCardId && tx.cardId !== filterCardId) return false;
      return true;
    });
  }, [data, filterDateStart, filterDateEnd, filterCategory, filterPayerId, filterCardId]);

  const { minDate, maxDate } = useMemo(() => {
    if (!data || data.transactions.length === 0) return { minDate: undefined, maxDate: undefined };
    const dates = data.transactions.map((t) => t.date).sort();
    return { minDate: dates[0], maxDate: dates[dates.length - 1] };
  }, [data]);

  // Infinity: an open cycle never takes a card's retrospective history label.
  const currentCycleDefault = useMemo(
    () => (data ? cycleName(null, cycleGroupsOf(data.transactions), Infinity, data.members, data.cards) : ''),
    [data],
  );

  // The dashboard balance is over every active transaction, not the current
  // filter view: filters only decide what a "Close Cycle" click would claim.
  const settlement: Settlement = useMemo(() => {
    if (!data) return { balances: {}, transfers: [] };
    const roster = data.members.filter((m) => !m.archivedAt).map((m) => m.id);
    try {
      return computeSettlement(
        data.transactions.map((t) => ({
          payerId: t.payerId,
          amountCents: t.amountCents,
          shares: JSON.parse(t.splitSharesJson) as Record<string, number>,
        })),
        roster,
      );
    } catch {
      return { balances: {}, transfers: [] };
    }
  }, [data]);

  const categories = useMemo(
    () => (data ? categoryOptions(data.household.customCategories) : CATEGORIES),
    [data],
  );

  // --- Transaction mutations ---
  const handleBreakdown = async (id: string, transactionId: string, amountCents: number, revision: number) => {
    const saved = await api.splitTransaction(id, transactionId, amountCents, revision);
    await refresh();
    return saved;
  };
  const handleQueueBreakdown = async (id: string, queueItemId: string, amountCents: number, revision: number) => {
    const saved = await api.splitQueueItem(id, queueItemId, amountCents, revision);
    await refresh();
    return saved;
  };

  const handleUpdateTransaction = async (id: string, patch: TxPatch, revision: number) => {
    const saved = await api.updateTransaction(id, patch, revision);
    await refresh();
    return saved;
  };

  const handleDeleteTransaction = async (id: string, revision: number) => {
    await api.deleteTransaction(id, revision); // real delete, fixes B1
    await refresh();
  };

  const handleReturnToPending = async (item: Transaction, note?: string) => {
    const saved = await api.returnToPending(item.id, item.revision, note);
    await refresh();
    return saved;
  };

  // --- Queue mutations ---
  const handleAddToQueue = async (items: QueueItemInput[]) => {
    try {
      // One atomic call: the server validates the whole batch, detects
      // duplicates authoritatively, and inserts everything in a single D1
      // batch, so a bad row or a retried upload can never leave partial rows.
      // Duplicate detection is deliberately NOT done here: a second, looser
      // client rule would flag rows the server's rule doesn't recognise, and
      // the review queue — which explains a flag by showing the matching
      // transaction — would then have nothing to show beside the warning.
      // The full result (not just void) is returned so the caller can render
      // an import result screen instead of assuming success.
      const result = await api.createQueueItems(items);
      if (result.summary.duplicate > 0) {
        showToast(`Added ${result.summary.inserted} item(s) to the queue, ${result.summary.duplicate} flagged as possible duplicates.`);
      }
      await refresh();
      setLedgerTab('pending');
      return result;
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : 'Could not add to the review queue.');
      return null;
    }
  };

  const handleUpdateQueueItem = async (id: string, patch: Partial<QueueItemInput>, revision: number) => {
    const saved = await api.updateQueueItem(id, patch, revision);
    await refresh();
    return saved;
  };

  const handleDeleteQueueItem = async (id: string, revision: number) => {
    await api.deleteQueueItem(id, revision);
    await refresh();
  };

  const handleDeleteQueueItems = async (ids: string[], revisions: Record<string, number>) => {
    await api.deleteQueueItems(ids, revisions);
    await refresh();
  };

  const handleConfirmQueueItem = async (item: QueueItem) => {
    if (!item.date || !item.store?.trim() || item.amountCents == null || !item.category || !item.payerId || !['equal', 'single', 'custom'].includes(item.splitType ?? '')) {
      throw new Error('Fill in date, store, amount, category, payer and split before approving.');
    }
    const input: TxInput = {
      id: generateId(), date: item.date, store: item.store, amountCents: item.amountCents,
      category: item.category, payerId: item.payerId, cardId: item.cardId,
      splitType: item.splitType as TxInput['splitType'],
      splitRule: item.splitRuleJson ? JSON.parse(item.splitRuleJson) : null,
    };
    const saved = await api.confirmQueueItem(item.id, input.id, input, item.revision);
    await refresh();
    return saved;
  };

  // --- Cycle closure ---
  const handleInitiateCloseCycle = () => {
    const ids = filteredTransactions.map((t) => t.id);
    if (ids.length === 0) {
      showToast('No visible transactions to close.');
      return;
    }
    setCloseAcknowledgment(null);
    setCloseConfirmation({ ids, cycleId: generateId() });
  };

  const handleCloseCycle = async () => {
    if (!closeConfirmation || closing || closeBlocked || closeAcknowledgment !== closeVersion) return;
    setClosing(true);
    try {
      await api.closeCycle({ cycleId: closeConfirmation.cycleId, transactionIds: closeRows.map((tx) => tx.id), confirmed: true, revisions: Object.fromEntries(closeRows.map((tx) => [tx.id, tx.revision])) });
      setCloseConfirmation(null);
      setCloseAcknowledgment(null);
      await refresh();
      showToast('Cycle closed. Pending expenses remain available. This does not mark expenses as paid.', 'success');
    } catch (err) {
      setCloseAcknowledgment(null);
      showToast(err instanceof Error ? err.message : 'Could not close this cycle.', 'error');
      if (err instanceof ApiError && err.status === 409) await refresh();
    } finally { setClosing(false); }
  };

  // --- Groups ---
  const selectGroup = (id: string) => {
    setCurrentGroup(id);
    setChoosingGroup(false);
    // Filters name the old group's people and cards; a stale one would hide every row.
    setFilterDateStart(''); setFilterDateEnd(''); setFilterCategory(''); setFilterPayerId(''); setFilterCardId('');
    setCloseConfirmation(null);
    void refresh();
  };
  const switcher = groupList && (
    <GroupSwitcher
      groups={groupList.groups}
      currentId={currentGroupId()}
      canCreate={groupList.canCreate}
      onSelect={selectGroup}
      onCreate={() => setNewGroupOpen(true)}
      open={switcherOpen}
      onOpenChange={openSwitcher}
    />
  );
  const newGroupCard = newGroupOpen && (
    <NewGroupCard
      defaultCurrency={data?.household.currencyCode ?? 'CAD'}
      onClose={() => setNewGroupOpen(false)}
      onCreated={(group) => {
        setGroupList((list) => list && { ...list, groups: [...list.groups, group] });
        setNewGroupOpen(false);
        selectGroup(group.id);
      }}
      restoreFocus={() => document.getElementById('group-switcher')}
    />
  );

  // In the demo a session refetch (on focus) must not unmount the app.
  if (!demo && isPending) return <div className="min-h-screen grid place-items-center text-slate-500">Loading…</div>;
  if (!demo && !session) return <LoginPage onTryDemo={enterDemo} />;
  if (loadError) return <div className="min-h-screen grid place-items-center text-red-600">{loadError}</div>;
  if (choosingGroup && !data) return (
    <div className="min-h-screen bg-slate-50 grid place-items-center p-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-heading1 text-slate-800">Choose a group</h1>
        {switcher}
      </div>
      {newGroupCard}
    </div>
  );
  if (!data) return <div className="min-h-screen grid place-items-center text-slate-500">Loading…</div>;

  const header = currentView !== 'settings' && (
    <header className={`bg-white border-b border-slate-200${demo ? '' : ' sticky top-0 z-30'}`}>
      <div className="w-full max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between">
        <button
          type="button"
          className="flex shrink-0 items-center gap-2"
          onClick={() => setCurrentView('dashboard')}
        >
          <div className="bg-blue-600 text-white p-1.5 rounded-lg">
            <RotateCcw size={20} aria-hidden="true" />
          </div>
          {/* Below sm the group name needs the room; the heading stays for screen readers. */}
          <h1 className="sr-only sm:not-sr-only font-bold text-heading1 text-slate-800 tracking-tight">Divvy</h1>
        </button>
        <div className="ml-2 mr-auto min-w-0 pr-2">{switcher}</div>

        <div className="flex shrink-0 items-center gap-3">
          <button
            onClick={() => setCurrentView('analytics')}
            aria-label="Analytics"
            aria-pressed={currentView === 'analytics'}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors font-medium text-sm ${currentView === 'analytics' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            <TrendingUp size={18} aria-hidden="true" />
            <span className="hidden sm:inline" aria-hidden="true">Analytics</span>
          </button>
          <button
            onClick={() => setCurrentView('history')}
            aria-label="History"
            aria-pressed={currentView === 'history'}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors font-medium text-sm ${currentView === 'history' ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            <History size={18} aria-hidden="true" />
            <span className="hidden sm:inline" aria-hidden="true">History</span>
          </button>
          <button
            onClick={() => setCurrentView('settings')}
            aria-label="Settings"
            className="flex items-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors"
          >
            <Settings size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => (demo ? demo.exitDemo() : void signOut())}
            aria-label={demo ? 'Exit demo' : 'Sign out'}
            title={demo ? 'Exit demo' : 'Sign out'}
            className="flex items-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors"
          >
            <LogOut size={18} aria-hidden="true" />
            {demo && <span aria-hidden="true">Exit demo</span>}
          </button>
        </div>
      </div>
    </header>
  );

  return (
    <div className="min-h-screen pb-20 bg-slate-50">

      {demo ? (
        <div className="sticky top-0 z-30">
          <demo.DemoBanner onHowItWorks={() => setHowItWorksOpen(true)} onExit={demo.exitDemo} />
          {header}
        </div>
      ) : header}
      {demo && howItWorksOpen && <demo.HowItWorksCard onClose={() => setHowItWorksOpen(false)} />}

      {newGroupCard}

      {/* Keyed by group: every view remounts and refetches when the group changes. */}
      <main key={data.household.id} className="w-full max-w-[1920px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Toast toast={toast} onClose={clearToast} />

        {currentView === 'dashboard' && (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] lg:grid-rows-[auto_1fr] gap-8">
            {/* Desktop: a sticky, width-capped right column (no scroller) with the
                compact summary directly below the calendar, beside
                (never over) the ledger and its ledger-width bulk toolbar. Below
                lg it holds only the calendar, so the page reads calendar,
                import, ledger, then the summary rendered after the ledger. */}
            <aside aria-label="This month" className={`flex flex-col gap-4 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:sticky ${demo ? 'lg:top-[8.5rem]' : 'lg:top-20'} lg:self-start ${demo ? 'lg:max-h-[calc(100dvh-10.5rem)]' : 'lg:max-h-[calc(100dvh-7rem)]'}`}>
              <div className="flex min-h-0 flex-col">
                <ReminderCalendar cards={data.cards} members={data.members} timezone={data.household.timezone} rentReminder={data.household.rentReminder} />
              </div>
              <div className="hidden shrink-0 lg:block">
                <SettlementSummary
                  settlement={settlement}
                  members={data.members}
                  onCloseCycle={handleInitiateCloseCycle}
                  closableCount={filteredTransactions.length}
                  closableTotalCents={filteredTransactions.reduce((sum, t) => sum + t.amountCents, 0)}
                />
              </div>
            </aside>

            <section className="min-w-0">
              <h2 className="text-heading2 font-bold text-slate-800 mb-4">Add Expenses</h2>
              <InputSection
                onAddToQueue={handleAddToQueue}
                members={data.members.filter((m) => !m.archivedAt)}
                cards={data.cards}
                customCategories={data.household.customCategories}
                categoryPreferences={data.categoryPreferences}
                starredTransactions={data.transactions.filter((t) => t.isStarred)}
                showToast={showToast}
                groupName={data.household.name}
                onChangeGroup={() => openSwitcher(true)}
              />
            </section>

            <section className="min-w-0">
              <h2 className="text-heading2 font-bold text-slate-800">Ledger</h2>
              <div className="mb-3 flex flex-wrap items-center gap-x-2">
                <span className="text-body2 text-slate-500">Current cycle</span>
                <CycleName
                  name={data.household.currentCycleName}
                  defaultName={currentCycleDefault}
                  label="current cycle"
                  onSave={async (name) => { await api.renameCycle('current', name); await refresh(); }}
                />
              </div>
              <div role="tablist" aria-label="Ledger views" className="flex gap-2 mb-4 border-b border-slate-200">
                <button role="tab" aria-selected={ledgerTab === 'pending'} className={`px-4 py-3 border-b-2 text-sm font-semibold ${ledgerTab === 'pending' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500'}`} onClick={() => setLedgerTab('pending')}>Pending ({data.queue.length})</button>
                <button role="tab" aria-selected={ledgerTab === 'approved'} className={`px-4 py-3 border-b-2 text-sm font-semibold ${ledgerTab === 'approved' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500'}`} onClick={() => setLedgerTab('approved')}>Approved ({data.transactions.length})</button>
              </div>
              <TransactionList
                transactions={data.transactions}
                pendingItems={data.queue}
                mode={ledgerTab}
                onQueueUpdate={handleUpdateQueueItem}
                onQueueBreakdown={handleQueueBreakdown}
                onQueueDelete={handleDeleteQueueItem}
                onQueueDeleteMany={handleDeleteQueueItems}
                onApprove={handleConfirmQueueItem}
                onReturnToPending={handleReturnToPending}
                onChanged={refresh}
                onDraftStateChange={setLedgerDraftState}
                members={data.members}
                cards={data.cards}
                categories={categories}
                categoryPreferences={data.categoryPreferences}
                onUpdate={handleUpdateTransaction}
                onDelete={handleDeleteTransaction}
                onBreakdown={handleBreakdown}
                showToast={showToast}

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
                minDate={minDate}
                maxDate={maxDate}
              />
            </section>
            {/* Below lg the summary comes last, after review; display:none keeps one copy in the a11y tree. */}
            <div className="lg:hidden">
              <SettlementSummary
                settlement={settlement}
                members={data.members}
                onCloseCycle={handleInitiateCloseCycle}
                closableCount={filteredTransactions.length}
                closableTotalCents={filteredTransactions.reduce((sum, t) => sum + t.amountCents, 0)}
              />
            </div>
          </div>
        )}

        {currentView === 'history' && (
          <HistoryPage
            members={data.members}
            cards={data.cards}
            categories={categories}
            role={data.me.role}
            onBack={() => setCurrentView('dashboard')}
            onChanged={refresh}
            showToast={showToast}
            householdName={data.household.name}
          />
        )}

        {currentView === 'analytics' && (
          <AnalyticsPage
            members={data.members}
            cards={data.cards}
            categories={categories}
            onBack={() => setCurrentView('dashboard')}
            showToast={showToast}
          />
        )}

        {currentView === 'settings' && (
          <SettingsPage
            members={data.members}
            cards={data.cards}
            customCategories={data.household.customCategories}
            rentReminder={data.household.rentReminder}
            role={data.me.role}
            onBack={() => setCurrentView('dashboard')}
            onChanged={refresh}
            showToast={showToast}
          />
        )}
      </main>

      {/* Confirmation Modal */}
      {closeConfirmation && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="close-cycle-heading"
          onClick={() => { if (!closing) setCloseConfirmation(null); }}
        >
          <div
            className="bg-white rounded-t-2xl sm:rounded-xl shadow-2xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto animate-in fade-in zoom-in duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="close-cycle-heading" className="text-heading2 font-bold text-slate-900 mb-2">Close cycle</h3>
            <p className="text-slate-600 text-sm mb-4">
              Closing {closeRows.length} Approved expenses, totaling {formatCentsWithSymbol(closeRows.reduce((sum, tx) => sum + tx.amountCents, 0))}.
              {' '}{data.transactions.length - closeRows.length} Approved expenses outside this selection and {data.queue.length} Pending expenses remain for later.
            </p>
            {closeRows.length !== closeConfirmation.ids.length && <p role="alert" className="text-amber-700 text-sm mb-3">Some selected expenses are no longer active Approved expenses. Review the remaining selection.</p>}
            <ul className="space-y-3 border-y border-slate-200 py-3 mb-4">
              {closeRows.map((tx) => <li key={tx.id} className="text-sm">
                <p className="font-semibold break-words">{tx.date} · {tx.store} · {formatCentsWithSymbol(tx.amountCents)}</p>
                <p className="text-slate-600">{tx.category} · Paid by {data.members.find((m) => m.id === tx.payerId)?.displayName ?? 'Unknown'} · {tx.cardNameSnapshot ?? data.cards.find((c) => c.id === tx.cardId)?.name ?? 'No card'} · {tx.splitType}</p>
                <p className="text-slate-600 break-words">Shares: {(() => { try { return Object.entries(JSON.parse(tx.splitSharesJson) as Record<string, number>).map(([id, amount]) => `${data.members.find((m) => m.id === id)?.displayName ?? 'Unknown'} ${formatCentsWithSymbol(amount)}`).join(', '); } catch { return 'Saved allocation unavailable'; } })()}</p>
              </li>)}
            </ul>
            {closeSettlement && <div className="text-sm space-y-2 mb-4">
              <h4 className="font-bold">Personal net totals</h4>
              {Object.entries(closeSettlement.balances).map(([id, amount]) => <p key={id}>{data.members.find((m) => m.id === id)?.displayName ?? 'Unknown'}: {formatCentsWithSymbol(amount)}</p>)}
              <h4 className="font-bold pt-2">Resulting transfers</h4>
              {closeSettlement.transfers.length === 0 ? <p>No transfers needed.</p> : closeSettlement.transfers.map((transfer) => <p key={`${transfer.from}-${transfer.to}`}>{data.members.find((m) => m.id === transfer.from)?.displayName ?? 'Unknown'} owes {data.members.find((m) => m.id === transfer.to)?.displayName ?? 'Unknown'} {formatCentsWithSymbol(transfer.amountCents)}</p>)}
            </div>}
            {(closeHasDrafts || closeHasSaves) && <p role="alert" className="text-amber-700 text-sm mb-4">{closeHasSaves ? 'Wait for included expenses to finish saving. Then confirm the saved values again.' : 'Save or cancel included drafts before closing. Cancel this dialog to return to the editor.'}</p>}
            {!closeSettlement && <p role="alert" className="text-red-700 text-sm mb-4">Correct the saved allocation before closing.</p>}
            <label className="flex items-start gap-3 text-sm mb-6">
              <input type="checkbox" className="mt-1" aria-label="I confirm closing the selected expenses. This does not mark them as paid." disabled={closeBlocked || closing} checked={closeAcknowledgment === closeVersion && !closeBlocked} onChange={(e) => setCloseAcknowledgment(e.target.checked ? closeVersion : null)} />
              <span>I confirm closing the selected expenses. This does not mark them as paid.</span>
            </label>
            <div className="flex justify-end gap-3">
              <button
                disabled={closing}
                onClick={() => { if (!closing) setCloseConfirmation(null); }}
                className="px-4 py-2 text-slate-600 font-bold hover:bg-slate-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                disabled={closing || closeBlocked || closeAcknowledgment !== closeVersion}
                onClick={() => void handleCloseCycle()}
                className="px-4 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 shadow-md transition-colors"
              >
                {closing ? 'Closing…' : 'Close cycle'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default App;
