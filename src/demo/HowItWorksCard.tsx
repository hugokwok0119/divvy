import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { SAMPLE_DOWNLOADS } from './samples';

const secondary = 'min-h-9 pointer-coarse:min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold hover:bg-slate-50';

/** Floating card (native dialog, as in ExpenseHistory): Escape, outside click and close dismiss; focus returns to the opener. */
export function HowItWorksCard({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current, trigger = document.activeElement as HTMLElement | null;
    if (!dialog) return;
    dialog.showModal();
    return () => { dialog.close(); if (trigger?.isConnected) trigger.focus(); };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="demo-how-title"
      className="m-auto max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-[480px] rounded-xl border border-slate-200 bg-white p-0 text-slate-700 shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const box = e.currentTarget.getBoundingClientRect();
        if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) onClose();
      }}
    >
      <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-3">
        <h2 id="demo-how-title" className="text-heading2 text-slate-800">How this demo works</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="inline-flex h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100">
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="space-y-4 px-5 py-4 text-body1">
        <p>Divvy splits shared credit card spending in a household. This demo runs a fictional household, Alex and Sam, entirely in your browser. You are Alex, the owner.</p>
        <section>
          <h3 className="font-semibold">Try this in 5 minutes</h3>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            <li>Download a sample statement below.</li>
            <li>Import it as Alex, with Alex's card, and read the result.</li>
            <li>In Pending, fix a flagged row and approve it.</li>
            <li>Watch it move to Approved and the settlement change.</li>
            <li>Open Analytics (the chart icon in the header).</li>
          </ol>
        </section>
        <section>
          <h3 className="font-semibold">Sample statements</h3>
          <ul className="mt-1 space-y-3">
            {SAMPLE_DOWNLOADS.map((s) => (
              <li key={s.id}>
                <a href={s.url} download={s.fileName} className="font-semibold text-blue-700 underline">{s.fileName}</a>
                <p className="text-body2 text-slate-600">{s.description}</p>
                <p className="text-body2 text-slate-600">All data is made up.</p>
              </li>
            ))}
          </ul>
        </section>
        <p>In the real app, Gemini reads the statement. Here the AI step returns the known answer for each sample, so no file ever leaves your browser. Any other file is refused.</p>
      </div>
      <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3 text-body1">
        <a href="https://github.com/hugokwok0119/divvy" target="_blank" rel="noopener noreferrer" className={secondary}>Source on GitHub</a>
        <button type="button" onClick={onClose} className="min-h-9 pointer-coarse:min-h-11 rounded-lg bg-slate-900 px-4 py-1.5 font-semibold text-white hover:bg-slate-800">Start exploring</button>
      </footer>
    </dialog>
  );
}
