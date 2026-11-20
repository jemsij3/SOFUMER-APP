import { useState } from 'react';
import { ExternalLink, ShieldCheck, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch, setUserToken } from '../lib/api';

export function AuthGateModal() {
  const {
    showAuthModal,
    setShowAuthModal,
    sandboxAvailable,
    botUsername,
    refreshSession,
    notify,
  } = useApp();

  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);

  if (!showAuthModal) return null;

  async function handleSandboxAuth(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await apiFetch<{ token: string }>('/api/auth/dev-sandbox', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim() || 'Global Member',
          handle: handle.trim() || 'sofumer_member',
        }),
      });
      if (res.token) setUserToken(res.token);
      await refreshSession();
      setShowAuthModal(false);
      notify('Authenticated via Telegram verification sandbox', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Authentication failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="w-full sm:max-w-md bg-[#0E1525] border border-slate-800 rounded-t-3xl sm:rounded-2xl p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Connect with Telegram</h2>
            <p className="mt-1 text-sm text-slate-400">
              SOFUMER uses Telegram-native identity. No email passwords or third-party logins.
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

        <div className="mt-5 p-4 rounded-xl bg-[#070B14] border border-slate-800/80 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0" />
            <span>Official Mini App Launch</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Open <span className="text-slate-200 font-medium">@{botUsername}</span> in Telegram and tap
            Launch SOFUMER to authenticate automatically with cryptographic Telegram initData.
          </p>
          <a
            href={`https://t.me/${botUsername}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 pt-1"
          >
            <span>Open @{botUsername} on Telegram</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>

        {sandboxAvailable && (
          <form onSubmit={handleSandboxAuth} className="mt-5 pt-5 border-t border-slate-800/80 space-y-3">
            <div className="text-xs font-medium text-slate-300">
              Preview Environment Telegram Sandbox
            </div>
            <p className="text-xs text-slate-400">
              Generates a server-signed Telegram initData payload and verifies it through the HMAC-SHA256 endpoint.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <input
                type="text"
                placeholder="Display Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
              />
              <input
                type="text"
                placeholder="telegram_handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full h-11 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors disabled:opacity-60"
            >
              {busy ? 'Verifying Telegram Signature...' : 'Continue in Preview Sandbox'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
