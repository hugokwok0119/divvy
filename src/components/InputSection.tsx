
import React, { useState, useRef, useEffect } from 'react';
import { Member, Card, Transaction, QueueItem, QueueItemInput } from '../types';
import { categoryOptions, generateId } from '../constants';
import { parseAmountToCents, formatCentsWithSymbol, MAX_AMOUNT_CENTS } from '../lib/money';
import { parseCsv } from '../lib/csv';
import { findExplicitCategoryPreference } from '../lib/category';
import { ApiError, groupHeaders } from '../lib/api';
import { isDemoMode } from '../lib/demo-mode';
import { MAX_UPLOAD_BYTES } from '../../worker/lib/gemini';
import { Upload, Plus, Loader2, Star, CreditCard, User, X, RotateCw } from 'lucide-react';
import ImportResultScreen, {
  buildBatchImportSummary, buildImportSummary, isReconciliationFailure, type ImportSummary,
} from './ImportResultScreen';

const MAX_UPLOAD_MB = (MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0);

type InputTab = 'upload' | 'manual';

/** Return value doubles as a completion signal: null means the bulk call
 * failed (App.tsx already toasted why), so the result screen can report
 * outcome "failed" instead of guessing at a partial success. */
type BulkResult = { created: QueueItem[]; summary: { inserted: number; duplicate: number; rejected: number } } | null;

interface InputSectionProps {
  onAddToQueue: (items: QueueItemInput[]) => Promise<BulkResult>;
  members: Member[];
  cards: Card[];
  customCategories: string[];
  categoryPreferences: Record<string, string>;
  starredTransactions: Transaction[];
  showToast: (message: string, type?: 'error' | 'success') => void;
}

const InputSection: React.FC<InputSectionProps> = ({
  onAddToQueue, members, cards, customCategories, categoryPreferences, starredTransactions, showToast,
}) => {
  const [activeTab, setActiveTab] = useState<InputTab>('upload');
  const [loading, setLoading] = useState(false);
  const [fileProgress, setFileProgress] = useState<{ current: number; total: number; name: string } | null>(null);
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const scanControllerRef = useRef<AbortController | null>(null);

  const [selectedPayerId, setSelectedPayerId] = useState(members[0]?.id || '');
  const [selectedCardId, setSelectedCardId] = useState('');

  const activeCards = cards.filter((c) => c.memberId === selectedPayerId && !c.archived);

  // Update card when payer changes
  useEffect(() => {
    if (!activeCards.some((c) => c.id === selectedCardId)) {
      setSelectedCardId(activeCards[0]?.id || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPayerId, cards]);

  const [manualForm, setManualForm] = useState({
    store: '',
    amount: '',
    category: 'Groceries',
    date: new Date().toISOString().split('T')[0],
  });

  const [manualError, setManualError] = useState('');
  const parseManualAmount = () => {
    const cents = parseAmountToCents(manualForm.amount);
    if (Math.abs(cents) > MAX_AMOUNT_CENTS) throw new RangeError('Amount must be between -1,000,000.00 and 1,000,000.00.');
    return cents;
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const allCategories = categoryOptions(customCategories);

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualForm.store.trim() || !manualForm.date || !selectedPayerId) {
      setManualError('Enter a store and date, and choose a payer.');
      return;
    }

    let amountCents: number;
    try {
      amountCents = parseManualAmount();
      setManualError('');
    } catch (cause) {
      setManualError(cause instanceof Error ? cause.message : 'Please enter a valid amount.');
      return;
    }

    await onAddToQueue([{
      id: generateId(),
      store: manualForm.store,
      amountCents,
      category: manualForm.category,
      date: manualForm.date,
      payerId: selectedPayerId,
      cardId: selectedCardId || null,
      splitType: null,
      source: 'manual',
    }]);

    setManualForm((prev) => ({ ...prev, store: '', amount: '' }));
  };

  const loadStarredItem = (tx: Transaction) => {
    setManualForm((prev) => ({
      ...prev,
      store: tx.store,
      category: tx.category,
      amount: formatCentsWithSymbol(tx.amountCents).replace('$', ''),
    }));
    setActiveTab('manual');
  };

  const importImageFile = async (file: File, signal: AbortSignal): Promise<ImportSummary> => {
    if (file.size > MAX_UPLOAD_BYTES) {
      const message = `${file.name} is larger than the ${MAX_UPLOAD_MB} MB scan limit.`;
      showToast(message);
      return buildImportSummary({
        fileName: file.name, source: 'image', rows: [], failureMessage: message,
      });
    }

    try {
      // Sent directly (not through src/lib/api.ts) so this call can carry an
      // AbortSignal, which is what makes the Cancel control below work.
      const res = await fetch('/api/ai/parse-receipt', {
        method: 'POST',
        body: file,
        headers: groupHeaders(),
        signal,
      });
      if (!res.ok) {
        const body = await res.json<{ error?: string; reason?: string }>()
          .catch((): { error?: string; reason?: string } => ({}));
        throw new ApiError(res.status, body.error ?? 'Could not read that receipt', body.reason);
      }
      const result = await res.json<{
        date: string | null; store: string | null; amountCents: number | null; category: string | null;
        statementTotalCents?: number | null; itemsTotalCents?: number; reconciled?: boolean;
        transactions?: Array<{
          date: string | null; store: string | null; amountCents: number | null; category: string | null;
        }>;
      }>();
      const drafts = result.transactions ?? [result];
      if (drafts.length === 0) throw new Error('No transactions found in that file.');

      const sourceFileId = generateId();
      const items: QueueItemInput[] = drafts.map((draft) => ({
        id: generateId(),
        date: draft.date,
        store: draft.store,
        amountCents: draft.amountCents,
        // AI route already applied exact explicit preferences after Gemini.
        category: draft.category,
        payerId: selectedPayerId || null,
        cardId: selectedCardId || null,
        splitType: null,
        source: 'image',
        sourceFileId,
        sourceFileName: file.name,
      }));

      // A printed statement total only exists for PDF statements — the server
      // echoes a same-value "statementTotalCents" for single receipts too
      // (self-check, not an independent total), so only trust it as a real
      // reconciliation for PDFs.
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const bulk = await onAddToQueue(items);
      return buildImportSummary({
        fileName: file.name,
        source: 'image',
        rows: items,
        itemsTotalCents: result.itemsTotalCents ?? null,
        statementTotalCents: isPdf ? (result.statementTotalCents ?? null) : null,
        reconciliationStatus: isPdf ? (result.reconciled === false ? 'failed' : 'matched') : 'not_applicable',
        bulk,
        failureMessage: bulk ? null : 'Could not add these rows to the review queue.',
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      setRetryFile(file);
      const message = err instanceof Error ? err.message : 'Could not read that receipt.';
      const reason = err instanceof ApiError ? err.reason : undefined;
      showToast(message);
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      return buildImportSummary({
        fileName: file.name,
        source: 'image',
        rows: [],
        reconciliationStatus: isPdf && isReconciliationFailure(reason) ? 'failed' : 'not_applicable',
        failureMessage: message,
      });
    }
  };

  const handleCancelScan = () => scanControllerRef.current?.abort();
  const handleRetryScan = () => {
    if (retryFile) void handleFilesUpload([retryFile]);
  };

  const importCsvFile = async (file: File): Promise<ImportSummary> => {
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      const sourceFileId = generateId();
      const items: QueueItemInput[] = rows.map((r) => ({
        id: generateId(),
        date: r.date,
        store: r.store,
        amountCents: r.amountCents,
        category: r.store ? findExplicitCategoryPreference(r.store, categoryPreferences) : null,
        payerId: selectedPayerId || null,
        cardId: selectedCardId || null,
        splitType: null,
        source: 'csv',
        sourceFileId,
        sourceFileName: file.name,
      }));

      const bulk = items.length > 0 ? await onAddToQueue(items) : null;
      return buildImportSummary({
        fileName: file.name,
        source: 'csv',
        rows: items,
        bulk,
        failureMessage: items.length > 0 && !bulk ? 'Could not add these rows to the review queue.' : null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not read that file.';
      showToast(message);
      return buildImportSummary({
        fileName: file.name, source: 'csv', rows: [], failureMessage: message,
      });
    }
  };

  const isCsvFile = (file: File) => file.type === 'text/csv' || file.name.toLowerCase().endsWith('.csv');

  const handleFilesUpload = async (files: File[]) => {
    if (files.length === 0) return;
    setRetryFile(null);
    setLoading(true);
    const controller = new AbortController();
    scanControllerRef.current = controller;
    const summaries: ImportSummary[] = [];
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        setFileProgress({ current: index + 1, total: files.length, name: file.name });
        // Sequential processing keeps AI quota predictable and lets each PDF
        // reconcile against its own statement total.
        // eslint-disable-next-line no-await-in-loop
        const summary = isCsvFile(file)
          ? await importCsvFile(file)
          : await importImageFile(file, controller.signal);
        summaries.push(summary);
      }
      setImportResult(buildBatchImportSummary(summaries));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') showToast('Upload canceled.');
      else showToast(err instanceof Error ? err.message : 'Could not process those files.');
      if (summaries.length > 0) setImportResult(buildBatchImportSummary(summaries));
    } finally {
      setLoading(false);
      setFileProgress(null);
      scanControllerRef.current = null;
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    void handleFilesUpload(files);

    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const tabs: { id: InputTab; icon: React.ReactNode; label: string }[] = [
    { id: 'upload', icon: <Upload size={20} />, label: 'Upload' },
    { id: 'manual', icon: <Plus size={20} />, label: 'Manual' },
  ];

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">

      {importResult && (
        <ImportResultScreen summary={importResult} onClose={() => setImportResult(null)} />
      )}

      {/* 1. Global Context Block */}
      <div className="bg-slate-50 p-4 border-b border-slate-200">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="input-payer" className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-2">
              <User size={16} className="text-blue-600" aria-hidden="true" />
              Who is Paying?
            </label>
            <select
              id="input-payer"
              className="w-full h-10 px-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm font-medium text-slate-800 bg-white shadow-sm"
              value={selectedPayerId}
              onChange={(e) => setSelectedPayerId(e.target.value)}
            >
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.displayName}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="input-card" className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-2">
              <CreditCard size={16} className="text-purple-600" aria-hidden="true" />
              Which Card?
            </label>
            <select
              id="input-card"
              className="w-full h-10 px-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-sm font-medium text-slate-800 bg-white shadow-sm"
              value={selectedCardId}
              onChange={(e) => setSelectedCardId(e.target.value)}
            >
              <option value="">No card</option>
              {activeCards.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* 2. Quick Add Favorites */}
      {starredTransactions.length > 0 && (
        <div className="bg-yellow-50/50 px-4 py-3 border-b border-yellow-100 overflow-x-auto">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-yellow-700 uppercase flex items-center gap-1 whitespace-nowrap">
              <Star size={12} fill="currentColor" /> Favorites:
            </span>
            <div className="flex gap-2">
              {starredTransactions.map((tx) => (
                <button
                  key={tx.id}
                  onClick={() => loadStarredItem(tx)}
                  className="flex items-center gap-2 px-3 py-1 bg-white border border-yellow-200 rounded-full text-xs font-medium text-slate-700 hover:border-yellow-400 hover:shadow-sm transition-all whitespace-nowrap"
                >
                  {tx.favoriteName || tx.store} <span className="text-slate-400">|</span> {formatCentsWithSymbol(tx.amountCents)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 3. Input Method Tabs */}
      <div className="flex border-b border-slate-200">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            aria-label={tab.label}
            aria-pressed={activeTab === tab.id}
            className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-bold transition-all ${
              activeTab === tab.id
                ? 'bg-white text-blue-600 border-b-2 border-blue-600 shadow-[inset_0_-2px_0_0_#2563eb]'
                : 'bg-slate-50 text-slate-500 hover:text-slate-700 hover:bg-slate-100'
            }`}
          >
            {tab.icon}
            <span className="hidden sm:inline" aria-hidden="true">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* 4. Content Area */}
      <div className="p-4 sm:p-6 bg-white min-h-[200px]">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-48 text-slate-500">
            <Loader2 className="animate-spin mb-4 text-blue-500" size={40} />
            <p className="text-lg font-medium">
              {fileProgress
                ? `Processing ${fileProgress.current} of ${fileProgress.total}: ${fileProgress.name}`
                : 'Processing…'}
            </p>
            {activeTab === 'upload' && (
              <button
                type="button"
                onClick={handleCancelScan}
                className="mt-4 flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors"
              >
                <X size={14} /> Cancel
              </button>
            )}
          </div>
        ) : (
          <>
            {activeTab === 'upload' && retryFile && (
              <div className="mb-4 flex items-center justify-between gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
                <span>That scan didn&apos;t finish.</span>
                <button
                  type="button"
                  onClick={handleRetryScan}
                  className="flex items-center gap-1 px-3 py-1.5 font-bold text-amber-900 border border-amber-300 rounded-lg hover:bg-amber-100 transition-colors whitespace-nowrap"
                >
                  <RotateCw size={14} /> Retry
                </button>
              </div>
            )}
            {activeTab === 'manual' && (
              <form noValidate onSubmit={handleManualSubmit} className="space-y-4 animate-in fade-in duration-300">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="manual-store" className="block text-xs font-bold text-slate-500 mb-1 uppercase">Store Name</label>
                    <input
                      id="manual-store"
                      type="text"
                      required
                      placeholder="e.g. Trader Joe's"
                      className="w-full h-10 px-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white"
                      value={manualForm.store}
                      onChange={(e) => setManualForm({ ...manualForm, store: e.target.value })}
                    />
                  </div>
                  <div>
                    <label htmlFor="manual-amount" className="block text-xs font-bold text-slate-500 mb-1 uppercase">Amount</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold" aria-hidden="true">$</span>
                      <input
                        id="manual-amount"
                        type="text"
                        inputMode="decimal"
                        required
                        placeholder="0.00"
                        className="w-full h-10 pl-7 pr-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm font-bold bg-white"
                        value={manualForm.amount}
                        onChange={(e) => { setManualForm({ ...manualForm, amount: e.target.value }); setManualError(''); }}
                        onBlur={() => {
                          try { parseManualAmount(); setManualError(''); }
                          catch (cause) { setManualError(cause instanceof Error ? cause.message : 'Please enter a valid amount.'); }
                        }}
                      />
                    </div>
                    {manualError && <p role="alert" className="text-sm text-red-700 mt-1">{manualError}</p>}
                  </div>
                  <div>
                    <label htmlFor="manual-category" className="block text-xs font-bold text-slate-500 mb-1 uppercase">Category</label>
                    <select
                      id="manual-category"
                      className="w-full h-10 px-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white"
                      value={manualForm.category}
                      onChange={(e) => setManualForm({ ...manualForm, category: e.target.value })}
                    >
                      {allCategories.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="manual-date" className="block text-xs font-bold text-slate-500 mb-1 uppercase">Date</label>
                    <input
                      id="manual-date"
                      type="date"
                      required
                      className="w-full h-10 px-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white"
                      value={manualForm.date}
                      onChange={(e) => setManualForm({ ...manualForm, date: e.target.value })}
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  className="w-full bg-blue-600 text-white font-bold text-sm py-3 rounded-xl hover:bg-blue-700 transition-colors shadow-md hover:shadow-lg mt-4"
                >
                  Add Transaction
                </button>
              </form>
            )}

            {activeTab === 'upload' && (
              <>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex flex-col items-center justify-center py-10 border-2 border-dashed border-slate-300 rounded-xl bg-slate-50 hover:bg-slate-100 transition-colors cursor-pointer group animate-in fade-in duration-300"
                >
                  <div className="bg-white p-4 rounded-full shadow-sm mb-4 group-hover:scale-110 transition-transform">
                    <Upload className="text-blue-500" size={48} aria-hidden="true" />
                  </div>
                  <p className="text-lg text-slate-700 font-bold">Upload files</p>
                  <p className="text-sm text-slate-400 mt-1">
                    {isDemoMode()
                      ? 'Demo: only the sample statements are accepted, and nothing is uploaded.'
                      : 'PDF and images use Google AI. CSV stays in your browser. Multiple files supported.'}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    Maximum {MAX_UPLOAD_MB} MB per scanned PDF or image.
                  </p>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,application/pdf,.pdf,text/csv,.csv"
                  multiple
                  className="hidden"
                  onChange={handleFileUpload}
                  aria-label="Upload receipts, statements, images, or CSV files"
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default InputSection;
