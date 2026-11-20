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
  Shield,
  Store,
  User as UserIcon,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import type { Product } from '../types';
import { ProductCard } from '../components/ProductCard';

export function AccountPage() {
  const {
    user,
    sellerProfile,
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
                <span>{sellerProfile ? 'Seller Center' : 'Sell on SOFUMER'}</span>
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
          { icon: Shield, label: 'Admin Portal (Authorized Personnel)', sub: 'Independent marketplace governance dashboard', action: () => navigate({ type: 'admin' }) },
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
  const { user, goBack, requireUserOrPrompt } = useApp();
  const [items, setItems] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    const url = mode === 'wishlist' ? '/api/marketplace/favorites' : '/api/marketplace/recently-viewed';
    apiFetch<{ items: Product[] }>(url)
      .then((res) => setItems(res.items || []))
      .finally(() => setLoading(false));
  }, [user, mode]);

  return (
    <div className="space-y-5 pb-12">
      <div className="flex items-center justify-between">
        <button type="button" onClick={goBack} className="text-sm text-slate-300 hover:text-white min-h-[44px]">
          ← Back
        </button>
        <h1 className="text-lg font-bold text-white">
          {mode === 'wishlist' ? 'My Wishlist' : 'Recently Viewed'}
        </h1>
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
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}
    </div>
  );
}

export function NotificationsSupportPoliciesPage({ mode }: { mode: 'notifications' | 'support' | 'policies' }) {
  const { user, goBack, refreshSession, requireUserOrPrompt, notify } = useApp();
  const [notifs, setNotifs] = useState<Array<{ id: string; title: string; body: string; created_at: string; is_read: number }>>([]);
  const [tickets, setTickets] = useState<Array<{ id: string; subject: string; message: string; status: string; admin_response: string }>>([]);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');

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
          <h1 className="text-lg font-bold text-white">Notifications</h1>
          {notifs.length === 0 ? (
            <div className="p-6 rounded-2xl bg-[#0E1525] border border-slate-800 text-sm text-slate-400">No notifications yet.</div>
          ) : (
            notifs.map((n) => (
              <div key={n.id} className="p-4 rounded-xl bg-[#0E1525] border border-slate-800">
                <div className="text-sm font-semibold text-white">{n.title}</div>
                <p className="text-xs text-slate-300 mt-1">{n.body}</p>
                <div className="text-[11px] text-slate-500 mt-1.5 font-mono-nums">{new Date(n.created_at + 'Z').toLocaleString()}</div>
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
              <div key={t.id} className="p-4 rounded-xl bg-[#0E1525] border border-slate-800 space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="font-semibold text-white">{t.subject}</span>
                  <span className="text-blue-400 uppercase">{t.status}</span>
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
    </div>
  );
}
