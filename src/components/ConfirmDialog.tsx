import { useEffect, useState } from 'react';
import { AlertTriangle, ShieldAlert, X } from 'lucide-react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  consequences?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'primary';
  confirmTextMatch?: string;
  confirmTextLabel?: string;
  confirmTextPlaceholder?: string;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  reasonValue?: string;
  onReasonChange?: (value: string) => void;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  consequences,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  confirmTextMatch,
  confirmTextLabel,
  confirmTextPlaceholder,
  reasonLabel,
  reasonPlaceholder,
  reasonValue,
  onReasonChange,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typedConfirm, setTypedConfirm] = useState('');

  useEffect(() => {
    setTypedConfirm('');
  }, [open, title, confirmTextMatch]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const expectedMatch = confirmTextMatch ? confirmTextMatch.trim() : '';
  const isMatchValid = !expectedMatch || typedConfirm.trim() === expectedMatch;
  const canConfirm = !busy && isMatchValid;

  const confirmBtnCls =
    variant === 'danger'
      ? 'bg-red-600 hover:bg-red-500 text-white'
      : variant === 'warning'
      ? 'bg-amber-600 hover:bg-amber-500 text-white'
      : 'bg-blue-600 hover:bg-blue-500 text-white';

  const iconBoxCls =
    variant === 'danger'
      ? 'bg-red-950/60 border-red-800/60 text-red-400'
      : variant === 'warning'
      ? 'bg-amber-950/60 border-amber-800/60 text-amber-400'
      : 'bg-blue-950/60 border-blue-800/60 text-blue-400';

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-[#0E1525] border border-slate-700/80 shadow-2xl p-5 sm:p-6 space-y-4 text-left"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${iconBoxCls}`}>
              {variant === 'danger' ? (
                <ShieldAlert className="w-5 h-5" />
              ) : (
                <AlertTriangle className="w-5 h-5" />
              )}
            </div>
            <div>
              <h2 id="confirm-dialog-title" className="text-base font-bold text-white leading-snug">
                {title}
              </h2>
              {description && (
                <p className="mt-1 text-xs text-slate-300 leading-relaxed">{description}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            aria-label="Close confirmation dialog"
            className="w-8 h-8 rounded-lg bg-[#070B14] border border-slate-800 text-slate-400 hover:text-white flex items-center justify-center shrink-0 disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {consequences && consequences.length > 0 && (
          <div className="p-3 rounded-xl bg-[#070B14] border border-slate-800 space-y-1.5 text-xs">
            <div className="font-semibold text-slate-200">What will happen:</div>
            <ul className="space-y-1 text-slate-400 list-disc pl-4">
              {consequences.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        {onReasonChange && (
          <div>
            <label className="block text-xs text-slate-400 mb-1">
              {reasonLabel || 'Reason (Optional)'}
            </label>
            <input
              type="text"
              disabled={busy}
              value={reasonValue || ''}
              onChange={(e) => onReasonChange(e.target.value)}
              placeholder={reasonPlaceholder || 'Optional note or audit reason...'}
              className="w-full h-10 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-white focus:outline-none focus:border-blue-500 disabled:opacity-60"
            />
          </div>
        )}

        {expectedMatch && (
          <div>
            <label className="block text-xs text-slate-300 mb-1">
              {confirmTextLabel || (
                <>
                  Type <span className="font-semibold text-white">{expectedMatch}</span> to confirm:
                </>
              )}
            </label>
            <input
              type="text"
              disabled={busy}
              value={typedConfirm}
              onChange={(e) => setTypedConfirm(e.target.value)}
              placeholder={confirmTextPlaceholder || expectedMatch}
              autoFocus
              className="w-full h-10 px-3 rounded-xl bg-[#070B14] border border-slate-700 text-xs text-white focus:outline-none focus:border-red-500 disabled:opacity-60"
            />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="h-10 px-4 rounded-xl bg-[#070B14] border border-slate-700 text-xs font-medium text-slate-200 hover:text-white disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => {
              if (canConfirm) void onConfirm();
            }}
            className={`h-10 px-4 rounded-xl text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${confirmBtnCls}`}
          >
            {busy ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
