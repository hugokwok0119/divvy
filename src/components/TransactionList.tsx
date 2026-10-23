import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Transaction, QueueItem, QueueItemInput, Member, Card, TxPatch, ClosingSnapshot } from '../types';
import { generateId } from '../constants';
import { distributeByWeight, splitRosterOf } from '../lib/settlement';
import { closedCycleCard, formatCents, formatCentsWithSymbol, parseAmountToCents } from '../lib/money';
import { dateOutOfRangeMessage, isDateInRange, presentFilterValues } from '../lib/filters';
import { api, ApiError } from '../lib/api';
import { amountWeightsError, customPercentagesError, formatPercentage, parsePercentageDraft, percentagesFromAmounts } from '../lib/percentages';
import { buildCategorySuggestions } from '../lib/category';
import { isDemoMode } from '../lib/demo-mode';
import { MAX_BULK_BATCH } from '../../worker/lib/validate';
import { memberColorAt } from '../lib/memberColors';
import CategorySuggestions from './CategorySuggestions';
import ExpenseHistory from './ExpenseHistory';
import { Check, Eye, EyeOff, Filter, History, Pencil, Scissors, Star, Trash2, Undo2, Users, ArrowUpDown, FileText, Send, X } from 'lucide-react';
import './TransactionList.css';
import {
  approvedPatch,
  patchFrom,
  changePayer,
  draftFrom,
  expenseDifferences,
  findMatchingTransaction,
  validateDraft,
  rebaseDraft,
  color,
} from './ledger';
import type { ExpenseDraft, LedgerRow } from './ledger';

export interface TransactionListProps {
  transactions: Transaction[];
  pendingItems?: QueueItem[];
  mode?: 'pending' | 'approved';
  members: Member[];
  cards: Card[];
  categories: string[];
  categoryPreferences?: Record<string, string>;
  onUpdate?: (id: string, patch: TxPatch, revision: number) => Promise<Transaction>;
  onDelete?: (id: string, revision: number) => Promise<void>;
  onBreakdown?: (
    id: string,
    transactionId: string,
    amountCents: number,
    revision: number,
  ) => Promise<{ original: Transaction; separated: Transaction }>;
  onQueueUpdate?: (
    id: string,
    patch: Partial<QueueItemInput>,
    revision: number,
  ) => Promise<QueueItem>;
  onQueueBreakdown?: (id: string, queueItemId: string, amountCents: number, revision: number) => Promise<{ original: QueueItem; separated: QueueItem }>;
  onQueueDelete?: (id: string, revision: number) => Promise<void>;
  onQueueDeleteMany?: (ids: string[], revisions: Record<string, number>) => Promise<void>;
  onApprove?: (item: QueueItem) => Promise<Transaction>;
  onReturnToPending?: (item: Transaction, note?: string) => Promise<QueueItem>;
  onChanged?: () => Promise<void>;
  onDraftStateChange?: (state: { dirtyIds: string[]; busyIds: string[] }) => void;
  closingSnapshot?: ClosingSnapshot | null;
  /** Set for a closed cycle's rows: card labels follow closedCycleCard instead of the live name. */
  closedCycleAt?: number;
  showToast?: (message: string, type?: 'error' | 'success') => void;
  filterDateStart: string;
  setFilterDateStart: (date: string) => void;
  filterDateEnd: string;
  setFilterDateEnd: (date: string) => void;
  filterCategory: string;
  setFilterCategory: (cat: string) => void;
  filterPayerId: string;
  setFilterPayerId: (id: string) => void;
  filterCardId: string;
  setFilterCardId: (id: string) => void;
  readOnly?: boolean;
  /** The group client saves go through; a section for another group passes apiFor(itsId). */
  client?: typeof api;
  /** Called when this list's selection goes from empty to non-empty. */
  onSelectionStart?: () => void;
  /** True while another list on screen owns the selection; turning true clears this one's. */
  selectionElsewhere?: boolean;
  /** Set only when the person belongs to two or more groups: Pending's bulk toolbar offers Send to group. */
  onSendToGroup?: (rows: QueueItem[]) => void;
}
type SortKey = 'date' | 'store' | 'category' | 'amount';
export function sortAriaValue(
  activeKey: SortKey,
  activeDirection: 'asc' | 'desc',
  columnKey: SortKey,
): 'ascending' | 'descending' | 'none' {
  return activeKey !== columnKey ? 'none' : activeDirection === 'asc' ? 'ascending' : 'descending';
}
interface DraftRecord {
  base: LedgerRow;
  values: ExpenseDraft;
}
const control =
  'w-full min-w-0 rounded border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-blue-500';
const button =
  'rounded border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-blue-500';
const emptyPendingItems: QueueItem[] = [];

export default function TransactionList(props: TransactionListProps) {
  const {
    transactions,
    pendingItems = emptyPendingItems,
    mode = 'approved',
    members,
    cards,
    categories,
    categoryPreferences,
    readOnly = false,
    showToast,
    client = api,
  } = props;
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [colorMode, setColorMode] = useState<'category' | 'payer' | 'card' | 'none'>('category');
  const [showFilters, setShowFilters] = useState(true);
  const [splitEditor, setSplitEditor] = useState<string | null>(null);
  const allocationDialog = useRef<HTMLDialogElement>(null);
  const allocationTrigger = useRef<HTMLButtonElement | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const ledgerElement = useRef<HTMLElement>(null);
  const bulkToolbarElement = useRef<HTMLDivElement>(null);
  const [bulkToolbarBounds, setBulkToolbarBounds] = useState({ left: 0, width: 0, height: 0 });
  const hasBulkSelection = !readOnly && selected.size > 0;
  // One selection across lists, so only one fixed bulk toolbar exists at a time.
  useEffect(() => { if (hasBulkSelection) props.onSelectionStart?.(); }, [hasBulkSelection]);
  useEffect(() => { if (props.selectionElsewhere) setSelected(new Set()); }, [props.selectionElsewhere]);
  useLayoutEffect(() => {
    if (!hasBulkSelection) return;
    const ledger = ledgerElement.current, toolbar = bulkToolbarElement.current;
    if (!ledger || !toolbar) return;
    const update = () => {
      const { left, width } = ledger.getBoundingClientRect(), height = toolbar.getBoundingClientRect().height;
      setBulkToolbarBounds(current => current.left === left && current.width === width && current.height === height ? current : { left, width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(ledger); observer.observe(toolbar);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [hasBulkSelection]);
  const [drafts, setDrafts] = useState<Record<string, DraftRecord>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [amountErrors, setAmountErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [allBusy, setAllBusy] = useState(false);
  const writes = useRef(new Map<string, Promise<LedgerRow>>());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const locks = useRef({ ids: new Set<string>(), all: false });
  const draftRef = useRef(drafts);
  draftRef.current = drafts;
  const closeAllocation = () => {
    const record = splitEditor ? draftRef.current[splitEditor] : undefined
    if (record?.values.customAllocation) {
      draftRef.current = { ...draftRef.current, [splitEditor!]: { ...record, values: { ...record.values, customAllocation: undefined } } };
      setDrafts(draftRef.current);
    }
    setSplitEditor(null);
  };
  useEffect(() => {
    const dialog = allocationDialog.current, trigger = allocationTrigger.current;
    if (!splitEditor || !dialog) return;
    dialog.showModal();
    return () => { dialog.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [splitEditor]);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const bulkDeleteDialog = useRef<HTMLDialogElement>(null);
  const bulkDeleteTrigger = useRef<HTMLButtonElement | null>(null);
  const closeDelete = () => { if (!allBusy && (!deleteId || !busy.has(deleteId))) setDeleteId(null); };
  const closeBulkDelete = () => { if (!allBusy && busy.size === 0) setConfirmBulkDelete(false); };
  useEffect(() => {
    const dialog = deleteDialog.current, trigger = deleteTrigger.current;
    if (!deleteId || !dialog) return;
    dialog.showModal();
    return () => { dialog.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [deleteId]);
  useEffect(() => {
    const dialog = bulkDeleteDialog.current, trigger = bulkDeleteTrigger.current;
    if (!confirmBulkDelete || !dialog) return;
    dialog.showModal();
    return () => { dialog.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [confirmBulkDelete]);
  useEffect(() => {
    if (confirmBulkDelete && selected.size === 0 && !allBusy) setConfirmBulkDelete(false);
  }, [confirmBulkDelete, selected.size, allBusy]);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [move, setMove] = useState<{
    row: LedgerRow & { kind: 'approved' };
    note: string;
    noteEdited: boolean;
    targets?: Array<LedgerRow & { kind: 'approved' }>;
  } | null>(null);
  const moveDialog = useRef<HTMLDialogElement>(null);
  const moveTrigger = useRef<HTMLButtonElement | null>(null);
  const closeMove = () => {
    if (allBusy || (move && busy.has(move.row.item.expenseId))) return;
    setMove(null);
  };
  useEffect(() => {
    const dialog = moveDialog.current, trigger = moveTrigger.current;
    if (!move || !dialog) return;
    dialog.showModal();
    return () => { dialog.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [move?.row.item.expenseId]);
  useEffect(() => { if (move?.targets && selected.size === 0 && !allBusy) setMove(null); }, [move?.targets, selected.size, allBusy]);
  const [breakdown, setBreakdown] = useState<LedgerRow | null>(null);
  const [breakdownAmount, setBreakdownAmount] = useState('');
  const [breakdownError, setBreakdownError] = useState('');
  const [breakdownId, setBreakdownId] = useState('');
  const breakdownDialog = useRef<HTMLDialogElement>(null);
  const breakdownTrigger = useRef<HTMLButtonElement | null>(null);
  const closeBreakdown = () => {
    if (breakdown && busy.has(breakdown.item.expenseId)) return;
    setBreakdown(null); setBreakdownAmount(''); setBreakdownError('');
  };
  useEffect(() => {
    const dialog = breakdownDialog.current, trigger = breakdownTrigger.current;
    if (!breakdown || !dialog) return;
    dialog.showModal();
    return () => { dialog.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [breakdown]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [bulkSplit, setBulkSplit] = useState<ExpenseDraft | null>(null);
  const bulkAllocationDialog = useRef<HTMLDialogElement>(null);
  const bulkAllocationTrigger = useRef<HTMLSelectElement | null>(null);
  const closeBulkAllocation = () => { if (!allBusy && busy.size === 0) setBulkSplit(null); };
  useEffect(() => {
    const dialog = bulkAllocationDialog.current, trigger = bulkAllocationTrigger.current;
    if (!bulkSplit || !dialog) return;
    dialog.showModal();
    return () => { dialog.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [!!bulkSplit]);
  useEffect(() => { if (!hasBulkSelection) setBulkSplit(null); }, [hasBulkSelection]);
  const activeMembers = members.filter((member) => !member.archivedAt);
  const splitRoster = splitRosterOf(members);
  const rows: LedgerRow[] = useMemo(
    () =>
      mode === 'pending'
        ? pendingItems.map((item) => ({ kind: 'pending', item }))
        : transactions.map((item) => ({ kind: 'approved', item })),
    [mode, pendingItems, transactions],
  );
  const present = useMemo(() => presentFilterValues(rows.map((row) => row.item)), [rows]);
  const dateFilter = (set: (date: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isDateInRange(e.target.value, present.minDate, present.maxDate)) set(e.target.value);
    else props.showToast?.(dateOutOfRangeMessage(present.minDate, present.maxDate));
  };
  const rowsRef = useRef(rows);
  rowsRef.current = [...pendingItems.map(item => ({ kind: 'pending' as const, item })),
    ...transactions.map(item => ({ kind: 'approved' as const, item }))];
  useEffect(() => {
    setSelected(new Set());
    setBulkSplit(null);
    setConfirmBulkDelete(false);
    setDeleteId(null);
    setBreakdown(null);
    closeAllocation();
    setMove(null);
    setHistoryId(null);
    setFeedback('');
  }, [
    mode,
    readOnly,
    props.filterDateStart,
    props.filterDateEnd,
    props.filterCategory,
    props.filterPayerId,
    props.filterCardId,
  ]);
  useEffect(() => {
    const ids = new Set(rows.map((row) => row.item.id));
    setSelected((current) => new Set([...current].filter((id) => ids.has(id))));
  }, [rows]);
  const processed = useMemo(
    () =>
      rows
        .filter(
          ({ item }) =>
            (!props.filterDateStart || (!!item.date && item.date >= props.filterDateStart)) &&
            (!props.filterDateEnd || (!!item.date && item.date <= props.filterDateEnd)) &&
            (!props.filterCategory || item.category === props.filterCategory) &&
            (!props.filterPayerId || item.payerId === props.filterPayerId) &&
            (!props.filterCardId || item.cardId === props.filterCardId),
        )
        .sort((a, b) => {
          const value = (row: LedgerRow) =>
            sortKey === 'amount'
              ? (row.item.amountCents ?? -Infinity)
              : (row.item[sortKey] ?? '').toLowerCase();
          const left = value(a),
            right = value(b);
          if (left === right)
            return a.kind === 'pending' && b.kind === 'pending'
              ? Number(!!b.item.isDuplicate) - Number(!!a.item.isDuplicate)
              : 0;
          return (left < right ? -1 : 1) * (direction === 'asc' ? 1 : -1);
        }),
    [
      rows,
      props.filterDateStart,
      props.filterDateEnd,
      props.filterCategory,
      props.filterPayerId,
      props.filterCardId,
      sortKey,
      direction,
    ],
  );
  const selectedRows = processed.filter(row => selected.has(row.item.id));
  const allSelectedStarred = selectedRows.length > 0 && selectedRows.every(row => row.kind === 'approved' && !!row.item.isStarred);
  // Filtering/sorting precede grouping, so every file receives the same controls.
  const isClosedView =
    mode === 'approved' &&
    rows.length > 0 &&
    rows.every((row) => row.kind === 'approved' && row.item.cycleId !== null);
  const viewName =
    mode === 'pending'
      ? 'Pending'
      : isClosedView
        ? 'Cycle expenses'
        : readOnly
          ? 'Expenses'
          : 'Approved';
  const groups = new Map<string, { name: string; rows: LedgerRow[] }>();
  processed.forEach((row) => {
    const key = row.item.sourceFileId ?? 'other';
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else
      groups.set(key, {
        name:
          row.item.sourceFileName ?? 'Other review items',
        rows: [row],
      });
  });
  const cardName = (card: Card, snapshot: string | null) => props.closedCycleAt === undefined
    ? card.name : closedCycleCard(card, props.closedCycleAt, snapshot).name ?? card.name;
  const cardOptions = [
    ...cards.map((card) => ({
      id: card.id,
      name: `${members.find((member) => member.id === card.memberId)?.displayName ?? 'Unknown'} · ${cardName(card, transactions.find((tx) => tx.cardId === card.id)?.cardNameSnapshot ?? null)}`,
    })),
    ...transactions
      .filter((tx) => tx.cardId && !cards.some((card) => card.id === tx.cardId))
      .map((tx) => ({
        id: tx.cardId!,
        name: tx.cardNameSnapshot ?? 'Archived card',
      })),
  ].filter(
    (card, index, list) => list.findIndex((candidate) => candidate.id === card.id) === index,
  );
  const suggestions = buildCategorySuggestions(
    transactions.filter((tx) => tx.cycleId === null),
    categoryPreferences ?? {},
  );
  const valuesFor = (row: LedgerRow) =>
    draftRef.current[row.item.expenseId]?.values ?? draftFrom(row.item);
  const dirty = (row: LedgerRow) => {
    const draft = drafts[row.item.expenseId];
    return !!draft && JSON.stringify(draft.values) !== JSON.stringify(draftFrom(draft.base.item));
  };
  // Actions that send the saved values must wait until no selected row has unsaved or stale edits.
  const selectionUnsaved = selectedRows.some(row => dirty(row) || (!!drafts[row.item.expenseId] && drafts[row.item.expenseId].base.item.revision !== row.item.revision));
  useEffect(() => {
    props.onDraftStateChange?.({
      dirtyIds: transactions.filter((item) => {
        const draft = drafts[item.expenseId];
        return draft && JSON.stringify(draft.values) !== JSON.stringify(draftFrom(draft.base.item));
      }).map((item) => item.id),
      busyIds: transactions.filter((item) => busy.has(item.expenseId)).map((item) => item.id),
    });
  }, [transactions, drafts, busy, props.onDraftStateChange]);
  const edit = (row: LedgerRow, update: (draft: ExpenseDraft) => ExpenseDraft) => {
      const previous = draftRef.current[row.item.expenseId] ?? {
        base: row,
        values: draftFrom(row.item),
      };
      draftRef.current = {
        ...draftRef.current,
        [row.item.expenseId]: { ...previous, values: update(previous.values) },
      };
      setDrafts(draftRef.current);
  };
  const clear = (expenseId: string) => {
    {
      const next = { ...draftRef.current };
      delete next[expenseId];
      draftRef.current = next;
      setDrafts(next);
    }
    setErrors((current) => {
      const next = { ...current };
      delete next[expenseId];
      return next;
    });
    setAmountErrors(current => {
      const next = { ...current };
      delete next[expenseId];
      return next;
    });
  };
  const save = (row: LedgerRow, completed?: ExpenseDraft): Promise<LedgerRow> => {
    const key = row.item.expenseId;
    const previous = writes.current.get(key);
    const request = (async () => {
    if (previous) await previous;
    const record = draftRef.current[row.item.expenseId];
    const sent = completed ?? record?.values;
    if (!record || !sent || JSON.stringify(sent) === JSON.stringify(draftFrom(record.base.item)))
      return record?.base ?? row;
    const latest = rowsRef.current.find(candidate => candidate.item.expenseId === key);
    if (!latest || latest.kind !== record.base.kind || latest.item.revision > record.base.item.revision)
      throw new ApiError(409, 'Saved values changed. Your draft is retained.');
    const revision = record.base.item.revision;
    let saved: LedgerRow;
    if (row.kind === 'pending') {
      if (!props.onQueueUpdate) throw new Error('Saving Pending is unavailable.');
      saved = {
        kind: 'pending',
        item: await props.onQueueUpdate(row.item.id, validateDraft(sent, false, draftFrom(record.base.item)), revision),
      };
    } else {
      if (!props.onUpdate) throw new Error('Saving Approved is unavailable.');
      saved = {
        kind: 'approved',
        item: await props.onUpdate(row.item.id, approvedPatch(sent, draftFrom(record.base.item)), revision),
      };
    }
    const next = { base: saved, values: rebaseDraft(draftFrom(saved.item), sent, draftRef.current[key]?.values ?? sent) };
    draftRef.current = { ...draftRef.current, [row.item.expenseId]: next };
    setDrafts(draftRef.current);
    return saved;
    })();
    writes.current.set(key, request);
    setSaving(new Set(writes.current.keys()));
    void request.finally(() => {
      if (writes.current.get(key) === request) writes.current.delete(key);
      setSaving(new Set(writes.current.keys()));
    }).catch(() => {});
    return request;
  };
  const complete = (row: LedgerRow) => {
    if (row.kind !== 'pending' || valuesFor(row).customAllocation) return;
    const sent = { ...valuesFor(row) };
    setErrors(current => ({ ...current, [row.item.expenseId]: '' }));
    void save(row, sent).catch(async error => {
      setErrors(current => ({ ...current, [row.item.expenseId]: error instanceof Error ? error.message : 'Could not save this expense.' }));
      if (error instanceof ApiError && error.status === 409) await props.onChanged?.();
    });
  };
  const completedEdit = (row: LedgerRow, update: (draft: ExpenseDraft) => ExpenseDraft) => {
    edit(row, update);
    complete(row);
  };
  const execute = async (row: LedgerRow, action: () => Promise<void>) => {
    const key = row.item.expenseId;
    if (locks.current.all || locks.current.ids.has(key)) return;
    locks.current.ids.add(key);
    setBusy(new Set(locks.current.ids));
    setErrors((current) => ({ ...current, [key]: '' }));
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save this expense.';
      setErrors((current) => ({ ...current, [key]: message }));
      setFeedback(message);
      if (error instanceof ApiError && error.status === 409) await props.onChanged?.();
    } finally {
      locks.current.ids.delete(key);
      setBusy(new Set(locks.current.ids));
    }
  };
  const approve = async (row: LedgerRow) => {
    if (row.kind !== 'pending' || !props.onApprove) return;
    validateDraft(valuesFor(row), true, draftFrom(draftRef.current[row.item.expenseId]?.base.item ?? row.item));
    const saved = await save(row);
    if (saved.kind !== 'pending') throw new Error('Expense is no longer Pending.');
    await props.onApprove(saved.item);
    clear(row.item.expenseId);
    setFeedback('Expense approved.');
  };
  const deleteRow = async (row: LedgerRow) => {
    await writes.current.get(row.item.expenseId);
    const version = draftRef.current[row.item.expenseId]?.base.item.revision ?? row.item.revision;
    if (row.kind === 'pending') await props.onQueueDelete?.(row.item.id, version);
    else await props.onDelete?.(row.item.id, version);
    clear(row.item.expenseId);
    setDeleteId(null);
    setFeedback('Expense removed. Audit history retained.');
  };
  const moveExpense = async (row: LedgerRow, note?: string) => {
    const saved = await save(row);
    if (saved.kind !== 'approved' || !props.onReturnToPending) return;
    await props.onReturnToPending(saved.item, note);
    clear(saved.item.expenseId);
  };
  const starExpense = async (row: LedgerRow & { kind: 'approved' }, isStarred: boolean) => {
    await props.onUpdate?.(row.item.id, { isStarred }, row.item.revision);
    clear(row.item.expenseId);
  };
  const batch = async (
    action: (row: LedgerRow) => Promise<void>,
    target = processed.filter((row) => selected.has(row.item.id)),
  ) => {
    if (locks.current.all || locks.current.ids.size) return;
    locks.current.all = true;
    setAllBusy(true);
    setBusy(new Set(target.map((row) => row.item.expenseId)));
    try {
      for (const row of target) {
        try {
          await action(row);
          setSelected((current) => {
            const next = new Set(current);
            next.delete(row.item.id);
            return next;
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Could not complete bulk action.';
          setErrors((current) => ({
            ...current,
            [row.item.expenseId]: message,
          }));
          setFeedback(message);
          if (error instanceof ApiError && error.status === 409) await props.onChanged?.();
          break;
        }
      }
    } finally {
      locks.current.all = false;
      setAllBusy(false);
      setBusy(new Set());
    }
  };
  const deleteSelected = async () => {
    const target = processed.filter((row) => selected.has(row.item.id));
    if (mode !== 'pending' || !props.onQueueDeleteMany) {
      await batch(deleteRow, target);
      return;
    }
    // Pending deletion keeps the existing atomic bulk API and exact saved versions.
    await batch(
      async () => {
        await Promise.all(target.map(row => writes.current.get(row.item.expenseId)));
        const revisions = Object.fromEntries(
          target.map((row) => [
            row.item.id,
            draftRef.current[row.item.expenseId]?.base.item.revision ?? row.item.revision,
          ]),
        );
        await props.onQueueDeleteMany!(
          target.map((row) => row.item.id),
          revisions,
        );
        target.forEach((row) => clear(row.item.expenseId));
        setSelected(new Set());
      },
      target.slice(0, 1),
    );
  };
  const stageBulk = (update: (draft: ExpenseDraft) => ExpenseDraft) => {
    if (locks.current.all || locks.current.ids.size > 0) return;
    processed.filter((row) => selected.has(row.item.id)).forEach((row) => completedEdit(row, update));
  };
  const openAllocation = (draft: ExpenseDraft): ExpenseDraft => ({
    ...draft,
    customAllocation: draft.customAllocation ?? {
      percentages: Object.fromEntries(Object.entries(
        draft.splitType === 'custom' && draft.splitRule?.percentages
          ? draft.splitRule.percentages
          : Object.fromEntries(activeMembers.map(member => [member.id, splitRoster.includes(member.id) ? 100 / (splitRoster.length || 1) : 0])),
      ).map(([id, value]) => [id, String(value)])),
    },
  });
  const finishAmount = (row: LedgerRow) => {
    const record = draftRef.current[row.item.expenseId];
    let error = '';
    try {
      if (!valuesFor(row).amount.trim()) throw new RangeError('Enter a valid amount.');
      patchFrom({ ...valuesFor(row), customAllocation: undefined }, draftFrom(record?.base.item ?? row.item));
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Enter a valid amount.';
    }
    setAmountErrors(current => ({ ...current, [row.item.expenseId]: error }));
    if (!error) complete(row);
  };
  const parseBreakdownAmount = () => {
    if (!breakdown) throw new Error('Choose an expense to split.');
    const cents = Math.abs(parseAmountToCents(breakdownAmount));
    const total = breakdown.item.amountCents;
    if (total === null || cents <= 0 || cents >= Math.abs(total))
      throw new Error('Enter an amount greater than zero and less than the total.');
    return cents * (total < 0 ? -1 : 1);
  };
  const splitFields = (
    draft: ExpenseDraft, update: (next: ExpenseDraft) => void, disabled: boolean,
    onDone?: () => void, onCancel?: () => void, showShares = true,
  ) => {
    const allocation = draft.customAllocation;
    const byAmount = allocation?.mode === 'amount';
    let percentages: Record<string, number> = {};
    let amountCents: Record<string, number> = {};
    let error = '';
    if (allocation && byAmount) {
      try {
        amountCents = Object.fromEntries(Object.entries(allocation.amounts ?? {}).map(([id, text]) => [id, text.trim() ? parseAmountToCents(text) : 0]));
        error = amountWeightsError(amountCents) ?? '';
        if (!error) percentages = percentagesFromAmounts(amountCents);
      } catch {
        error = 'Enter a valid amount for each member.';
      }
    } else if (allocation) {
      try {
        percentages = Object.fromEntries(Object.entries(allocation.percentages).map(([id, text]) => [id, parsePercentageDraft(text)]));
        error = customPercentagesError(percentages) ?? '';
      } catch (cause) {
        error = cause instanceof Error ? cause.message : 'Enter valid percentages.';
      }
    }
    let shares: Record<string, number> | null = null;
    try {
      if (byAmount && showShares && !error) shares = distributeByWeight(parseAmountToCents(draft.amount), percentages);
    } catch {
      /* No bill amount yet: the dialog still shows the subtotal. */
    }
    const allocationMembers = allocation ? members.filter(member => !member.archivedAt || member.id in allocation.percentages) : [];
    const setMode = (mode: 'percent' | 'amount') => allocation && update({ ...draft, customAllocation: {
      ...allocation, mode, finished: false,
      amounts: allocation.amounts ?? Object.fromEntries(allocationMembers.map(member => [member.id, ''])),
    } });
    return <>
      {!onCancel && <label className="ledger-allocation-field text-xs text-slate-600">Split
        <select aria-label="Split" value={allocation ? 'custom' : draft.splitType} disabled={disabled} className={control} onChange={e => {
          const type = e.target.value;
          update(type === 'custom' ? openAllocation(draft) : {
            ...draft, customAllocation: undefined, splitType: type,
            splitRule: type === 'single' ? { memberId: draft.payerId || activeMembers[0]?.id } : null,
          });
        }}>
          <option value="">Choose split…</option><option value="equal">Shared (Equal)</option>
          <option value="single">Single person</option><option value="custom">Custom percentages</option>
        </select>
      </label>}
      {!allocation && draft.splitType === 'single' && <label className="ledger-allocation-field text-xs text-slate-600">Split member
        <select aria-label="Split member" value={draft.splitRule?.memberId ?? ''} disabled={disabled} className={control}
          onChange={e => update({ ...draft, splitRule: { memberId: e.target.value } })}>
          <option value="">Choose member…</option>{members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}
        </select>
      </label>}
      {!allocation && draft.splitType === 'custom' && <button type="button" className={button} disabled={disabled} onClick={() => update(openAllocation(draft))}>Edit allocation</button>}
      {allocation && <div className="ledger-allocation-mode col-span-full" role="group" aria-label="Split by">
        <button type="button" aria-pressed={!byAmount} disabled={disabled} onClick={() => setMode('percent')}>Percentage (%)</button>
        <button type="button" aria-pressed={byAmount} disabled={disabled} onClick={() => setMode('amount')}>Item amounts ($)</button>
      </div>}
      {byAmount && <p className="ledger-allocation-hint col-span-full">Enter what each person ordered before tax and tip. The full bill is split in the same proportion.</p>}
      {allocation && allocationMembers.map(member => byAmount
        ? <label key={member.id} className="ledger-allocation-field text-xs text-slate-600"><span>{member.displayName} ${shares && <span className="ledger-allocation-share"> · pays {formatCentsWithSymbol(shares[member.id] ?? 0)}</span>}</span>
          <input aria-label={`${member.displayName} amount`} type="text" inputMode="decimal" placeholder="0.00"
            value={allocation.amounts?.[member.id] ?? ''} disabled={disabled} className={control}
            onChange={e => update({ ...draft, customAllocation: { ...allocation, finished: false, amounts: { ...allocation.amounts, [member.id]: e.target.value } } })}
            onBlur={() => update({ ...draft, customAllocation: { ...allocation, finished: true } })} />
        </label>
        : <label key={member.id} className="ledger-allocation-field text-xs text-slate-600">{member.displayName} %
        <input aria-label={`${member.displayName} percentage`} type="text" inputMode="decimal"
          value={allocation.percentages[member.id] ?? '0'} disabled={disabled} className={control}
          onChange={e => update({ ...draft, customAllocation: { ...allocation, finished: false, percentages: { ...allocation.percentages, [member.id]: e.target.value } } })}
          onBlur={() => update({ ...draft, customAllocation: { ...allocation, finished: true } })} />
      </label>)}
      {allocation && <footer className="ledger-allocation-footer col-span-full">
        {byAmount
          ? <p className="ledger-allocation-total"><span>Subtotal</span><strong>{error ? '—' : formatCentsWithSymbol(Object.values(amountCents).reduce((sum, value) => sum + value, 0))}</strong></p>
          : <p className="ledger-allocation-total"><span>Total</span><strong>{Object.keys(percentages).length === Object.keys(allocation.percentages).length ? Object.values(percentages).reduce((sum, value) => sum + value, 0) : '—'}%</strong></p>}
        {allocation.finished && error && <p role="alert" className="text-sm text-red-700 mb-2">{error}</p>}
        <button type="button" className={`${button}${onCancel ? ' ledger-primary' : ''}`} disabled={disabled || !!error} onClick={() => {
          update({ ...draft, customAllocation: undefined, splitType: 'custom', splitRule: { percentages } });
          onDone?.();
        }}>Save allocation</button>{' '}
        <button type="button" className={button} disabled={disabled} onClick={() => {
          if (onCancel) onCancel();
          else { update({ ...draft, customAllocation: undefined }); onDone?.(); }
        }}>Cancel allocation</button>
      </footer>}
    </>;
  };
  const memberColor = (id: string) => {
    const index = members.findIndex((member) => member.id === id);
    return index < 0 ? color(id) : memberColorAt(index);
  };
  const categoryColor = (name: string) => ({
    Groceries: '#10b981', Dining: '#f97316', Utilities: '#3b82f6', Rent: '#6366f1',
    Entertainment: '#d946ef', Transport: '#06b6d4', Shopping: '#ec4899', Travel: '#8b5cf6', Health: '#ef4444', Other: '#64748b',
  }[name] ?? color(name));
  const rowColor = (draft: ExpenseDraft) => colorMode === 'none' ? 'transparent'
    : colorMode === 'payer' ? memberColor(draft.payerId)
      : colorMode === 'card' ? color(draft.cardId || 'No card') : categoryColor(draft.category || 'Uncategorized');
  // Both stages share one legend roster, so switching tabs cannot move the header.
  const legend = [...new Map(rowsRef.current.map((row) => {
    const draft = drafts[row.item.expenseId]?.values ?? draftFrom(row.item);
    const key = colorMode === 'payer' ? draft.payerId : colorMode === 'card' ? draft.cardId : draft.category;
    const label = colorMode === 'payer' ? members.find((m) => m.id === key)?.displayName ?? 'Unknown payer'
      : colorMode === 'card' ? cardOptions.find((c) => c.id === key)?.name ?? 'No card' : key || 'Uncategorized';
    return [key, { label, color: rowColor(draft) }] as const;
  })).values()].sort((a, b) => a.label.localeCompare(b.label));
  const splitControls = (row: LedgerRow, draft: ExpenseDraft, disabled: boolean) => {
    const chosen = draft.splitType === 'single' ? draft.splitRule?.memberId : null;
    const splitMembers = members.filter((member) => !member.archivedAt || member.id === chosen || (draft.splitType === 'custom' && member.id in (draft.splitRule?.percentages ?? {})));
    const allocationSummary = Object.entries(draft.splitRule?.percentages ?? {}).map(([id, value]) => `${members.find(m => m.id === id)?.displayName ?? 'Former member'} ${formatPercentage(value)}`).join(' · ');
    const indicator = (background: string) => <span aria-hidden="true" className="ledger-split-line" style={{ background }} />;
    return <div className="ledger-split" aria-label="Split between" data-read-only={readOnly || undefined}>
      <button type="button" className="ledger-icon ledger-split-button ledger-equal" aria-label={`Split ${draft.store || 'expense'} equally`} title="Equally among members who are in" aria-pressed={draft.splitType === 'equal'} disabled={disabled || readOnly} onClick={() => { completedEdit(row, (current) => ({ ...current, customAllocation: undefined, splitType: 'equal', splitRule: null })); closeAllocation(); }}>
        <Users size={14} aria-hidden="true" />{indicator('#64748b')}
      </button>
      {splitMembers.map((member) => <button key={member.id} type="button" className="ledger-icon ledger-split-button ledger-person" style={{ '--member-color': memberColor(member.id) } as React.CSSProperties} aria-label={`Assign ${draft.store || 'expense'} to ${member.displayName}`} title={member.displayName} aria-pressed={chosen === member.id} disabled={disabled || readOnly || (!!member.archivedAt && chosen !== member.id)} onClick={() => { completedEdit(row, (current) => ({ ...current, customAllocation: undefined, splitType: 'single', splitRule: { memberId: member.id } })); closeAllocation(); }}>
        {member.displayName.slice(0, 1).toUpperCase()}{indicator(memberColor(member.id))}
      </button>)}
      <button type="button" className="ledger-icon ledger-split-button ledger-custom" aria-describedby={`allocation-tip-${row.item.expenseId}`} title={draft.splitType === 'custom' ? `Custom split: ${allocationSummary}` : 'Custom percentages'} aria-description={draft.splitType === 'custom' ? allocationSummary : undefined} aria-label={`Custom split for ${draft.store || 'expense'}`} aria-pressed={draft.splitType === 'custom'} aria-expanded={splitEditor === row.item.expenseId} disabled={disabled || (readOnly && draft.splitType !== 'custom')} onClick={event => {
        allocationTrigger.current = event.currentTarget;
        if (splitEditor === row.item.expenseId) { closeAllocation(); return; }
        if (!readOnly) edit(row, openAllocation);
        setSplitEditor(row.item.expenseId);
      }}><Pencil size={14} aria-hidden="true" />{indicator('#7c3aed')}<span id={`allocation-tip-${row.item.expenseId}`} role="tooltip" className="ledger-split-tooltip">{draft.splitType === 'custom' ? allocationSummary : 'Custom percentages'}</span></button>
      {!draft.splitType && <span className="text-xs text-amber-700">Choose split</span>}
    </div>;
  };
  const filter = (
    label: string,
    value: string,
    setter: (value: string) => void,
    options: { id: string; name: string }[],
  ) => (
    <label className="text-xs text-slate-600">
      {label}
      <select
        aria-label={`Filter ${label.toLowerCase()}`}
        className={control}
        value={value}
        onChange={(e) => setter(e.target.value)}
      >
        <option value="">All {label.toLowerCase()}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section
      ref={ledgerElement}
      className="compact-ledger bg-white border border-slate-200 rounded-xl min-w-0"
      aria-label={`${mode === 'pending' ? 'Pending' : 'Approved'} ledger`}
    >
      <div className="ledger-header">
        <div className="ledger-heading">
          <h2 className="text-lg font-bold">
            {viewName} ({rows.length})
          </h2>
          <div className="ledger-stage-slot">
          {mode === 'pending' && !readOnly && (
            <button
              className={button}
              onClick={() => void batch(approve, processed)}
              disabled={allBusy || busy.size > 0}
            >
              Approve All
            </button>
          )}
          {mode === 'approved' && !readOnly && !isDemoMode() && suggestions.length > 0 && (
            <button className={button} onClick={() => setSuggestionsOpen(true)}>
              Suggest Categories ({suggestions.length})
            </button>
          )}
          </div>
        </div>
        <div className="ledger-display flex flex-wrap gap-3 items-center justify-between">
          <div className="flex flex-wrap gap-2 items-center min-w-0">
            <button className="ledger-icon border border-slate-200 bg-white" title="Filters" aria-label="Show filters" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}><Filter size={15} aria-hidden="true" /></button>
            <button className={`${button} ledger-details-toggle flex gap-2 items-center bg-white`} title={showDetails ? 'Hide payer and card' : 'Show payer and card'} aria-label={showDetails ? 'Hide details' : 'Show details'} aria-pressed={showDetails} onClick={() => setShowDetails(!showDetails)}>{showDetails ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />}<span>{showDetails ? 'Hide payer / card' : 'Show payer / card'}</span></button>
            <label className="text-xs text-slate-500 flex gap-2 items-center">Sort <select aria-label="Sort expenses" value={sortKey} className="bg-transparent rounded text-slate-700" onChange={(e) => setSortKey(e.target.value as SortKey)}>{['date', 'store', 'category', 'amount'].map((key) => <option key={key} value={key}>{key}</option>)}</select></label>
            <button className="ledger-icon" aria-label={direction === 'asc' ? 'Ascending' : 'Descending'} title="Reverse sort order" onClick={() => setDirection(direction === 'asc' ? 'desc' : 'asc')}><ArrowUpDown size={15} aria-hidden="true" /></button>
          </div>
          <div className="flex items-center gap-2"><span className="text-xs text-slate-500">Color by</span><div className="ledger-color-modes" aria-label="Color rows by">{(['category', 'payer', 'card', 'none'] as const).map((value) => <button key={value} aria-pressed={colorMode === value} onClick={() => setColorMode(value)}>{value}</button>)}</div></div>
        </div>
        <div hidden={!showFilters} className="ledger-filters grid grid-cols-2 lg:grid-cols-5 gap-3">
          <label className="text-xs text-slate-600">
            From
            <input
              aria-label="Filter date from"
              type="date"
              value={props.filterDateStart}
              min={present.minDate}
              max={present.maxDate}
              onChange={dateFilter(props.setFilterDateStart)}
              className={control}
            />
          </label>
          <label className="text-xs text-slate-600">
            Until
            <input
              aria-label="Filter date until"
              type="date"
              value={props.filterDateEnd}
              min={present.minDate}
              max={present.maxDate}
              onChange={dateFilter(props.setFilterDateEnd)}
              className={control}
            />
          </label>
          {filter(
            'Category',
            props.filterCategory,
            props.setFilterCategory,
            [...present.categories].map((category) => ({ id: category, name: category })),
          )}
          {filter(
            'Payer',
            props.filterPayerId,
            props.setFilterPayerId,
            members.filter((member) => present.payerIds.has(member.id)).map((member) => ({
              id: member.id,
              name: member.displayName,
            })),
          )}
          {filter('Card', props.filterCardId, props.setFilterCardId, cardOptions.filter((card) => present.cardIds.has(card.id)))}
        </div>
        <div className="ledger-filter-footer">
          <span role="status">{processed.length} of {rows.length} expenses</span>
          <button className={button} aria-label="Clear filters" disabled={!(props.filterDateStart || props.filterDateEnd || props.filterCategory || props.filterPayerId || props.filterCardId)} onClick={() => { props.setFilterDateStart(''); props.setFilterDateEnd(''); props.setFilterCategory(''); props.setFilterPayerId(''); props.setFilterCardId(''); }}>Clear filters</button>
        </div>
        <div className="ledger-legend" aria-label="Color legend">{colorMode === 'none' ? <span>Color highlighting off</span> : legend.map((entry) => <span key={entry.label}><i aria-hidden="true" style={{ background: entry.color }} />{entry.label}</span>)}</div>
        <div className="ledger-selection">
          {!readOnly ? <label>
            <input type="checkbox" aria-label="Select all visible expenses"
              checked={processed.length > 0 && processed.every(row => selected.has(row.item.id))}
              ref={input => { if (input) input.indeterminate = selected.size > 0 && !processed.every(row => selected.has(row.item.id)); }}
              onChange={e => setSelected(e.target.checked ? new Set(processed.map(row => row.item.id)) : new Set())}
              disabled={allBusy || processed.length === 0} />
            {selected.size ? `${selected.size} of ${processed.length} selected` : 'Select all visible expenses'}
          </label> : <span>{processed.length} expenses</span>}
          <span>Total · {formatCentsWithSymbol(processed.reduce((sum, row) => sum + (row.item.amountCents ?? 0), 0))}</span>
        </div>
        {hasBulkSelection && createPortal(
          <div ref={bulkToolbarElement} className="compact-ledger ledger-bulk-portal" style={{ left: bulkToolbarBounds.left, width: bulkToolbarBounds.width, visibility: bulkToolbarBounds.width ? 'visible' : 'hidden' }}>
          <div className="ledger-bulk" role="toolbar" aria-label="Selected expense actions">
            <p className="text-sm font-semibold">
              {selected.size} selected
            </p>
            <div className="ledger-bulk-fields">
              <select
                aria-label="Set category for selected expenses"
                className={control}
                disabled={allBusy || busy.size > 0}
                value=""
                onChange={(e) => stageBulk((draft) => ({ ...draft, category: e.target.value }))}
              >
                <option value="" disabled hidden>Category</option>
                {categories.map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
              <select
                aria-label="Set payer for selected expenses"
                className={control}
                disabled={allBusy || busy.size > 0}
                value=""
                onChange={(e) => stageBulk((draft) => changePayer(draft, e.target.value))}
              >
                <option value="" disabled hidden>Payer</option>
                {activeMembers.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName}
                  </option>
                ))}
              </select>
              <select
                aria-label="Set card for selected expenses"
                className={control}
                disabled={allBusy || busy.size > 0}
                value=""
                onChange={(e) =>
                  stageBulk((draft) => {
                    const card = cards.find((card) => card.id === e.target.value);
                    return {
                      ...draft,
                      cardId: e.target.value === 'none' ? '' : e.target.value,
                      payerId: card?.memberId ?? draft.payerId,
                    };
                  })
                }
              >
                <option value="" disabled hidden>Card</option>
                <option value="none">No card</option>
                {cards
                  .filter((card) => !card.archived)
                  .map((card) => (
                    <option key={card.id} value={card.id}>
                      {cardOptions.find((option) => option.id === card.id)?.name}
                    </option>
                  ))}
              </select>
              <select aria-label="Set split for selected expenses" className={control} value="" disabled={allBusy || busy.size > 0} onChange={event => {
                const value = event.target.value;
                if (value === 'custom') {
                  bulkAllocationTrigger.current = event.currentTarget;
                  setBulkSplit(openAllocation({ ...draftFrom(rows[0].item), splitType: 'equal', splitRule: null }));
                } else if (value) stageBulk(draft => ({ ...draft, customAllocation: undefined, splitType: value === 'equal' ? 'equal' : 'single', splitRule: value === 'equal' ? null : { memberId: value } }));
              }}><option value="" disabled hidden>Split</option><option value="equal">Equal</option>{activeMembers.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}<option value="custom">Custom</option></select>
            </div>
            <div className="ledger-bulk-actions">
              {mode === 'approved' && props.onReturnToPending && <button type="button" className={`${button} ledger-icon`} aria-label="Move selected to Pending" title="Move selected to Pending" disabled={allBusy || busy.size > 0 || selectedRows.some(row => row.kind !== 'approved' || row.item.cycleId !== null)} onClick={event => {
                const targets = selectedRows.filter((row): row is LedgerRow & { kind: 'approved' } => row.kind === 'approved');
                if (!targets.length) return;
                moveTrigger.current = event.currentTarget; setFeedback(''); setMove({ row: targets[0], targets, note: '', noteEdited: false });
              }}><Undo2 size={15} aria-hidden="true" /></button>}
              {mode === 'approved' && props.onUpdate && <button type="button" className={`${button} ledger-icon`} aria-label={allSelectedStarred ? 'Unstar selected expenses' : 'Star selected expenses'} title={allSelectedStarred ? 'Unstar selected expenses' : 'Star selected expenses'} aria-pressed={allSelectedStarred} disabled={allBusy || busy.size > 0 || selectionUnsaved} onClick={() => void batch(async row => { if (row.kind === 'approved') await starExpense(row, !allSelectedStarred); })}><Star size={15} fill={allSelectedStarred ? 'currentColor' : 'none'} aria-hidden="true" /></button>}
              <button
                aria-label="Delete selected" title="Delete selected expenses" className={`${button} ledger-icon`}
                disabled={allBusy || busy.size > 0}
                onClick={event => { bulkDeleteTrigger.current = event.currentTarget; setFeedback(''); setConfirmBulkDelete(true); }}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
              {mode === 'approved' && <button
                aria-label="Save selected" className={`${button} ledger-cycle-action`}
                disabled={allBusy || busy.size > 0}
                onClick={() =>
                  void batch(async (row) => {
                    await save(row);
                    clear(row.item.expenseId);
                  })
                }
              >
                Save
              </button>}
              {mode === 'pending' && props.onSendToGroup && <button
                type="button" id="send-to-group" className={`${button} ledger-icon`} aria-label="Send to group"
                title={selectionUnsaved ? 'Save or cancel unsaved changes first' : selected.size > MAX_BULK_BATCH ? `Select ${MAX_BULK_BATCH} rows or fewer` : 'Send to group'}
                disabled={allBusy || busy.size > 0 || saving.size > 0 || selectionUnsaved || selected.size > MAX_BULK_BATCH}
                onClick={() => props.onSendToGroup!(selectedRows.flatMap(row => row.kind === 'pending' ? [row.item] : []))}
              ><Send size={15} aria-hidden="true" /></button>}
              {mode === 'pending' && (
                <button
                  aria-label="Approve selected" className={button}
                  disabled={allBusy || busy.size > 0}
                  onClick={() => void batch(approve)}
                >
                  Approve
                </button>
              )}
              <button type="button" aria-label="Clear selection" title="Clear selection" className="ledger-icon" onClick={() => setSelected(new Set())}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            {bulkSplit && <dialog ref={bulkAllocationDialog} className="ledger-allocation-dialog" aria-label="Custom allocation for selected expenses" onCancel={event => { event.preventDefault(); closeBulkAllocation(); }} onClick={event => {
              if (event.target !== event.currentTarget) return;
              const box = event.currentTarget.getBoundingClientRect();
              if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeBulkAllocation();
            }}><header className="ledger-allocation-heading"><h3 className="font-semibold">Custom split</h3><button type="button" className="ledger-icon" aria-label="Close bulk allocation" onClick={closeBulkAllocation}><X size={18} aria-hidden="true" /></button></header><p className="ledger-allocation-merchant">{selected.size} selected expenses</p><div className="ledger-allocation-fields">{splitFields(bulkSplit, next => {
              if (next.customAllocation) setBulkSplit(next);
              else { stageBulk(draft => ({ ...draft, splitType: next.splitType, splitRule: next.splitRule })); setBulkSplit(null); }
            }, allBusy || busy.size > 0, closeBulkAllocation, closeBulkAllocation, false)}</div></dialog>}
            {confirmBulkDelete && <dialog ref={bulkDeleteDialog} className="ledger-delete-dialog" aria-label="Confirm bulk deletion" onCancel={event => { event.preventDefault(); closeBulkDelete(); }} onClick={event => {
              if (event.target !== event.currentTarget) return;
              const box = event.currentTarget.getBoundingClientRect();
              if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeBulkDelete();
            }}><header className="ledger-allocation-heading"><h3 className="font-semibold">Delete selected expenses</h3><button type="button" className="ledger-icon" aria-label="Close bulk deletion" disabled={allBusy || busy.size > 0} onClick={closeBulkDelete}><X size={18} aria-hidden="true" /></button></header><p className="mt-3 text-sm">Delete {selected.size} selected expenses? Unsaved edits will be discarded; audit history is retained.</p>{feedback && <p role="alert" className="mt-3 text-sm text-red-700">{feedback}</p>}<footer className="ledger-allocation-footer flex justify-end gap-2"><button className={button} disabled={allBusy || busy.size > 0} onClick={closeBulkDelete}>Cancel deletion</button><button className={`${button} text-red-700`} disabled={allBusy || busy.size > 0 || selected.size === 0} onClick={() => void deleteSelected()}>Confirm delete</button></footer></dialog>}
          </div>
          </div>, document.body,
        )}
      </div>
      {feedback && <p role="status" className="px-4 py-2 text-xs text-slate-600 border-b border-slate-200">{feedback}</p>}
      {processed.length === 0 && (
        <p className="p-6 text-slate-500">No {mode} expenses match these filters.</p>
      )}
      {[...groups].map(([key, group]) => (
        <section key={key} aria-label={group.name}>
          <h3 className="ledger-file"><FileText size={13} aria-hidden="true" /><span>{group.name} · {group.rows.length}</span></h3>
          <div className="ledger-columns ledger-grid" aria-hidden="true"><span /><span>Date</span><span>Store</span><span>Category</span><span className="text-right">Amount</span><span>Split between</span><span className="text-right">Actions</span></div>
          <ul className="divide-y divide-slate-100">
            {group.rows.map((row) => {
              const { item } = row;
              const draft = readOnly ? draftFrom(item) : drafts[item.expenseId]?.values ?? draftFrom(item);
              const disabled = allBusy || busy.has(item.expenseId), hasDraft = dirty(row), record = drafts[item.expenseId];
              const conflict = !!record && record.base.item.revision !== item.revision && !disabled && !saving.has(item.expenseId);
              const match = row.kind === 'pending' && row.item.isDuplicate ? findMatchingTransaction(row.item, transactions) : null;
              const change = (key: keyof ExpenseDraft, value: string) => edit(row, (current) => ({ ...current, [key]: value }));
              return <li key={item.id} className={`ledger-entry ${selected.has(item.id) ? 'bg-blue-50/50' : ''}`} style={{ borderLeftColor: rowColor(draft) }}>
                <div className="ledger-grid">
                  <div className="ledger-pick">{!readOnly && <input type="checkbox" aria-label={`Select ${item.store || 'review item'}`} checked={selected.has(item.id)} disabled={disabled} onChange={(e) => setSelected((current) => { const next = new Set(current); e.target.checked ? next.add(item.id) : next.delete(item.id); return next; })} />}</div>
                  {readOnly ? <span className="ledger-date">{draft.date || 'Not set'}</span> : (<input className="ledger-date ledger-field" aria-label="Date" type="date" value={draft.date} readOnly={readOnly} disabled={disabled} onChange={(e) => change('date', e.target.value)} onBlur={() => complete(row)} />)}
                  <div className="ledger-store-cell">
                  {readOnly ? <span className="ledger-store">{draft.store || 'Not set'}</span> : (<input className="ledger-store ledger-field" aria-label="Store" placeholder="Store required" value={draft.store} readOnly={readOnly} disabled={disabled} onChange={(e) => change('store', e.target.value)} onBlur={() => complete(row)} />)}
                {item.lastEditedAt !== null && (row.kind === 'approved' || item.hasBeenApproved) && <p className="ledger-edited-note text-orange-600">Edited by {item.editedByName ?? 'Actor unknown'} · {new Date(item.lastEditedAt).toLocaleString()}</p>}
                  </div>
                  {readOnly ? <span className="ledger-category">{draft.category || 'Not set'}</span> : (<select className="ledger-category ledger-field" aria-label="Category" value={draft.category} disabled={disabled || readOnly} onChange={(e) => { change('category', e.target.value); complete(row); }}><option value="">Choose category…</option>{!categories.includes(draft.category) && draft.category && <option>{draft.category}</option>}{categories.map((category) => <option key={category}>{category}</option>)}</select>)}
                  {readOnly ? <span className="ledger-amount">{item.amountCents === null ? 'Not set' : formatCentsWithSymbol(item.amountCents)}</span> : (<input className={`ledger-amount ledger-field ${Number(draft.amount) < 0 ? 'text-emerald-600' : ''}`} aria-label="Amount" inputMode="decimal" placeholder="Amount required" value={draft.amount} readOnly={readOnly} disabled={disabled} onChange={(e) => { change('amount', e.target.value); setAmountErrors(current => ({ ...current, [item.expenseId]: '' })); }} onBlur={() => finishAmount(row)} />)}
                  {splitControls(row, draft, disabled)}
                  <div className="ledger-actions">
                    {!readOnly && row.kind === 'pending' && <button className="ledger-icon text-blue-600" aria-label="Approve" title="Approve expense" disabled={disabled || conflict || !!draft.customAllocation} onClick={() => void execute(row, () => approve(row))}><Check size={16} aria-hidden="true" /></button>}
                    {!readOnly && row.kind === 'approved' && props.onReturnToPending && row.item.cycleId === null && <button className="ledger-icon" aria-label="Move to Pending" title="Move to Pending" disabled={disabled} onClick={event => { moveTrigger.current = event.currentTarget; setMove({ row, note: item.reviewNote ?? '', noteEdited: false }); }}><Undo2 size={15} aria-hidden="true" /></button>}
                    {(row.kind === 'approved' || item.hasBeenApproved) && <button className={`ledger-icon ${item.lastEditedAt !== null ? 'text-orange-600' : ''}`} aria-label="View edit history" title={item.lastEditedAt !== null ? `Edited by ${item.editedByName ?? 'Actor unknown'} · ${new Date(item.lastEditedAt).toLocaleString()}` : 'View edit history'} aria-expanded={historyId === item.expenseId} onClick={() => setHistoryId(historyId === item.expenseId ? null : item.expenseId)}><History size={15} aria-hidden="true" /></button>}
                    {!readOnly && row.kind === 'approved' && <button className="ledger-icon" aria-label={`${row.item.isStarred ? 'Unstar' : 'Star'} ${item.store}`} title="Favorite" aria-pressed={!!row.item.isStarred} disabled={disabled || hasDraft || conflict} onClick={() => void execute(row, () => starExpense(row, !row.item.isStarred))}><Star size={15} fill={row.item.isStarred ? 'currentColor' : 'none'} aria-hidden="true" /></button>}
                    {!readOnly && (row.kind === 'approved' ? props.onBreakdown : props.onQueueBreakdown) && <button className="ledger-icon" aria-label={`Break down ${item.store || 'expense'}`} title="Break down expense" disabled={disabled || conflict || !!draft.customAllocation || (row.kind === 'approved' && hasDraft)} onClick={event => { const trigger = event.currentTarget; void execute(row, async () => { const saved = await save(row); breakdownTrigger.current = trigger; setBreakdown(saved); setBreakdownAmount(''); setBreakdownError(''); setBreakdownId(generateId()); }); }}><Scissors size={15} aria-hidden="true" /></button>}
                    {!readOnly && <button className="ledger-icon hover:text-red-700" aria-label={`Delete ${item.store || 'expense'}`} title="Delete expense" disabled={disabled} onClick={event => { deleteTrigger.current = event.currentTarget; setDeleteId(item.expenseId); }}><Trash2 size={15} aria-hidden="true" /></button>}
                  </div>
                </div>
                {(showDetails || (!readOnly && !draft.payerId)) && <div className="ledger-details">
                  <label>Paid by <select aria-label="Payer" value={draft.payerId} disabled={disabled || readOnly} onChange={(e) => completedEdit(row, (current) => changePayer(current, e.target.value))}><option value="">Choose payer…</option>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label>
                  <label>Card <select aria-label="Card" value={draft.cardId} disabled={disabled || readOnly} onChange={(e) => { change('cardId', e.target.value); complete(row); }}><option value="">No card</option>{cards.filter((card) => card.memberId === draft.payerId && (!card.archived || card.id === draft.cardId)).map((card) => <option key={card.id} value={card.id}>{cardName(card, row.kind === 'approved' && card.id === row.item.cardId ? row.item.cardNameSnapshot : null)}</option>)}{draft.cardId && !cards.some((card) => card.id === draft.cardId) && <option value={draft.cardId}>{row.kind === 'approved' ? row.item.cardNameSnapshot ?? 'Archived card' : 'Archived card'}</option>}</select></label>
                  <span>Source: {item.sourceFileName ?? item.source ?? 'Legacy'}</span>
                </div>}
                {props.closingSnapshot && (() => { const original = props.closingSnapshot.transactions.find((tx) => tx.expenseId === item.expenseId); return !original || original.revision !== item.revision ? <p className="ledger-note text-amber-700">Changed since closing</p> : null; })()}
                {item.reviewNote !== null && <p className="ledger-note ledger-review-note text-amber-800">Review note: {item.reviewNote || '(cleared)'}</p>}
                {row.kind === 'pending' && !!row.item.isDuplicate && <details className="ledger-duplicate">
                  <summary>Potential duplicate · compare before approving</summary>
                  <div className="space-y-2 pt-2">{match && <p>Matches existing: {match.store} · {formatCentsWithSymbol(match.amountCents)} · {match.date} · {members.find((m) => m.id === match.payerId)?.displayName ?? 'Unknown payer'} · {cards.find((c) => c.id === match.cardId)?.name ?? match.cardNameSnapshot ?? 'No card'}</p>}
                    <div className="flex gap-2"><button className={button} disabled={disabled || readOnly} onClick={() => void execute(row, async () => { const saved = await save(row); if (saved.kind === 'pending') await props.onQueueUpdate?.(item.id, { isDuplicate: false }, saved.item.revision); clear(item.expenseId); })}>Keep both</button><button className={button} disabled={disabled || readOnly} onClick={event => { deleteTrigger.current = event.currentTarget; setDeleteId(item.expenseId); }}>Remove duplicate</button></div>
                  </div>
                </details>}
                {splitEditor === item.expenseId && <dialog ref={allocationDialog} className="ledger-allocation-dialog" aria-label="Custom allocation details" aria-labelledby={`allocation-title-${item.expenseId}`} onCancel={event => { event.preventDefault(); closeAllocation(); }} onClick={event => {
                  if (event.target !== event.currentTarget) return;
                  const box = event.currentTarget.getBoundingClientRect();
                  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeAllocation();
                }}>
                  <header className="ledger-allocation-heading"><h3 id={`allocation-title-${item.expenseId}`} className="font-semibold">Custom split</h3><button type="button" className="ledger-icon" aria-label="Close custom split" onClick={closeAllocation}><X size={18} aria-hidden="true" /></button></header>
                  <p className="ledger-allocation-merchant">{draft.store || 'Expense'} · {formatCentsWithSymbol(item.amountCents ?? 0)}</p>
                  {readOnly ? <><dl className="ledger-allocation-values">{Object.entries(draft.splitRule?.percentages ?? {}).map(([id, value]) => <div key={id}><dt>{members.find(member => member.id === id)?.displayName ?? 'Former member'}</dt><dd>{formatPercentage(value)}</dd></div>)}</dl><footer className="ledger-allocation-footer"><button className={button} onClick={closeAllocation}>Close allocation</button></footer></>
                    : <div className="ledger-allocation-fields">{splitFields(draft, (next) => completedEdit(row, () => next), disabled, closeAllocation, closeAllocation)}</div>}
                </dialog>}
                {(errors[item.expenseId] || amountErrors[item.expenseId]) && <p role="alert" className="ledger-note text-red-700">{errors[item.expenseId] || amountErrors[item.expenseId]}</p>}
                {conflict && <div className="ledger-inline bg-amber-50 text-sm"><p className="font-semibold">Saved values changed. Your draft is retained.</p>{expenseDifferences(record.base.item as unknown as Record<string, unknown>, item as unknown as Record<string, unknown>, Object.fromEntries(members.map((m) => [m.id, m.displayName]))).map((diff) => <p key={diff.field}>{diff.field}: {diff.before} → {diff.after}</p>)}<p>Cancel loads the latest saved values. Check history before reapplying your changes.</p></div>}
                {!readOnly && row.kind === 'approved' && (hasDraft || conflict) && <div className="ledger-savebar"><span className="text-xs text-slate-500">Unsaved changes</span><button className={`${button} bg-blue-600 text-white hover:bg-blue-700`} disabled={disabled || !hasDraft || conflict || !!draft.customAllocation} onClick={() => void execute(row, async () => { await save(row); clear(item.expenseId); setFeedback('Changes saved.'); })}>{disabled ? 'Saving…' : 'Save changes'}</button><button className={button} disabled={disabled} onClick={() => clear(item.expenseId)}>Cancel</button></div>}
                {!readOnly && row.kind === 'pending' && (hasDraft || conflict || saving.has(item.expenseId)) && <div className="ledger-savebar"><span className="text-xs text-slate-500">{saving.has(item.expenseId) ? 'Saving…' : 'Unfinished changes'}</span>{errors[item.expenseId] && <button className={button} disabled={disabled || conflict || saving.has(item.expenseId) || !!draft.customAllocation} onClick={() => complete(row)}>Retry</button>}<button className={button} disabled={disabled || saving.has(item.expenseId)} onClick={() => clear(item.expenseId)}>Cancel</button></div>}
                {!readOnly && deleteId === item.expenseId && <dialog ref={deleteDialog} className="ledger-delete-dialog" aria-label="Confirm deletion" onCancel={event => { event.preventDefault(); closeDelete(); }} onClick={event => {
                  if (event.target !== event.currentTarget) return;
                  const box = event.currentTarget.getBoundingClientRect();
                  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeDelete();
                }}><header className="ledger-allocation-heading"><h3 className="font-semibold">Delete expense</h3><button type="button" className="ledger-icon" aria-label="Close deletion" disabled={disabled} onClick={closeDelete}><X size={18} aria-hidden="true" /></button></header><p className="mt-3 text-sm">Delete this expense? Unsaved edits will be discarded. Audit history is retained.</p>{errors[item.expenseId] && <p role="alert" className="mt-3 text-sm text-red-700">{errors[item.expenseId]}</p>}<footer className="ledger-allocation-footer flex justify-end gap-2"><button className={button} disabled={disabled} onClick={closeDelete}>Cancel deletion</button><button className={`${button} text-red-700`} disabled={disabled} onClick={() => void execute(row, () => deleteRow(row))}>Confirm delete</button></footer></dialog>}
                {historyId === item.expenseId && <ExpenseHistory key={item.expenseId} expenseId={item.expenseId} members={members} cards={cards} closingSnapshot={props.closingSnapshot} current={row.kind === 'approved' ? row.item : undefined} client={client} onClose={() => setHistoryId(null)} />}
                      {breakdown && breakdown.item.expenseId === item.expenseId && (
        <dialog
          ref={breakdownDialog}
          aria-labelledby="breakdown-title"
          className="ledger-breakdown-region"
          onCancel={event => { event.preventDefault(); closeBreakdown(); }}
          onClick={event => {
            if (event.target !== event.currentTarget) return;
            const box = event.currentTarget.getBoundingClientRect();
            if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeBreakdown();
          }}
        >
          <div className="ledger-breakdown">
            <header><div><h2 id="breakdown-title" className="font-bold text-lg">Split Transaction</h2><p className="text-slate-500">{breakdown.item.store || 'Expense'}</p></div><button type="button" className="ledger-icon" aria-label="Close split transaction" disabled={busy.has(breakdown.item.expenseId)} onClick={closeBreakdown}><X size={18} aria-hidden="true" /></button></header>
            <div className="ledger-breakdown-body">
              <div className="ledger-preview"><span>Original amount</span><strong>{formatCentsWithSymbol(breakdown.item.amountCents ?? 0)}</strong></div>
              <label className="ledger-breakdown-label">Amount to separate
                <span className="ledger-money-input"><span aria-hidden="true">$</span><input
                  aria-label="Amount to separate" inputMode="decimal" value={breakdownAmount}
                  disabled={busy.has(breakdown.item.expenseId)} className={control}
                  onChange={e => { setBreakdownAmount(e.target.value); setBreakdownError(''); }}
                  onBlur={() => { try { parseBreakdownAmount(); setBreakdownError(''); } catch (cause) { setBreakdownError(cause instanceof Error ? cause.message : 'Enter a valid amount.'); } }}
                /></span>
              </label>
              {(() => {
                let portion: number | null = null;
                try { portion = parseBreakdownAmount(); } catch { /* Keep unfinished drafts local. */ }
                const stage = breakdown.kind === 'pending' ? 'Pending' : 'Approved';
                return <div className="ledger-previews" aria-live="polite">
                  <div className="ledger-preview" aria-label="Original entry preview"><div><strong>Original entry</strong><p>Remaining amount · {stage}</p></div><strong>{portion === null ? '—' : formatCentsWithSymbol((breakdown.item.amountCents ?? 0) - portion)}</strong></div>
                  <div className="ledger-preview" aria-label="New entry preview"><div><strong>New entry</strong><p>Edit category and allocation separately · {stage}</p></div><strong>{portion === null ? '—' : formatCentsWithSymbol(portion)}</strong></div>
                </div>;
              })()}
              <p className="text-slate-500">Total stays {formatCentsWithSymbol(breakdown.item.amountCents ?? 0)}</p>
            {breakdownError && (
              <p role="alert" className="text-red-700">
                {breakdownError}
              </p>
            )}
            </div>
            <footer className="ledger-breakdown-footer">
              <button
                className={button}
                disabled={busy.has(breakdown.item.expenseId)}
                onClick={closeBreakdown}
              >
                Cancel breakdown
              </button>
              <button
                className={`${button} ledger-primary`}
                disabled={busy.has(breakdown.item.expenseId) || (() => { try { parseBreakdownAmount(); return false; } catch { return true; } })()}
                onClick={() =>
                  void execute(breakdown, async () => {
                    try {
                      const cents = parseBreakdownAmount();
                      const saved = await save(breakdown);
                      const split = saved.kind === 'pending' ? props.onQueueBreakdown! : props.onBreakdown!;
                      await split(saved.item.id, breakdownId, cents, saved.item.revision);
                      clear(saved.item.expenseId);
                      setBreakdown(null);
                    } catch (error) {
                      setBreakdownError(
                        error instanceof Error ? error.message : 'Could not split this expense.',
                      );
                      throw error;
                    }
                  })
                }
              >
                Confirm Split
              </button>
            </footer>
          </div>
        </dialog>
      )}

              </li>;
            })}
          </ul>
        </section>
      ))}
      <div className="ledger-footer"><span>{processed.length} expenses</span><strong>{formatCentsWithSymbol(processed.reduce((sum, row) => sum + (row.item.amountCents ?? 0), 0))}</strong></div>
        <p className="ledger-guidance">
          {mode === 'pending'
            ? 'Pending expenses do not contribute to balances. Completed fields save automatically. Approve after checking values and duplicates.'
            : isClosedView
              ? 'Closed expenses. Saved corrections update current cycle amounts; closure history is retained.'
              : readOnly
                ? 'Saved expenses · read-only.'
                : 'Approved expenses contribute to provisional balances. Saved edits stay Approved.'}
        </p>
      {move && (
        <dialog
          ref={moveDialog}
          aria-labelledby="move-title"
          className="ledger-move-dialog"
          onCancel={event => { event.preventDefault(); closeMove(); }}
          onClick={event => {
            if (event.target !== event.currentTarget) return;
            const box = event.currentTarget.getBoundingClientRect();
            if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeMove();
          }}
        >
          <div className="space-y-3 w-full">
            <header className="ledger-allocation-heading"><h2 id="move-title" className="font-bold text-lg">
              Move to Pending
            </h2><button type="button" className="ledger-icon" aria-label="Close move to Pending" disabled={allBusy || busy.has(move.row.item.expenseId)} onClick={closeMove}><X size={18} aria-hidden="true" /></button></header>
            <p className="text-sm">
              This expense stops contributing to Approved balances until approved again. Values,
              source and history are retained.
            </p>
            <label className="block text-sm">
              Optional review note
              <input
                aria-label="Review note"
                className={control}
                value={move.note}
                disabled={allBusy || busy.has(move.row.item.expenseId)}
                onChange={(e) => setMove({ ...move, note: e.target.value, noteEdited: true })}
              />
            </label>
            {(move.targets ? feedback : errors[move.row.item.expenseId]) && (
              <p role="alert" className="text-red-700">{move.targets ? feedback : errors[move.row.item.expenseId]}</p>
            )}
            <div className="ledger-allocation-footer flex justify-end gap-2">
              <button
                className={button}
                disabled={allBusy || busy.has(move.row.item.expenseId)}
                onClick={closeMove}
              >
                Cancel move
              </button>
              <button
                className={`${button} ledger-primary`}
                disabled={allBusy || busy.has(move.row.item.expenseId)}
                onClick={() => {
                  const note = move.noteEdited ? move.note : undefined;
                  if (move.targets) { setFeedback(''); void batch(row => moveExpense(row, note), move.targets.filter(row => selected.has(row.item.id))); }
                  else void execute(move.row, async () => { await moveExpense(move.row, note); setMove(null); });
                }}
              >
                {move.targets ? 'Move selected expenses' : dirty(move.row) ? 'Save and move' : 'Move expense'}
              </button>
            </div>
          </div>
        </dialog>
      )}

      {hasBulkSelection && <div className="ledger-bulk-spacer" aria-hidden="true" style={{ height: bulkToolbarBounds.height + 32 }} />}
      {suggestionsOpen && (
        <CategorySuggestions
          suggestions={suggestions}
          onClose={() => setSuggestionsOpen(false)}
          onApply={async (updates) => {
            const result = await client.applyCategorySuggestions(
              updates.map((update) => ({
                ...update,
                revision: transactions.find((tx) => tx.id === update.id)!.revision,
              })),
            );
            await props.onChanged?.();
            if (result.skipped.length)
              showToast?.(
                `${result.skipped.length} suggestion(s) skipped because saved values changed.`,
                'error',
              );
            return result;
          }}
        />
      )}
    </section>
  );
}
