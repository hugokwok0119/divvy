
import React from 'react';
import { CheckCircle2, AlertTriangle, XCircle, FileText, Image as ImageIcon } from 'lucide-react';
import { formatCentsWithSymbol } from '../lib/money';

export type ImportSource = 'csv' | 'image' | 'mixed';
export type ReconciliationStatus = 'matched' | 'not_applicable' | 'failed' | 'mixed';
export type ImportOutcome = 'complete' | 'partial' | 'failed';

export interface ImportSummaryRow {
  date: string | null;
  store: string | null;
  amountCents: number | null;
  category: string | null;
}

export interface ImportBulkResult {
  summary: { inserted: number; duplicate: number; rejected: number };
}

export interface ImportSummary {
  files?: ImportSummary[];
  fileName: string;
  source: ImportSource;
  rowsFound: number;
  itemsTotalCents: number;
  statementTotalCents: number | null;
  reconciliationStatus: ReconciliationStatus;
  potentialDuplicates: number;
  categoriesInferred: number;
  rowsNeedingAttention: number;
  outcome: ImportOutcome;
  insertedCount: number;
  rejectedCount: number;
  failureMessage: string | null;
}

/**
 * Pure summary builder — no fetch, no state. The caller (InputSection) has
 * already parsed the file and, if reconciliation allowed it, sent the rows to
 * POST /api/queue/bulk; this just assembles what happened into one shape the
 * result screen can render.
 *
 * `reconciliationStatus: 'failed'` or a `failureMessage` forces `outcome:
 * 'failed'` with zero inserted/rejected regardless of what a `bulk` result
 * says, so a caller can never accidentally report success for an import that
 * didn't happen (failed reconciliation creates no queue rows; a bulk-call
 * failure after successful reconciliation is still a failed import overall).
 */
export function buildImportSummary(params: {
  fileName: string;
  source: ImportSource;
  rows: ImportSummaryRow[];
  itemsTotalCents?: number | null;
  statementTotalCents?: number | null;
  reconciliationStatus?: ReconciliationStatus;
  bulk?: ImportBulkResult | null;
  failureMessage?: string | null;
}): ImportSummary {
  const {
    fileName, source, rows,
    itemsTotalCents = null,
    statementTotalCents = null,
    reconciliationStatus = 'not_applicable',
    bulk = null,
    failureMessage = null,
  } = params;

  const resolvedItemsTotalCents = itemsTotalCents
    ?? rows.reduce((sum, r) => sum + (r.amountCents ?? 0), 0);
  const rowsNeedingAttention = rows.filter(
    (r) => r.date === null || r.store === null || r.amountCents === null,
  ).length;
  const categoriesInferred = rows.filter((r) => r.category !== null).length;

  const failed = Boolean(failureMessage) || reconciliationStatus === 'failed' || !bulk;

  if (failed) {
    return {
      fileName, source, rowsFound: rows.length,
      itemsTotalCents: resolvedItemsTotalCents, statementTotalCents,
      reconciliationStatus,
      potentialDuplicates: 0, categoriesInferred, rowsNeedingAttention,
      outcome: 'failed', insertedCount: 0, rejectedCount: 0,
      failureMessage: failureMessage ?? (rows.length === 0 ? 'No rows found in that file.' : 'Nothing was imported.'),
    };
  }

  const { inserted, duplicate, rejected } = bulk.summary;
  return {
    fileName, source, rowsFound: rows.length,
    itemsTotalCents: resolvedItemsTotalCents, statementTotalCents,
    reconciliationStatus,
    potentialDuplicates: duplicate, categoriesInferred, rowsNeedingAttention,
    outcome: rejected > 0 ? 'partial' : 'complete',
    insertedCount: inserted, rejectedCount: rejected,
    failureMessage: null,
  };
}

export function buildBatchImportSummary(summaries: ImportSummary[]): ImportSummary {
  if (summaries.length === 0) {
    return buildImportSummary({
      fileName: 'No files', source: 'mixed', rows: [], failureMessage: 'No files were selected.',
    });
  }
  if (summaries.length === 1) return summaries[0];

  const insertedCount = summaries.reduce((sum, item) => sum + item.insertedCount, 0);
  const rejectedCount = summaries.reduce((sum, item) => sum + item.rejectedCount, 0);
  const failed = summaries.filter((item) => item.outcome === 'failed');
  const partial = failed.length > 0
    || rejectedCount > 0
    || summaries.some((item) => item.outcome === 'partial');
  const failureMessage = failed.length > 0
    ? failed.map((item) => `${item.fileName}: ${item.failureMessage ?? 'Import failed.'}`).join(' ')
    : null;

  return {
    files: summaries,
    fileName: `${summaries.length} files`,
    source: summaries.every((item) => item.source === 'csv') ? 'csv'
      : summaries.every((item) => item.source === 'image') ? 'image' : 'mixed',
    rowsFound: summaries.reduce((sum, item) => sum + item.rowsFound, 0),
    itemsTotalCents: summaries.reduce((sum, item) => sum + item.itemsTotalCents, 0),
    statementTotalCents: null,
    reconciliationStatus: 'mixed',
    potentialDuplicates: summaries.reduce((sum, item) => sum + item.potentialDuplicates, 0),
    categoriesInferred: summaries.reduce((sum, item) => sum + item.categoriesInferred, 0),
    rowsNeedingAttention: summaries.reduce((sum, item) => sum + item.rowsNeedingAttention, 0),
    outcome: insertedCount === 0 && failed.length === summaries.length
      ? 'failed' : partial ? 'partial' : 'complete',
    insertedCount,
    rejectedCount,
    failureMessage,
  };
}

/** worker/routes/ai.ts returns this code on a 422 when a PDF's extracted items
 * do not reconcile against its printed statement total. */
export const RECONCILIATION_FAILED = 'reconciliation_failed';

export function isReconciliationFailure(reason: string | undefined): boolean {
  return reason === RECONCILIATION_FAILED;
}

const OUTCOME_STYLES: Record<ImportOutcome, { icon: React.ReactNode; label: string; classes: string }> = {
  complete: {
    icon: <CheckCircle2 size={20} />,
    label: 'Import complete',
    classes: 'bg-green-50 border-green-200 text-green-800',
  },
  partial: {
    icon: <AlertTriangle size={20} />,
    label: 'Partial import — check before approving',
    classes: 'bg-amber-50 border-amber-200 text-amber-800',
  },
  failed: {
    icon: <XCircle size={20} />,
    label: 'Import failed — no rows were added',
    classes: 'bg-red-50 border-red-200 text-red-800',
  },
};

const RECONCILIATION_LABEL: Record<ReconciliationStatus, string> = {
  matched: 'Matches printed statement total',
  failed: 'Did not match printed statement total',
  not_applicable: 'No printed total to check',
  mixed: 'Checked separately for each file',
};

function Field({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-100 last:border-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className={`min-w-0 max-w-[65%] text-right [overflow-wrap:anywhere] text-sm font-bold ${warn ? 'text-amber-700' : 'text-slate-800'}`}>{value}</span>
    </div>
  );
}

function SummaryDetails({ summary }: { summary: ImportSummary }) {
  return (
    <>
      <div className="flex items-center gap-2 mb-4">
        {summary.source === 'image' ? <ImageIcon size={18} className="text-blue-500" /> : <FileText size={18} className="text-emerald-500" />}
        <span className="min-w-0 font-bold text-slate-800 [overflow-wrap:anywhere]">{summary.fileName}</span>
        <span className="shrink-0 text-xs uppercase font-bold text-slate-400">
          {summary.source === 'csv' ? 'CSV' : summary.source === 'image' ? 'AI scan' : 'Batch'}
        </span>
      </div>

      {summary.failureMessage && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 [overflow-wrap:anywhere]">
          {summary.failureMessage}
        </div>
      )}

      <div className="divide-y divide-slate-100">
        <Field label="Rows found" value={summary.rowsFound} />
        <Field label="Extracted item total" value={formatCentsWithSymbol(summary.itemsTotalCents)} />
        {summary.statementTotalCents !== null && (
          <Field label="Printed statement total" value={formatCentsWithSymbol(summary.statementTotalCents)} />
        )}
        <Field label="Reconciliation" value={RECONCILIATION_LABEL[summary.reconciliationStatus]} warn={summary.reconciliationStatus === 'failed'} />
        <Field label="Potential duplicates" value={summary.potentialDuplicates} warn={summary.potentialDuplicates > 0} />
        <Field label="Categories inferred" value={`${summary.categoriesInferred} / ${summary.rowsFound}`} />
        <Field label="Rows requiring attention" value={summary.rowsNeedingAttention} warn={summary.rowsNeedingAttention > 0} />
        {summary.outcome !== 'failed' && (
          <Field
            label="Added to review queue"
            value={summary.rejectedCount > 0 ? `${summary.insertedCount} added, ${summary.rejectedCount} already existed` : summary.insertedCount}
            warn={summary.rejectedCount > 0}
          />
        )}
      </div>
    </>
  );
}

interface ImportResultScreenProps {
  summary: ImportSummary;
  onClose: () => void;
}

const ImportResultScreen: React.FC<ImportResultScreenProps> = ({ summary, onClose }) => {
  const style = OUTCOME_STYLES[summary.outcome];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-result-heading"
    >
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full max-h-[90dvh] flex flex-col overflow-hidden animate-in fade-in zoom-in duration-200">
        <div id="import-result-heading" role="status" aria-live="assertive" className={`shrink-0 flex items-center gap-2 px-6 py-4 border-b font-bold ${style.classes}`}>
          {style.icon}
          {style.label}
        </div>

        <div className="p-6 overflow-y-auto min-h-0">
          <SummaryDetails summary={summary} />
          {summary.files && (
            <div className="mt-6 space-y-4">
              {summary.files.map((file, index) => (
                <section key={index} aria-label={file.fileName} className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className={`mb-3 text-sm font-bold ${OUTCOME_STYLES[file.outcome].classes} rounded-lg border px-3 py-2`}>
                    {OUTCOME_STYLES[file.outcome].label}
                  </p>
                  <SummaryDetails summary={file} />
                </section>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 px-6 pb-6">
          <button
            type="button"
            onClick={onClose}
            className="w-full bg-blue-600 text-white font-bold text-sm py-3 rounded-xl hover:bg-blue-700 transition-colors shadow-md hover:shadow-lg"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImportResultScreen;
