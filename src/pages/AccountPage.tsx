import { useEffect, useState } from 'react';
import {
  Bell,
  ChevronRight,
  Clock,
  FileText,
  Heart,
  HelpCircle,
  LogOut,
  MessageSquare,
  Package,
  Store,
  Trash2,
  User as UserIcon,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import type { Product } from '../types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ProductCard } from '../components/ProductCard';

export function AccountPage() {
  const {
    user,
    shop,
    countries,
    currencies,
    displayCurrency,
    setDisplayCurrency,
    language,
    setLanguage,
    unreadMessages,
    unreadNotifications,
    navigate,
    switchTab,
    refreshSession,
    requireUserOrPrompt,
    logout,
    notify,
  } = useApp();

  const [displayName, setDisplayName] = useState(user?.display_name || '');
  const [phone, setPhone] = useState(user?.phone || '');
  const [countryCode, setCountryCode] = useState(user?.country_code || 'US');
  const [bio, setBio] = useState(user?.bio || '');
  const [editingProfile, setEditingProfile] = useState(false);

  useEffect(() => {
    if (user) {
      setDisplayName(user.display_name);
      setPhone(user.phone);
      setCountryCode(user.country_code);
      setBio(user.bio);
    }
  }, [user]);

  if (user?.isAdmin || user?.mode === 'admin') {
    return null;
  }

  async function savePreferences(nextCur?: string, nextLang?: string, nextCountry?: string) {
    const c = nextCur || displayCurrency;
    const l = nextLang || language;
    const co = nextCountry || countryCode;
    if (nextCur) setDisplayCurrency(nextCur);
    if (nextLang) setLanguage(nextLang);
    if (nextCountry) setCountryCode(nextCountry);

    if (!user) return;
    try {
      await apiFetch('/api/account/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          displayName,
          phone,
          bio,
          countryCode: co,
          preferredCurrency: c,
          preferredLanguage: l,
        }),
      });
      await refreshSession();
      notify('Preferences saved', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Save failed', 'error');
    }
  }

  return (
    <div className="space-y-6 pb-12 max-w-4xl mx-auto">
      {/* Profile Card */}
      <section className="p-5 sm:p-6 rounded-2xl bg-[#0E1525] border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-[#131C31] border border-slate-700 flex items-center justify-center shrink-0">
            <UserIcon className="w-6 h-6 text-blue-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">
              {user ? user.display_name : 'Guest Visitor'}
            </h1>
            <p className="text-xs text-slate-400">
              {user
                ? `@${user.telegram_username || user.telegram_id} · ${user.country_code} · ${user.preferred_currency}`
                : 'Sign in with Telegram to manage orders, messages, and your shop'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {!user ? (
            <button
              type="button"
              onClick={() => requireUserOrPrompt()}
              className="h-11 px-5 rounded-xl bg-blue-600 text-white text-sm font-semibold"
            >
              Connect Telegram
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setEditingProfile((v) => !v)}
                className="h-10 px-4 rounded-xl bg-[#131C31] border border-slate-700 text-xs font-medium text-slate-200"
              >
                Edit Profile
              </button>
              <button
                type="button"
                onClick={() => navigate({ type: 'seller' })}
                className="h-10 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5"
              >
                <Store className="w-4 h-4" />
                <span>{shop ? 'Seller Center' : 'Sell on SOFUMER'}</span>
              </button>
            </>
          )}
        </div>
      </section>

      {editingProfile && user && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            savePreferences();
            setEditingProfile(false);
          }}
          className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3"
        >
          <div className="text-sm font-semibold text-white">My Profile</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display Name" className="h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="International Phone" className="h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
          </div>
          <textarea rows={2} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Short bio" className="w-full p-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
          <button type="submit" className="h-10 px-4 rounded-xl bg-blue-600 text-white text-xs font-semibold">
            Save Profile
          </button>
        </form>
      )}

      {/* Global Language, Currency, Country Preferences */}
      <section className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Language</label>
          <select
            value={language}
            onChange={(e) => savePreferences(undefined, e.target.value)}
            className="w-full h-11 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
          >
            <option value="en">English</option>
            <option value="fr">Français</option>
            <option value="es">Español</option>
            <option value="ar">العربية</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Display Currency</label>
          <select
            value={displayCurrency}
            onChange={(e) => savePreferences(e.target.value)}
            className="w-full h-11 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
          >
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Country & Region</label>
          <select
            value={countryCode}
            onChange={(e) => savePreferences(undefined, undefined, e.target.value)}
            className="w-full h-11 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
          >
            {countries.map((co) => (
              <option key={co.code} value={co.code}>{co.name}</option>
            ))}
          </select>
        </div>
      </section>

      {/* Account Destinations */}
      <section className="rounded-2xl bg-[#0E1525] border border-slate-800 divide-y divide-slate-800/80 overflow-hidden">
        {[
          { icon: Package, label: 'My Orders', sub: 'Direct transaction confirmations & history', action: () => navigate({ type: 'orders' }) },
          { icon: Heart, label: 'My Wishlist', sub: 'Saved listings across global shops', action: () => navigate({ type: 'wishlist' }) },
          { icon: Clock, label: 'Recently Viewed', sub: 'Listings you inspected recently', action: () => navigate({ type: 'recently_viewed' }) },
          { icon: MessageSquare, label: 'My Messages', sub: `${unreadMessages} unread messages`, action: () => switchTab('messages') },
          { icon: Store, label: shop ? `My Shop (${shop.name})` : 'My Shops / Become a Seller', sub: 'Manage storefront, products & plans', action: () => navigate({ type: 'seller' }) },
          { icon: Bell, label: 'Notifications', sub: `${unreadNotifications} unread alerts`, action: () => navigate({ type: 'notifications' }) },
          { icon: HelpCircle, label: 'Help and Support', sub: 'Submit & track support tickets', action: () => navigate({ type: 'support' }) },
          { icon: FileText, label: 'Terms and Policies', sub: 'Direct transaction & prohibited item rules', action: () => navigate({ type: 'policies' }) },
        ].map((row) => (
          <button
            key={row.label}
            type="button"
            onClick={row.action}
            className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-slate-800/30 transition-colors"
          >
            <div className="flex items-center gap-3.5 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-[#070B14] border border-slate-800 flex items-center justify-center shrink-0">
                <row.icon className="w-4 h-4 text-blue-400" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-white truncate">{row.label}</div>
                <div className="text-xs text-slate-400 truncate">{row.sub}</div>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
          </button>
        ))}

        {user && (
          <button
            type="button"
            onClick={logout}
            className="w-full px-5 py-4 flex items-center gap-3.5 text-left hover:bg-red-950/20 text-red-400 transition-colors"
          >
            <div className="w-9 h-9 rounded-xl bg-red-950/30 border border-red-900/40 flex items-center justify-center shrink-0">
              <LogOut className="w-4 h-4" />
            </div>
            <span className="text-sm font-medium">Logout</span>
          </button>
        )}
      </section>
    </div>
  );
}

export function WishlistOrRecentPage({ mode }: { mode: 'wishlist' | 'recently_viewed' }) {
  const { user, goBack, requireUserOrPrompt, refreshSession, notify } = useApp();
  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [removingItem, setRemovingItem] = useState<Product | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const url = mode === 'wishlist' ? '/api/marketplace/favorites' : '/api/marketplace/recently-viewed';
    apiFetch<{ items: Product[] }>(url)
      .then((res) => setItems(res.items || []))
      .finally(() => setLoading(false));
  }, [user, mode]);

  async function handleConfirmRemoveItem() {
    if (!removingItem || busy) return;
    setBusy(true);
    try {
      const endpoint =
        mode === 'wishlist'
          ? `/api/marketplace/favorites/${removingItem.id}`
          : `/api/marketplace/recently-viewed/${removingItem.id}`;
      await apiFetch(endpoint, { method: 'DELETE' });
      setItems((prev) => prev.filter((item) => item.id !== removingItem.id));
      await refreshSession();
      notify(mode === 'wishlist' ? 'Removed from wishlist' : 'Removed from viewing history', 'info');
      setRemovingItem(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to remove item', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmClearAll() {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch('/api/marketplace/recently-viewed', { method: 'DELETE' });
      setItems([]);
      notify('Recently viewed history cleared', 'info');
      setConfirmClearAll(false);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to clear history', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5 pb-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={goBack} className="text-sm text-slate-300 hover:text-white min-h-[44px]">
          ← Back
        </button>
        <div className="flex items-center gap-3">
          {mode === 'recently_viewed' && user && items.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClearAll(true)}
              className="h-9 px-3 rounded-xl bg-red-950/60 border border-red-800/50 text-red-200 hover:text-white text-xs font-medium inline-flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear History</span>
            </button>
          )}
          <h1 className="text-lg font-bold text-white">
            {mode === 'wishlist' ? 'My Wishlist' : 'Recently Viewed'}
          </h1>
        </div>
      </div>
      {!user ? (
        <div className="p-8 rounded-2xl bg-[#0E1525] border border-slate-800 text-center space-y-3">
          <p className="text-sm text-slate-400">Connect with Telegram to view saved items.</p>
          <button type="button" onClick={() => requireUserOrPrompt()} className="h-10 px-4 rounded-xl bg-blue-600 text-white text-xs font-semibold">
            Connect Account
          </button>
        </div>
      ) : loading ? (
        <div className="h-40 rounded-2xl bg-[#0E1525] animate-pulse" />
      ) : items.length === 0 ? (
        <div className="p-8 rounded-2xl bg-[#0E1525] border border-slate-800 text-center text-sm text-slate-400">
          No items yet.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
          {items.map((p) => (
            <div key={p.id} className="space-y-1.5">
              <ProductCard product={p} />
              <button
                type="button"
                onClick={() => setRemovingItem(p)}
                className="w-full h-8 px-2.5 rounded-lg bg-[#0E1525] border border-slate-800 hover:border-red-800/60 text-[11px] text-slate-400 hover:text-red-300 flex items-center justify-center gap-1 transition-colors"
              >
                <Trash2 className="w-3 h-3" />
                <span>{mode === 'wishlist' ? 'Remove from Wishlist' : 'Remove Entry'}</span>
              </button>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(removingItem)}
        title={mode === 'wishlist' ? 'Remove from Wishlist?' : 'Remove Viewing Entry?'}
        description={
          removingItem
            ? `Remove "${removingItem.title}" from your ${mode === 'wishlist' ? 'saved wishlist' : 'recently viewed history'}?`
            : undefined
        }
        confirmLabel="Remove"
        variant="danger"
        busy={busy}
        onConfirm={handleConfirmRemoveItem}
        onCancel={() => setRemovingItem(null)}
      />

      <ConfirmDialog
        open={confirmClearAll}
        title="Clear Recently Viewed History?"
        description="This will remove all products from your personal browsing history."
        consequences={[
          'All entries in your Recently Viewed list will be removed.',
          'Your saved Wishlist and active Orders will not be affected.',
        ]}
        confirmLabel="Clear History"
        variant="danger"
        busy={busy}
        onConfirm={handleConfirmClearAll}
        onCancel={() => setConfirmClearAll(false)}
      />
    </div>
  );
}

export function NotificationsSupportPoliciesPage({ mode }: { mode: 'notifications' | 'support' | 'policies' }) {
  const { user, goBack, refreshSession, requireUserOrPrompt, notify } = useApp();
  const [notifs, setNotifs] = useState<
    Array<{ id: string; title: string; body: string; created_at: string; is_read: number; scope?: string }>
  >([]);
  const [tickets, setTickets] = useState<Array<{ id: string; subject: string; message: string; status: string; admin_response: string }>>([]);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [deleteNotifTarget, setDeleteNotifTarget] = useState<{ id: string; title: string } | null>(null);
  const [confirmClearReadNotifs, setConfirmClearReadNotifs] = useState(false);
  const [cancelTicketTarget, setCancelTicketTarget] = useState<{ id: string; subject: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (mode === 'notifications') {
      apiFetch<{ notifications: typeof notifs }>('/api/account/notifications').then((res) => {
        setNotifs(res.notifications || []);
        apiFetch('/api/account/notifications/read', { method: 'PATCH' }).then(() => refreshSession()).catch(() => {});
      });
    } else if (mode === 'support') {
      apiFetch<{ tickets: typeof tickets }>('/api/account/support').then((res) => setTickets(res.tickets || []));
    }
  }, [user, mode, refreshSession]);

  async function handleConfirmDeleteNotif() {
    if (!deleteNotifTarget || busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/account/notifications/${deleteNotifTarget.id}`, { method: 'DELETE' });
      setNotifs((prev) => prev.filter((item) => item.id !== deleteNotifTarget.id));
      await refreshSession();
      notify('Notification deleted', 'info');
      setDeleteNotifTarget(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to delete notification', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmClearReadNotifs() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ deletedCount: number }>('/api/account/notifications/read', { method: 'DELETE' });
      setNotifs((prev) => prev.filter((item) => item.scope === 'global' || item.is_read === 0));
      await refreshSession();
      notify(
        res.deletedCount > 0
          ? `Cleared ${res.deletedCount} personal notification(s)`
          : 'No personal read notifications to clear',
        'info'
      );
      setConfirmClearReadNotifs(false);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to clear notifications', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmCancelTicket() {
    if (!cancelTicketTarget || busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/account/support/${cancelTicketTarget.id}`, { method: 'DELETE' });
      setTickets((prev) => prev.filter((item) => item.id !== cancelTicketTarget.id));
      notify('Support ticket cancelled', 'info');
      setCancelTicketTarget(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to cancel support ticket', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'policies') {
    return (
      <div className="max-w-3xl mx-auto space-y-5 pb-12">
        <button type="button" onClick={goBack} className="text-sm text-slate-300 hover:text-white min-h-[44px]">← Back</button>
        <div className="p-6 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-4 text-sm text-slate-300 leading-relaxed">
          <h1 className="text-xl font-bold text-white">SOFUMER Terms & Marketplace Policies</h1>
          <p><strong>Direct Transactions:</strong> SOFUMER connects buyers and sellers worldwide. Payment and delivery terms are arranged directly between buyer and seller. SOFUMER does not hold funds in escrow or process mandatory payments.</p>
          <p><strong>Prohibited Listings:</strong> Counterfeit goods, stolen property, illegal weapons, narcotics, and deceptive listings are strictly prohibited and removed upon moderation review.</p>
          <p><strong>Privacy & Security:</strong> Private messages are restricted to conversation participants and authorized safety moderators during abuse investigations.</p>
        </div>
      </div>
    );
  }

  const hasPersonalNotifs = notifs.some((n) => n.scope !== 'global');

  return (
    <div className="max-w-3xl mx-auto space-y-5 pb-12">
      <button type="button" onClick={goBack} className="text-sm text-slate-300 hover:text-white min-h-[44px]">← Back</button>
      {!user ? (
        <div className="p-8 rounded-2xl bg-[#0E1525] border border-slate-800 text-center space-y-3">
          <p className="text-sm text-slate-400">Sign in to continue.</p>
          <button type="button" onClick={() => requireUserOrPrompt()} className="h-10 px-4 rounded-xl bg-blue-600 text-white text-xs font-semibold">Connect Account</button>
        </div>
      ) : mode === 'notifications' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-lg font-bold text-white">Notifications</h1>
            {hasPersonalNotifs && (
              <button
                type="button"
                onClick={() => setConfirmClearReadNotifs(true)}
                className="h-9 px-3 rounded-xl bg-[#0E1525] border border-slate-700 hover:border-red-800/60 text-xs text-slate-200 hover:text-red-200 inline-flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear Read Alerts</span>
              </button>
            )}
          </div>
          {notifs.length === 0 ? (
            <div className="p-6 rounded-2xl bg-[#0E1525] border border-slate-800 text-sm text-slate-400">No notifications yet.</div>
          ) : (
            notifs.map((n) => (
              <div key={n.id} className="p-4 rounded-xl bg-[#0E1525] border border-slate-800 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-white">{n.title}</span>
                    {n.scope === 'global' && (
                      <span className="px-2 py-0.5 rounded bg-blue-950/60 border border-blue-800/50 text-[10px] text-blue-300">
                        Announcement
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-300 mt-1">{n.body}</p>
                  <div className="text-[11px] text-slate-500 mt-1.5 font-mono-nums">{new Date(n.created_at + 'Z').toLocaleString()}</div>
                </div>
                {n.scope !== 'global' && (
                  <button
                    type="button"
                    aria-label="Delete notification"
                    onClick={() => setDeleteNotifTarget({ id: n.id, title: n.title })}
                    className="h-8 w-8 rounded-lg bg-[#070B14] border border-slate-800 hover:border-red-800/60 text-slate-400 hover:text-red-300 flex items-center justify-center shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="space-y-5">
          <h1 className="text-lg font-bold text-white">Help & Support</h1>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await apiFetch('/api/account/support', {
                  method: 'POST',
                  body: JSON.stringify({ subject, message }),
                });
                setSubject('');
                setMessage('');
                notify('Support ticket submitted', 'success');
                const res = await apiFetch<{ tickets: typeof tickets }>('/api/account/support');
                setTickets(res.tickets || []);
              } catch (err) {
                notify(err instanceof Error ? err.message : 'Failed to submit ticket', 'error');
              }
            }}
            className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3"
          >
            <input type="text" required value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
            <textarea rows={3} required value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Describe your issue or question..." className="w-full p-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
            <button type="submit" className="h-10 px-5 rounded-xl bg-blue-600 text-white text-xs font-semibold">Submit Ticket</button>
          </form>
          <div className="space-y-2.5">
            {tickets.map((t) => (
              <div key={t.id} className="p-4 rounded-xl bg-[#0E1525] border border-slate-800 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-white">{t.subject}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-blue-400 uppercase">{t.status}</span>
                    {t.status === 'open' && (
                      <button
                        type="button"
                        onClick={() => setCancelTicketTarget({ id: t.id, subject: t.subject })}
                        className="h-7 px-2.5 rounded-lg bg-red-950/60 border border-red-800/50 text-red-200 hover:text-white inline-flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>Cancel Ticket</span>
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-slate-300">{t.message}</p>
                {t.admin_response && (
                  <div className="mt-2 p-2.5 rounded-lg bg-[#070B14] text-xs text-emerald-300">
                    Support Response: {t.admin_response}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteNotifTarget)}
        title="Delete Notification?"
        description={
          deleteNotifTarget ? `Permanently delete notification "${deleteNotifTarget.title}"?` : undefined
        }
        confirmLabel="Delete Notification"
        variant="danger"
        busy={busy}
        onConfirm={handleConfirmDeleteNotif}
        onCancel={() => setDeleteNotifTarget(null)}
      />

      <ConfirmDialog
        open={confirmClearReadNotifs}
        title="Clear Read Personal Alerts?"
        description="Removes all read notifications addressed to your account."
        consequences={[
          'Global marketplace announcements will remain visible.',
          'This action cannot be undone.',
        ]}
        confirmLabel="Clear Read Alerts"
        variant="danger"
        busy={busy}
        onConfirm={handleConfirmClearReadNotifs}
        onCancel={() => setConfirmClearReadNotifs(false)}
      />

      <ConfirmDialog
        open={Boolean(cancelTicketTarget)}
        title="Cancel Support Ticket?"
        description={
          cancelTicketTarget
            ? `Cancel and delete your open support ticket "${cancelTicketTarget.subject}"?`
            : undefined
        }
        consequences={[
          'Support staff will no longer see or reply to this open request.',
          'Once a ticket is in progress or resolved, it cannot be cancelled.',
        ]}
        confirmLabel="Cancel Ticket"
        variant="danger"
        busy={busy}
        onConfirm={handleConfirmCancelTicket}
        onCancel={() => setCancelTicketTarget(null)}
      />
    </div>
  );
}

