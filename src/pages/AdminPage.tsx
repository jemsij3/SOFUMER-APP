import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Lock, ShieldCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch, getAdminToken, setAdminToken } from '../lib/api';

type AdminTab =
  | 'overview'
  | 'users'
  | 'sellers'
  | 'shops'
  | 'products'
  | 'categories'
  | 'orders'
  | 'reports'
  | 'reviews'
  | 'promotions'
  | 'subscriptions'
  | 'revenue'
  | 'ai'
  | 'support'
  | 'countries'
  | 'notifications'
  | 'analytics'
  | 'settings'
  | 'roles'
  | 'audit';

const ADMIN_TABS: Array<{ key: AdminTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'users', label: 'Users' },
  { key: 'sellers', label: 'Sellers' },
  { key: 'shops', label: 'Shops' },
  { key: 'products', label: 'Products' },
  { key: 'categories', label: 'Categories' },
  { key: 'orders', label: 'Orders' },
  { key: 'reports', label: 'Messages & Reports' },
  { key: 'reviews', label: 'Reviews' },
  { key: 'promotions', label: 'Promotions' },
  { key: 'subscriptions', label: 'Subscriptions' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'ai', label: 'AI Management' },
  { key: 'support', label: 'Support' },
  { key: 'countries', label: 'Countries' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'settings', label: 'Settings' },
  { key: 'roles', label: 'Admin Roles' },
  { key: 'audit', label: 'Audit Logs' },
];

export function AdminPage() {
  const { switchTab, refreshBootstrap, notify } = useApp();

  const [adminSession, setAdminSession] = useState<{ adminIdentifier: string; role: string } | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [passcode, setPasscode] = useState('');
  const [adminName, setAdminName] = useState('Platform Owner');
  const [tab, setTab] = useState<AdminTab>('overview');

  // Module datasets
  const [overview, setOverview] = useState<Record<string, number> | null>(null);
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([]);
  const [sellers, setSellers] = useState<Array<Record<string, unknown>>>([]);
  const [products, setProducts] = useState<Array<Record<string, unknown>>>([]);
  const [categories, setCategories] = useState<Array<Record<string, unknown>>>([]);
  const [subcategories, setSubcategories] = useState<Array<Record<string, unknown>>>([]);
  const [orders, setOrders] = useState<Array<Record<string, unknown>>>([]);
  const [reports, setReports] = useState<Array<Record<string, unknown>>>([]);
  const [flaggedConvs, setFlaggedConvs] = useState<Array<Record<string, unknown>>>([]);
  const [inspectedMsgs, setInspectedMsgs] = useState<Array<Record<string, unknown>>>([]);
  const [reviews, setReviews] = useState<Array<Record<string, unknown>>>([]);
  const [monetization, setMonetization] = useState<{
    plans: Array<Record<string, unknown>>;
    subscriptions: Array<Record<string, unknown>>;
    promotions: Array<Record<string, unknown>>;
    promotionTransactions: Array<Record<string, unknown>>;
  } | null>(null);
  const [aiData, setAiData] = useState<{
    features: Array<Record<string, unknown>>;
    usageLogs: Array<Record<string, unknown>>;
    summary: Record<string, number>;
  } | null>(null);
  const [tickets, setTickets] = useState<Array<Record<string, unknown>>>([]);
  const [countriesData, setCountriesData] = useState<{
    countries: Array<Record<string, unknown>>;
    currencies: Array<Record<string, unknown>>;
  } | null>(null);
  const [settingsData, setSettingsData] = useState<{
    settings: Array<Record<string, unknown>>;
    roles: Array<Record<string, unknown>>;
    permissions: Array<Record<string, unknown>>;
  } | null>(null);
  const [auditLogs, setAuditLogs] = useState<Array<Record<string, unknown>>>([]);

  // Forms
  const [newCatName, setNewCatName] = useState('');
  const [newSubCatName, setNewSubCatName] = useState('');
  const [newSubParent, setNewSubParent] = useState('');
  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastBody, setBroadcastBody] = useState('');

  useEffect(() => {
    if (!getAdminToken()) {
      // Also check cookie session
      apiFetch<{ authenticated: boolean; admin: { adminIdentifier: string; role: string } }>(
        '/api/admin/auth/me',
        { isAdmin: true }
      )
        .then((res) => setAdminSession(res.admin))
        .catch(() => setAdminSession(null))
        .finally(() => setCheckingAuth(false));
      return;
    }
    apiFetch<{ authenticated: boolean; admin: { adminIdentifier: string; role: string } }>(
      '/api/admin/auth/me',
      { isAdmin: true }
    )
      .then((res) => setAdminSession(res.admin))
      .catch(() => {
        setAdminToken(null);
        setAdminSession(null);
      })
      .finally(() => setCheckingAuth(false));
  }, []);

  const loadTabData = useCallback(async (activeTab: AdminTab) => {
    try {
      if (activeTab === 'overview' || activeTab === 'analytics') {
        const res = await apiFetch<{ overview: Record<string, number> }>('/api/admin/overview', { isAdmin: true });
        setOverview(res.overview);
      }
      if (activeTab === 'users') {
        const res = await apiFetch<{ users: Array<Record<string, unknown>> }>('/api/admin/users', { isAdmin: true });
        setUsers(res.users);
      }
      if (activeTab === 'sellers' || activeTab === 'shops') {
        const res = await apiFetch<{ sellers: Array<Record<string, unknown>> }>('/api/admin/sellers', { isAdmin: true });
        setSellers(res.sellers);
      }
      if (activeTab === 'products') {
        const res = await apiFetch<{ products: Array<Record<string, unknown>> }>('/api/admin/products', { isAdmin: true });
        setProducts(res.products);
      }
      if (activeTab === 'categories') {
        const res = await apiFetch<{ categories: Array<Record<string, unknown>>; subcategories: Array<Record<string, unknown>> }>('/api/admin/categories', { isAdmin: true });
        setCategories(res.categories);
        setSubcategories(res.subcategories);
        if (!newSubParent && res.categories[0]) setNewSubParent(String(res.categories[0].id));
      }
      if (activeTab === 'orders') {
        const res = await apiFetch<{ orders: Array<Record<string, unknown>> }>('/api/admin/orders', { isAdmin: true });
        setOrders(res.orders);
      }
      if (activeTab === 'reports') {
        const res = await apiFetch<{ reports: Array<Record<string, unknown>>; flaggedConversations: Array<Record<string, unknown>> }>('/api/admin/reports', { isAdmin: true });
        setReports(res.reports);
        setFlaggedConvs(res.flaggedConversations);
      }
      if (activeTab === 'reviews') {
        const res = await apiFetch<{ reviews: Array<Record<string, unknown>> }>('/api/admin/reviews', { isAdmin: true });
        setReviews(res.reviews);
      }
      if (['promotions', 'subscriptions', 'revenue'].includes(activeTab)) {
        const res = await apiFetch<NonNullable<typeof monetization>>('/api/admin/monetization', { isAdmin: true });
        setMonetization(res);
      }
      if (activeTab === 'ai') {
        const res = await apiFetch<NonNullable<typeof aiData>>('/api/admin/ai', { isAdmin: true });
        setAiData(res);
      }
      if (activeTab === 'support') {
        const res = await apiFetch<{ tickets: Array<Record<string, unknown>> }>('/api/admin/support', { isAdmin: true });
        setTickets(res.tickets);
      }
      if (activeTab === 'countries') {
        const res = await apiFetch<NonNullable<typeof countriesData>>('/api/admin/countries', { isAdmin: true });
        setCountriesData(res);
      }
      if (activeTab === 'settings' || activeTab === 'roles') {
        const res = await apiFetch<NonNullable<typeof settingsData>>('/api/admin/settings', { isAdmin: true });
        setSettingsData(res);
      }
      if (activeTab === 'audit') {
        const res = await apiFetch<{ logs: Array<Record<string, unknown>> }>('/api/admin/audit-logs', { isAdmin: true });
        setAuditLogs(res.logs);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Admin load failed', 'error');
    }
  }, [newSubParent, notify]);

  useEffect(() => {
    if (adminSession) {
      loadTabData(tab);
    }
  }, [adminSession, tab, loadTabData]);

  async function handleAdminLogin(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ token: string; adminIdentifier: string; role: string }>(
        '/api/admin/auth/login',
        {
          method: 'POST',
          body: JSON.stringify({ passcode, adminName }),
        }
      );
      setAdminToken(res.token);
      setAdminSession({ adminIdentifier: res.adminIdentifier, role: res.role });
      setPasscode('');
      notify('Admin portal authenticated', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Invalid administrator credentials', 'error');
    }
  }

  async function handleAdminLogout() {
    try {
      await apiFetch('/api/admin/auth/logout', { method: 'POST', isAdmin: true });
    } catch {
      // Ignore
    }
    setAdminToken(null);
    setAdminSession(null);
  }

  if (checkingAuth) {
    return <div className="p-8 text-sm text-slate-400">Verifying administrative session...</div>;
  }

  if (!adminSession) {
    return (
      <div className="max-w-md mx-auto py-10 space-y-5">
        <button type="button" onClick={() => switchTab('home')} className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white">
          <ArrowLeft className="w-4 h-4" />
          <span>Return to Marketplace</span>
        </button>

        <form onSubmit={handleAdminLogin} className="p-6 sm:p-7 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-950/60 border border-purple-700/50 flex items-center justify-center">
              <Lock className="w-5 h-5 text-purple-300" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white">SOFUMER Admin Portal</h1>
              <p className="text-xs text-slate-400">Isolated server-authorized governance console</p>
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1">Administrator Identifier</label>
            <input
              type="text"
              required
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Server Bootstrap Secret / Passcode</label>
            <input
              type="password"
              required
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="Enter ADMIN_BOOTSTRAP_SECRET"
              className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
            />
          </div>
          <button type="submit" className="w-full h-11 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold">
            Authenticate Admin Session
          </button>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            Ordinary Telegram buyer sessions cannot access admin APIs. Set <code className="text-slate-300">ADMIN_BOOTSTRAP_SECRET</code> in production environment secrets.
          </p>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Admin Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-6 h-6 text-purple-400" />
          <div>
            <h1 className="text-lg font-bold text-white">SOFUMER Governance Console</h1>
            <p className="text-xs text-slate-400">
              Signed in as {adminSession.adminIdentifier} · Role: {adminSession.role}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => switchTab('home')} className="h-9 px-3.5 rounded-lg bg-[#0E1525] border border-slate-800 text-xs text-slate-200">
            Marketplace View
          </button>
          <button type="button" onClick={handleAdminLogout} className="h-9 px-3.5 rounded-lg bg-red-950/60 border border-red-800/50 text-xs text-red-200">
            Admin Logout
          </button>
        </div>
      </div>

      {/* Sidebar + Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <aside className="lg:col-span-3 bg-[#0E1525] border border-slate-800 rounded-2xl p-2 flex lg:flex-col gap-1 overflow-x-auto">
          {ADMIN_TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`px-3 py-2 rounded-lg text-xs font-medium text-left whitespace-nowrap shrink-0 transition-colors ${
                tab === item.key
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:bg-slate-800/50 hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </aside>

        <section className="lg:col-span-9 space-y-4">
          {(tab === 'overview' || tab === 'analytics') && overview && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {[
                { label: 'Registered Users', val: overview.total_users },
                { label: 'Sellers', val: overview.total_sellers },
                { label: 'Shops', val: overview.total_shops },
                { label: 'Total Listings', val: overview.total_products },
                { label: 'Pending Review', val: overview.pending_products },
                { label: 'Direct Orders', val: overview.total_orders },
                { label: 'Disputed Orders', val: overview.disputed_orders },
                { label: 'Open Reports', val: overview.open_reports },
                { label: 'Open Tickets', val: overview.open_tickets },
                { label: 'Subscription Rev ($)', val: overview.subscription_revenue_usd },
                { label: 'Promotion Rev ($)', val: overview.promotion_revenue_usd },
                { label: 'AI Calls Today', val: overview.ai_calls_today },
              ].map((m) => (
                <div key={m.label} className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800">
                  <div className="text-xs text-slate-400">{m.label}</div>
                  <div className="text-xl font-bold text-white font-mono-nums mt-1">{m.val}</div>
                </div>
              ))}
            </div>
          )}

          {tab === 'users' && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl overflow-hidden">
              <div className="p-4 border-b border-slate-800 text-sm font-semibold text-white">
                Users & Individual AI Access Control
              </div>
              <div className="divide-y divide-slate-800/70">
                {users.length === 0 ? (
                  <div className="p-6 text-xs text-slate-400">No marketplace users registered yet.</div>
                ) : (
                  users.map((u) => (
                    <div key={String(u.id)} className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                      <div>
                        <div className="font-semibold text-white">{String(u.display_name)}</div>
                        <div className="text-slate-400">
                          TG: {String(u.telegram_id)} · Status: {String(u.status)} · AI: {u.ai_enabled ? 'Enabled' : 'Disabled'}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={async () => {
                            await apiFetch(`/api/admin/users/${u.id}/ai-access`, {
                              method: 'PATCH',
                              isAdmin: true,
                              body: JSON.stringify({ aiEnabled: !u.ai_enabled }),
                            });
                            loadTabData('users');
                          }}
                          className={`h-8 px-3 rounded-lg border ${
                            u.ai_enabled ? 'border-purple-700 text-purple-200' : 'border-red-700 text-red-200'
                          }`}
                        >
                          {u.ai_enabled ? 'Disable AI' : 'Enable AI'}
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const nextStatus = u.status === 'active' ? 'suspended' : 'active';
                            await apiFetch(`/api/admin/users/${u.id}/status`, {
                              method: 'PATCH',
                              isAdmin: true,
                              body: JSON.stringify({ status: nextStatus }),
                            });
                            loadTabData('users');
                          }}
                          className="h-8 px-3 rounded-lg bg-[#070B14] border border-slate-700 text-slate-200"
                        >
                          {u.status === 'active' ? 'Suspend' : 'Restore'}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {(tab === 'sellers' || tab === 'shops') && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 text-sm font-semibold text-white">Sellers & Storefronts</div>
              {sellers.length === 0 ? (
                <div className="p-6 text-xs text-slate-400">No sellers registered yet.</div>
              ) : (
                sellers.map((s) => (
                  <div key={String(s.id)} className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div>
                      <div className="font-semibold text-white">{String(s.shop_name)} ({String(s.seller_type)})</div>
                      <div className="text-slate-400">
                        Owner: {String(s.display_name)} · Status: {String(s.status)} · Verification: {String(s.shop_verification_status)}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/admin/sellers/${s.id}/status`, {
                            method: 'PATCH',
                            isAdmin: true,
                            body: JSON.stringify({ verificationStatus: 'verified' }),
                          });
                          loadTabData('sellers');
                        }}
                        className="h-8 px-3 rounded-lg bg-blue-600 text-white"
                      >
                        Verify Shop
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/admin/sellers/${s.id}/status`, {
                            method: 'PATCH',
                            isAdmin: true,
                            body: JSON.stringify({ isFeatured: !s.is_featured }),
                          });
                          loadTabData('sellers');
                        }}
                        className="h-8 px-3 rounded-lg bg-[#070B14] border border-slate-700 text-slate-200"
                      >
                        {s.is_featured ? 'Unfeature' : 'Feature Shop'}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/admin/sellers/${s.id}/status`, {
                            method: 'PATCH',
                            isAdmin: true,
                            body: JSON.stringify({ status: s.status === 'active' ? 'suspended' : 'active' }),
                          });
                          loadTabData('sellers');
                        }}
                        className="h-8 px-3 rounded-lg bg-red-950/60 border border-red-800/50 text-red-200"
                      >
                        {s.status === 'active' ? 'Suspend' : 'Restore'}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'products' && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 text-sm font-semibold text-white">Product Moderation</div>
              {products.length === 0 ? (
                <div className="p-6 text-xs text-slate-400">No products submitted yet.</div>
              ) : (
                products.map((p) => (
                  <div key={String(p.id)} className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div>
                      <div className="font-semibold text-white">{String(p.title)}</div>
                      <div className="text-slate-400 font-mono-nums">
                        {String(p.shop_name)} · {String(p.currency)} {String(p.price)} · Status: {String(p.status)}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/admin/products/${p.id}/moderate`, {
                            method: 'PATCH',
                            isAdmin: true,
                            body: JSON.stringify({ status: 'published' }),
                          });
                          loadTabData('products');
                        }}
                        className="h-8 px-3 rounded-lg bg-emerald-600 text-white"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/admin/products/${p.id}/moderate`, {
                            method: 'PATCH',
                            isAdmin: true,
                            body: JSON.stringify({ isFeatured: !p.is_featured }),
                          });
                          loadTabData('products');
                        }}
                        className="h-8 px-3 rounded-lg bg-[#070B14] border border-slate-700 text-slate-200"
                      >
                        {p.is_featured ? 'Unfeature' : 'Feature'}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/admin/products/${p.id}/moderate`, {
                            method: 'PATCH',
                            isAdmin: true,
                            body: JSON.stringify({ status: 'rejected', notes: 'Policy violation' }),
                          });
                          loadTabData('products');
                        }}
                        className="h-8 px-3 rounded-lg bg-red-600 text-white"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'categories' && (
            <div className="space-y-4">
              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await apiFetch('/api/admin/categories', { method: 'POST', isAdmin: true, body: JSON.stringify({ name: newCatName }) });
                    setNewCatName('');
                    await loadTabData('categories');
                    await refreshBootstrap();
                  }}
                  className="space-y-2"
                >
                  <div className="text-xs font-semibold text-white">Add Category</div>
                  <div className="flex gap-2">
                    <input type="text" required value={newCatName} onChange={(e) => setNewCatName(e.target.value)} placeholder="Category name" className="flex-1 h-10 px-3 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white" />
                    <button type="submit" className="h-10 px-4 rounded-lg bg-blue-600 text-white text-xs font-semibold">Add</button>
                  </div>
                </form>

                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    await apiFetch('/api/admin/subcategories', { method: 'POST', isAdmin: true, body: JSON.stringify({ categoryId: newSubParent, name: newSubCatName }) });
                    setNewSubCatName('');
                    await loadTabData('categories');
                    await refreshBootstrap();
                  }}
                  className="space-y-2"
                >
                  <div className="text-xs font-semibold text-white">Add Subcategory</div>
                  <div className="flex gap-2">
                    <select value={newSubParent} onChange={(e) => setNewSubParent(e.target.value)} className="h-10 px-2 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white">
                      {categories.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.name)}</option>)}
                    </select>
                    <input type="text" required value={newSubCatName} onChange={(e) => setNewSubCatName(e.target.value)} placeholder="Subcategory" className="flex-1 h-10 px-3 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white" />
                    <button type="submit" className="h-10 px-4 rounded-lg bg-blue-600 text-white text-xs font-semibold">Add</button>
                  </div>
                </form>
              </div>
              <div className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800 text-xs space-y-2">
                {categories.map((c) => (
                  <div key={String(c.id)} className="flex justify-between py-1.5 border-b border-slate-800/60">
                    <span className="font-semibold text-white">{String(c.name)}</span>
                    <span className="text-slate-400">
                      {subcategories.filter((s) => s.category_id === c.id).map((s) => String(s.name)).join(', ') || 'No subcategories'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'orders' && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 text-sm font-semibold text-white">Direct Transaction Orders</div>
              {orders.length === 0 ? (
                <div className="p-6 text-xs text-slate-400">No orders recorded yet.</div>
              ) : (
                orders.map((o) => (
                  <div key={String(o.id)} className="p-4 flex justify-between text-xs">
                    <div>
                      <div className="font-semibold text-white font-mono-nums">{String(o.order_number)}</div>
                      <div className="text-slate-400">Buyer: {String(o.buyer_name)} · Shop: {String(o.shop_name)}</div>
                    </div>
                    <div className="text-right font-mono-nums">
                      <div className="text-white">{String(o.currency)} {String(o.agreed_total)}</div>
                      <div className="text-blue-400">{String(o.status)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'reports' && (
            <div className="space-y-4">
              <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
                <div className="p-4 text-sm font-semibold text-white">Abuse Reports & Flagged Conversations</div>
                {reports.map((r) => (
                  <div key={String(r.id)} className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div>
                      <div className="font-semibold text-white">{String(r.target_type)} · {String(r.reason)}</div>
                      <div className="text-slate-400">Reporter: {String(r.reporter_name)} · Status: {String(r.status)}</div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await apiFetch(`/api/admin/reports/${r.id}`, {
                          method: 'PATCH',
                          isAdmin: true,
                          body: JSON.stringify({ status: 'resolved', resolutionNotes: 'Reviewed by moderation' }),
                        });
                        loadTabData('reports');
                      }}
                      className="h-8 px-3 rounded-lg bg-blue-600 text-white"
                    >
                      Mark Resolved
                    </button>
                  </div>
                ))}
                {flaggedConvs.map((c) => (
                  <div key={String(c.id)} className="p-4 flex items-center justify-between text-xs">
                    <div className="text-amber-300">Flagged Conversation: {String(c.subject)} ({String(c.message_count)} messages)</div>
                    <button
                      type="button"
                      onClick={async () => {
                        const res = await apiFetch<{ messages: Array<Record<string, unknown>> }>(`/api/admin/conversations/${c.id}/messages`, { isAdmin: true });
                        setInspectedMsgs(res.messages);
                      }}
                      className="h-8 px-3 rounded-lg bg-[#070B14] border border-slate-700 text-slate-200"
                    >
                      Inspect Thread
                    </button>
                  </div>
                ))}
              </div>
              {inspectedMsgs.length > 0 && (
                <div className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2 text-xs">
                  <div className="font-semibold text-white">Conversation Investigation Transcript</div>
                  {inspectedMsgs.map((m) => (
                    <div key={String(m.id)} className="p-2 rounded bg-[#070B14] text-slate-300">
                      <strong>{String(m.sender_name)}:</strong> {String(m.body)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'reviews' && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 text-sm font-semibold text-white">Verified Reviews Moderation</div>
              {reviews.map((r) => (
                <div key={String(r.id)} className="p-4 flex justify-between items-center text-xs">
                  <div>
                    <div className="font-semibold text-white">{String(r.product_title)} · {String(r.rating)}/5</div>
                    <div className="text-slate-400">{String(r.comment)}</div>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      await apiFetch(`/api/admin/reviews/${r.id}`, {
                        method: 'PATCH',
                        isAdmin: true,
                        body: JSON.stringify({ status: r.status === 'published' ? 'hidden' : 'published' }),
                      });
                      loadTabData('reviews');
                    }}
                    className="h-8 px-3 rounded-lg bg-[#070B14] border border-slate-700 text-slate-200"
                  >
                    {r.status === 'published' ? 'Hide' : 'Publish'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {(tab === 'subscriptions' || tab === 'promotions' || tab === 'revenue') && monetization && (
            <div className="space-y-4">
              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3">
                <div className="text-sm font-semibold text-white">Configurable Seller Subscription Plans</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {monetization.plans.map((pl) => (
                    <div key={String(pl.id)} className="p-4 rounded-xl bg-[#070B14] border border-slate-800 space-y-2 text-xs">
                      <div className="font-bold text-white">{String(pl.code)} — {String(pl.name)}</div>
                      <div className="text-slate-400 font-mono-nums">
                        ${String(pl.monthly_price)}/mo · Max Listings: {String(pl.max_products)} · AI/day: {String(pl.ai_daily_limit)}
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/admin/plans/${pl.id}`, {
                            method: 'PATCH',
                            isAdmin: true,
                            body: JSON.stringify({
                              monthlyPrice: Number(pl.monthly_price) + 5,
                              annualPrice: Number(pl.annual_price),
                              maxProducts: Number(pl.max_products),
                              aiDailyLimit: Number(pl.ai_daily_limit),
                            }),
                          });
                          loadTabData('subscriptions');
                        }}
                        className="h-8 px-3 rounded-lg bg-slate-800 text-slate-200"
                      >
                        +$5 Monthly Test Adjust
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2 text-xs">
                <div className="text-sm font-semibold text-white">Promotions & Revenue Ledger</div>
                {monetization.promotions.map((pr) => (
                  <div key={String(pr.id)} className="flex items-center justify-between py-2 border-b border-slate-800/70">
                    <div>
                      <span className="font-semibold text-white">{String(pr.title)}</span>
                      <span className="text-slate-400 ml-2">({String(pr.shop_name)} · ${String(pr.price_amount)} · {String(pr.status)})</span>
                    </div>
                    {pr.status === 'pending' && (
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/admin/promotions/${pr.id}`, {
                            method: 'PATCH',
                            isAdmin: true,
                            body: JSON.stringify({ status: 'active' }),
                          });
                          loadTabData('promotions');
                        }}
                        className="h-8 px-3 rounded-lg bg-emerald-600 text-white"
                      >
                        Activate & Record Revenue
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'ai' && aiData && (
            <div className="space-y-4">
              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-white">AI Governance & Feature Controls</div>
                  <div className="text-xs text-slate-400 font-mono-nums">
                    Calls: {aiData.summary.total_calls} · Denied: {aiData.summary.denied_calls} · Errors: {aiData.summary.error_calls}
                  </div>
                </div>
                <div className="divide-y divide-slate-800/70">
                  {aiData.features.map((f) => (
                    <div key={String(f.id)} className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                      <div>
                        <div className="font-semibold text-white">{String(f.label)}</div>
                        <div className="text-slate-400">
                          Key: {String(f.feature_key)} · Model: {String(f.model_name)} · Limit/day: {String(f.daily_limit_per_user)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/admin/ai/features/${f.feature_key}`, {
                            method: 'PATCH',
                            isAdmin: true,
                            body: JSON.stringify({
                              isEnabled: !f.is_enabled,
                              modelName: f.model_name,
                              dailyLimitPerUser: f.daily_limit_per_user,
                            }),
                          });
                          loadTabData('ai');
                        }}
                        className={`h-8 px-3.5 rounded-lg font-semibold ${
                          f.is_enabled ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
                        }`}
                      >
                        {f.is_enabled ? 'ON (Click to Disable)' : 'OFF (Click to Enable)'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2 text-xs">
                <div className="text-sm font-semibold text-white">Recent AI Usage & Error Logs</div>
                {aiData.usageLogs.slice(0, 15).map((l) => (
                  <div key={String(l.id)} className="flex justify-between py-1.5 border-b border-slate-800/60">
                    <span className="text-slate-200 truncate max-w-[60%]">
                      {String(l.feature_key)} · {String(l.prompt_summary)}
                    </span>
                    <span className="font-mono-nums text-slate-400">
                      {String(l.status)} ({String(l.latency_ms)}ms)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'support' && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 text-sm font-semibold text-white">Support Tickets</div>
              {tickets.map((t) => (
                <div key={String(t.id)} className="p-4 space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="font-semibold text-white">{String(t.subject)} — {String(t.display_name)}</span>
                    <span className="text-blue-400 uppercase">{String(t.status)}</span>
                  </div>
                  <p className="text-slate-300">{String(t.message)}</p>
                  {t.status !== 'resolved' && (
                    <button
                      type="button"
                      onClick={async () => {
                        await apiFetch(`/api/admin/support/${t.id}`, {
                          method: 'PATCH',
                          isAdmin: true,
                          body: JSON.stringify({ status: 'resolved', adminResponse: 'Reviewed and resolved by SOFUMER Operations.' }),
                        });
                        loadTabData('support');
                      }}
                      className="h-8 px-3 rounded-lg bg-blue-600 text-white"
                    >
                      Resolve Ticket
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'countries' && countriesData && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 text-sm font-semibold text-white">Global Countries & Currency Availability</div>
              {countriesData.countries.map((co) => (
                <div key={String(co.code)} className="p-3.5 flex items-center justify-between text-xs">
                  <div>
                    <span className="font-semibold text-white">{String(co.name)} ({String(co.code)})</span>
                    <span className="text-slate-400 ml-2">· {String(co.default_currency)} · {String(co.region)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      await apiFetch(`/api/admin/countries/${co.code}`, {
                        method: 'PATCH',
                        isAdmin: true,
                        body: JSON.stringify({ isEnabled: !co.is_enabled, shippingNotes: co.shipping_notes }),
                      });
                      loadTabData('countries');
                      refreshBootstrap();
                    }}
                    className={`h-8 px-3 rounded-lg ${co.is_enabled ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                  >
                    {co.is_enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {tab === 'notifications' && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await apiFetch('/api/admin/notifications/broadcast', {
                  method: 'POST',
                  isAdmin: true,
                  body: JSON.stringify({ title: broadcastTitle, body: broadcastBody }),
                });
                setBroadcastTitle('');
                setBroadcastBody('');
                notify('Global marketplace announcement broadcasted', 'success');
                refreshBootstrap();
              }}
              className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3"
            >
              <div className="text-sm font-semibold text-white">Broadcast Marketplace Announcement</div>
              <input type="text" required value={broadcastTitle} onChange={(e) => setBroadcastTitle(e.target.value)} placeholder="Announcement title" className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
              <textarea rows={3} required value={broadcastBody} onChange={(e) => setBroadcastBody(e.target.value)} placeholder="Announcement message..." className="w-full p-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
              <button type="submit" className="h-10 px-5 rounded-xl bg-blue-600 text-white text-xs font-semibold">Send Announcement</button>
            </form>
          )}

          {(tab === 'settings' || tab === 'roles') && settingsData && (
            <div className="space-y-4">
              <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
                <div className="p-4 text-sm font-semibold text-white">Platform Settings</div>
                {settingsData.settings.map((st) => (
                  <div key={String(st.key)} className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div>
                      <div className="font-semibold text-white">{String(st.key)}</div>
                      <div className="text-slate-400">{String(st.description)}</div>
                    </div>
                    {st.value_type === 'boolean' ? (
                      <button
                        type="button"
                        onClick={async () => {
                          const nextVal = st.value === 'true' ? 'false' : 'true';
                          await apiFetch(`/api/admin/settings/${st.key}`, {
                            method: 'PATCH',
                            isAdmin: true,
                            body: JSON.stringify({ value: nextVal }),
                          });
                          loadTabData('settings');
                          refreshBootstrap();
                        }}
                        className={`h-8 px-3 rounded-lg font-semibold ${st.value === 'true' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                      >
                        {st.value === 'true' ? 'Enabled' : 'Disabled'}
                      </button>
                    ) : (
                      <span className="font-mono-nums text-slate-200">{String(st.value) || '—'}</span>
                    )}
                  </div>
                ))}
              </div>
              <div className="bg-[#0E1525] border border-slate-800 rounded-2xl p-4 space-y-2 text-xs">
                <div className="text-sm font-semibold text-white">Administrative RBAC Roles</div>
                {settingsData.roles.map((r) => (
                  <div key={String(r.id)} className="py-2 border-b border-slate-800/60">
                    <span className="font-semibold text-white">{String(r.code)} — {String(r.name)}</span>
                    <span className="text-slate-400 ml-2">{String(r.description)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'audit' && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 text-sm font-semibold text-white">Immutable Admin Audit Logs</div>
              {auditLogs.map((log) => (
                <div key={String(log.id)} className="p-3.5 flex flex-wrap justify-between gap-2 text-xs">
                  <div>
                    <span className="font-semibold text-white">{String(log.action)}</span>
                    <span className="text-slate-400 ml-2">by {String(log.admin_identifier)} ({String(log.target_type)}:{String(log.target_id)})</span>
                  </div>
                  <span className="text-slate-500 font-mono-nums">
                    {new Date(String(log.created_at) + 'Z').toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
