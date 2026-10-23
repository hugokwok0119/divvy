import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export const closeButton = 'inline-flex h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-50';
export const secondaryButton = 'min-h-9 pointer-coarse:min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold hover:bg-slate-50 disabled:opacity-50';

/** Floating confirmation card: Escape, outside click and the close button dismiss unless busy; focus returns on close. */
export const ModalCard: React.FC<{
  title: string; busy?: boolean; onClose: () => void; restoreFocus: () => HTMLElement | null;
  footer: React.ReactNode; children: React.ReactNode;
}> = ({ title, busy = false, onClose, restoreFocus, footer, children }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const restore = useRef(restoreFocus);
  restore.current = restoreFocus;
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); restore.current()?.focus(); };
  }, []);
  const close = () => { if (!busy) onClose(); };
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="m-auto w-[calc(100vw-32px)] max-w-[420px] rounded-xl border border-slate-200 bg-white p-0 text-slate-700 shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const box = e.currentTarget.getBoundingClientRect();
        if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) close();
      }}
    >
      <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-3">
        <h2 id={titleId} className="text-heading2 text-slate-800">{title}</h2>
        <button type="button" aria-label="Close" disabled={busy} onClick={close} className={closeButton}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="px-5 py-4 text-body1">{children}</div>
      <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</footer>
    </dialog>
  );
};
