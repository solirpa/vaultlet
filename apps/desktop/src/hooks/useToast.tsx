import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from '../lib/utils';

export type ToastKind = 'info' | 'success' | 'error';

interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastContextValue {
  toast: (text: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const toast = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = ++seq.current;
    setToasts((prev) => [...prev.slice(-2), { id, kind, text }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2200);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-1.5">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cx(
              'elev-pop animate-toast rounded-full px-3.5 py-1.5 text-xs font-medium',
              t.kind === 'error' ? 'text-danger' : 'text-text',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (text: string, kind?: ToastKind) => void {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx.toast;
}
