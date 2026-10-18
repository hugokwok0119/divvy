import { useCallback, useState } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';

export type ToastType = 'error' | 'success';
export interface ToastState { type: ToastType; text: string }

/** Quiet inline feedback, dismissed by the user or replaced by the next action. */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const showToast = useCallback((text: string, type: ToastType = 'error') => {
    setToast({ type, text });
  }, []);
  const clearToast = useCallback(() => setToast(null), []);
  return { toast, showToast, clearToast };
}

export function Toast({ toast, onClose }: { toast: ToastState | null; onClose: () => void }) {
  if (!toast) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-4 px-4 py-3 rounded-lg border flex items-center gap-3 text-sm ${
      toast.type === 'error' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-green-50 border-green-200 text-green-800'
    }`}>
      {toast.type === 'error' ? <AlertTriangle size={20} aria-hidden="true" /> : <Check size={20} aria-hidden="true" />}
      <span className="min-w-0 break-words">{toast.text}</span>
      <button onClick={onClose} aria-label="Dismiss notification" className="ml-2 hover:opacity-50"><X size={14} aria-hidden="true" /></button>
    </div>
  );
}
