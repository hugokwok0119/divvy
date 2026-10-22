import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import CycleSummaryImage from './CycleSummaryImage';
import { summaryFileName, type CycleSummary } from '../lib/cycleSummary';
import { downloadJpeg } from '../lib/exportImage';
import { closedDateOf, formatDateSpan } from '../lib/money';

const PREVIEW_WIDTH = 512;

/** Dialog that previews the cycle summary image and downloads it as a JPG. */
export default function CycleSummaryDialog({ summary, closedLabel, onClose }: {
  summary: CycleSummary; closedLabel: string; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const exportNode = useRef<HTMLDivElement>(null);
  const [detailed, setDetailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const generatedOn = closedDateOf(Date.now());
  const close = () => { if (!busy) onClose(); };

  useEffect(() => {
    const node = dialog.current, trigger = document.activeElement as HTMLElement | null;
    if (!node) return;
    node.showModal();
    return () => { node.close(); if (trigger?.isConnected) trigger.focus(); };
  }, []);

  // Scale only the visible preview; the off-screen export copy stays at full size.
  useLayoutEffect(() => {
    const width = exportNode.current?.firstElementChild?.scrollWidth ?? PREVIEW_WIDTH;
    setZoom(Math.min(1, PREVIEW_WIDTH / width));
  }, [detailed, summary]);

  const download = async () => {
    const node = exportNode.current?.firstElementChild as HTMLElement | null;
    if (!node) return;
    setBusy(true);
    setError('');
    try {
      await downloadJpeg(node, summaryFileName(closedLabel));
      onClose();
    } catch {
      setError('Could not create the image. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const image = <CycleSummaryImage summary={summary} detailed={detailed} generatedOn={generatedOn} />;

  return (
    <dialog
      ref={dialog}
      aria-labelledby="cycle-summary-title"
      aria-busy={busy}
      className="m-auto w-[calc(100vw-32px)] max-w-[560px] max-h-[calc(100dvh-32px)] rounded-2xl border border-slate-200 bg-white p-0 text-slate-700 shadow-[0_20px_50px_#0f172a33] backdrop:bg-black/40 backdrop:backdrop-blur-sm"
      onCancel={(event) => { event.preventDefault(); close(); }}
      // A repeated Escape fires a non-cancelable cancel and closes natively; keep React in sync.
      // The event is async, so skip closes from our own cleanup (unmounted, or reopened by StrictMode).
      onClose={() => { if (dialog.current && !dialog.current.open) onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
      }}
    >
      <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
        <div>
          <h2 id="cycle-summary-title" className="text-heading2 font-semibold text-slate-900">Download summary</h2>
          <p className="text-body2 text-slate-500">
            {summary.householdName} · closed {formatDateSpan(summary.closedDate, summary.closedDate)} · {summary.people.length} people
          </p>
        </div>
        <button type="button" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-40" aria-label="Close download summary" disabled={busy} onClick={close}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <label className="flex min-h-11 cursor-pointer items-start gap-3 px-6 py-3">
        <input type="checkbox" className="mt-0.5 h-[18px] w-[18px] accent-indigo-600" checked={detailed} disabled={busy} onChange={(e) => setDetailed(e.target.checked)} />
        <span>
          <span className="block text-body1 font-semibold text-slate-900">Detailed grid view</span>
          <span className="block text-body2 text-slate-500">Adds every item, with each person's exact share in their own column. The image gets wider with more people.</span>
        </span>
      </label>

      <div className="mx-6 mb-4 h-[300px] overflow-auto rounded-xl border border-slate-200 bg-slate-100 p-3" aria-label="Image preview">
        <div style={{ zoom }} aria-hidden="true">{image}</div>
      </div>
      {/* Full-size copy that html-to-image rasterizes. */}
      <div ref={exportNode} aria-hidden="true" style={{ position: 'fixed', left: -10000, top: 0 }}>{image}</div>

      {error && <p role="alert" className="mx-6 mb-3 text-body1 text-red-700">{error}</p>}

      <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4">
        <button type="button" className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-body1 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button type="button" className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-body1 font-semibold text-white hover:bg-indigo-500 disabled:opacity-60" disabled={busy} onClick={() => void download()}>
          <Download size={16} aria-hidden="true" />
          {busy ? 'Creating…' : 'Download JPG'}
        </button>
      </div>
    </dialog>
  );
}
