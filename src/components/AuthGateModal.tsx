import { ExternalLink, Lock, ShieldCheck, X } from 'lucide-react';
import { useApp } from '../context/AppContext';

export function AuthGateModal() {
  const {
    showAuthModal,
    setShowAuthModal,
    botUsername,
    botName,
  } = useApp();

  if (!showAuthModal) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="w-full sm:max-w-md bg-[#0E1525] border border-slate-800 rounded-t-3xl sm:rounded-2xl p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Telegram Mini App Required</h2>
            <p className="mt-1 text-sm text-slate-400">
              SOFUMER operates exclusively inside Telegram using verified Telegram Mini App authentication.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAuthModal(false)}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl text-slate-400 hover:text-white hover:bg-slate-800/60"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-5 p-4 rounded-xl bg-[#070B14] border border-slate-800/80 space-y-2.5">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0" />
            <span>{botName ? `${botName} Official Mini App` : 'Official Telegram Mini App'}</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            {botUsername
              ? `Open @${botUsername} in Telegram and tap Launch SOFUMER to sign in automatically.`
              : 'Launch SOFUMER from its official Telegram bot menu button inside the Telegram app.'}
          </p>
          {botUsername ? (
            <a
              href={`https://t.me/${botUsername}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 pt-1"
            >
              <span>Open @{botUsername} on Telegram</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-slate-500 pt-1">
              <Lock className="w-3.5 h-3.5 shrink-0" />
              <span>Public browser access is disabled.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
