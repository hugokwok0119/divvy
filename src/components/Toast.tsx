import { useCallback, useEffect, useState, type FocusEvent } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';

export type ToastType = 'error' | 'success';
export interface ToastState { type: ToastType; text: string }

/** How long each toast stays before closing itself, unless hovered or focused. */
export const TOAST_MS = { success: 4000, error: 8000 } as const;
const EXIT_MS = 150;

/** Floating feedback, closed by its timer, the user, or replaced by the next action. */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const showToast = useCallback((text: string, type: ToastType = 'error') => {
    setToast({ type, text });
  }, []);
  const clearToast = useCallback(() => setToast(null), []);
  return { toast, showToast, clearToast };
}

export function Toast({ toast, onClose, demo }: { toast: ToastState | null; onClose: () => void; demo?: boolean }) {
  const [paused, setPaused] = useState(false);
  // The toast being animated out; a new toast object is never leaving.
  const [leavingToast, setLeavingToast] = useState<ToastState | null>(null);
  const leaving = toast !== null && leavingToast === toast;

  // Unmounting under the pointer or focus sends no leave event, so reset the pause.
  useEffect(() => { if (!toast) setPaused(false); }, [toast]);
  useEffect(() => {
    if (!toast || paused || leaving) return;
    const id = setTimeout(() => setLeavingToast(toast), TOAST_MS[toast.type]);
    return () => clearTimeout(id);
  }, [toast, paused, leaving]);
  useEffect(() => {
    if (!leaving) return;
    const id = setTimeout(onClose, EXIT_MS);
    return () => clearTimeout(id);
  }, [leaving, onClose]);

  if (!toast) return null;
  const error = toast.type === 'error';
  const focusOut = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
  };
  return (
    <div
      role={error ? 'alert' : 'status'}
      aria-live={error ? undefined : 'polite'}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={focusOut}
      className={`fixed left-1/2 -translate-x-1/2 z-40 ${demo ? 'top-[8.5rem]' : 'top-20'} w-[min(480px,calc(100vw-32px))] flex items-start gap-3 rounded-xl border-l-4 bg-white py-3 pl-4 pr-2 text-body1 text-slate-800 shadow-lg animate-[toast-in_200ms_ease-out] motion-reduce:[--toast-shift:0px] transition-[opacity,translate] duration-150 ${
        error ? 'border-red-500' : 'border-green-600'
      } ${leaving ? 'opacity-0 -translate-y-2 motion-reduce:translate-y-0' : ''}`}
    >
      {error
        ? <AlertTriangle size={20} aria-hidden="true" className="mt-1.5 shrink-0 text-red-600" />
        : <Check size={20} aria-hidden="true" className="mt-1.5 shrink-0 text-green-600" />}
      <span className="min-w-0 flex-1 break-words py-1.5">{toast.text}</span>
      <button
        type="button"
        onClick={() => setLeavingToast(toast)}
        aria-label="Dismiss notification"
        className="inline-flex h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
