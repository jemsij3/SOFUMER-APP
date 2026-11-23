import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Bot, Lock, ShieldCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';

type AdminTab =
  | 'overview'
  | 'analytics'
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
  | 'settings'
  | 'roles'
  | 'audit';

interface AdminSession {
  sessionId: string;
  userId: string;
  telegramId: string;
  adminIdentifier: string;
  role: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  isOwner: boolean;
}

interface PermissionCatalogItem {
  key: string;
  label: string;
  group: string;
  description: string;
  ownerOnly?: boolean;
}

interface AdminTabMeta {
  key: AdminTab;
  label: string;
  required: string[];
}

const ADMIN_TABS: AdminTabMeta[] = [
  { key: 'overview', label: 'Overview', required: ['overview.view'] },
  { key: 'analytics', label: 'Analytics', required: ['analytics.view'] },
  { key: 'users', label: 'Users', required: ['users.manage'] },
  { key: 'sellers', label: 'Sellers', required: ['sellers.manage', 'sellers.suspend'] },
  { key: 'shops', label: 'Shops', required: ['shops.manage', 'sellers.manage'] },
  { key: 'products', label: 'Products', required: ['moderation.manage', 'catalog.manage'] },
  { key: 'categories', label: 'Categories', required: ['catalog.manage', 'moderation.manage'] },
  { key: 'orders', label: 'Orders', required: ['orders.manage'] },
  { key: 'reports', label: 'Messages & Reports', required: ['reports.manage', 'messages.moderate'] },
  { key: 'reviews', label: 'Reviews', required: ['reviews.manage'] },
  { key: 'promotions', label: 'Promotions', required: ['monetization.manage'] },
  { key: 'subscriptions', label: 'Subscriptions', required: ['monetization.manage'] },
  { key: 'revenue', label: 'Revenue', required: ['monetization.manage'] },
  { key: 'ai', label: 'AI Management', required: ['ai.manage'] },
  { key: 'support', label: 'Support', required: ['support.manage'] },
  { key: 'countries', label: 'Countries', required: ['countries.manage'] },
  { key: 'notifications', label: 'Notifications', required: ['notifications.manage'] },
  { key: 'settings', label: 'Settings', required: ['settings.manage'] },
  { key: 'roles', label: 'Admin Roles', required: ['rbac.manage'] },
  { key: 'audit', label: 'Audit Logs', required: ['audit.view'] },
];

interface SettingUiMeta {
  label: string;
  group: string;
  description: string;
  kind: 'boolean' | 'number' | 'integer' | 'csv' | 'textarea';
  min?: number;
  max?: number;
  step?: string;
  unit?: string;
}

const SETTING_METADATA: Record<string, SettingUiMeta> = {
  seller_registration_enabled: {
    label: 'Seller Registration',
    group: 'Marketplace Access & Controls',
    description: 'Allow Telegram-verified buyers to register as sellers and open new storefronts.',
    kind: 'boolean',
  },
  product_submissions_enabled: {
    label: 'Product Submissions',
    group: 'Marketplace Access & Controls',
    description: 'Allow active sellers to create and submit new product or service listings.',
    kind: 'boolean',
  },
  auto_approve_products: {
    label: 'Auto-Approve Clean Listings',
    group: 'Moderation & Safety',
    description: 'Publish new listings immediately when no prohibited keywords are matched. Disable to enforce manual review.',
    kind: 'boolean',
  },
  prohibited_keywords: {
    label: 'Prohibited Listing Keywords',
    group: 'Moderation & Safety',
    description: 'Comma-separated blocked terms screened during listing creation and AI moderation scans.',
    kind: 'csv',
  },
  stars_per_usd: {
    label: 'Telegram Stars Conversion Rate',
    group: 'Promotions & Telegram Stars Pricing',
    description: 'Whole number of Telegram Stars (XTR) charged per 1 USD equivalent for Stars checkouts.',
    kind: 'integer',
    min: 1,
    max: 10000,
    step: '1',
    unit: 'XTR / USD',
  },
  featured_product_price_7d: {
    label: 'Featured Product Boost (7 Days)',
    group: 'Promotions & Telegram Stars Pricing',
    description: 'USD base price for promoting a single listing in Featured Products for 7 days.',
    kind: 'number',
    min: 1,
    max: 10000,
    step: '0.5',
    unit: 'USD',
  },
  sponsored_placement_price_7d: {
    label: 'Sponsored Placement (7 Days)',
    group: 'Promotions & Telegram Stars Pricing',
    description: 'USD base price for top sponsored placement in search and explore results for 7 days.',
    kind: 'number',
    min: 1,
    max: 10000,
    step: '0.5',
    unit: 'USD',
  },
  banner_ad_price_7d: {
    label: 'Homepage Banner Ad (7 Days)',
    group: 'Promotions & Telegram Stars Pricing',
    description: 'USD base price for seller storefront banner placement on the marketplace homepage for 7 days.',
    kind: 'number',
    min: 1,
    max: 10000,
    step: '0.5',
    unit: 'USD',
  },
  marketplace_announcement: {
    label: 'Global Marketplace Announcement',
    group: 'Announcements',
    description: 'Optional top-bar banner displayed across buyer and seller views (leave blank to hide).',
    kind: 'textarea',
  },
  max_product_videos: {
    label: 'Max Short Videos Per Product',
    group: 'Cloudinary Media Limits',
    description: 'Maximum number of short videos (max 10s each, MP4/MOV) allowed per listing (1–5). Does not count toward the 6-photo limit.',
    kind: 'integer',
    min: 1,
    max: 5,
    step: '1',
    unit: 'videos',
  },
  max_product_image_mb: {
    label: 'Max Product Photo File Size',
    group: 'Cloudinary Media Limits',
    description: 'Maximum size per uploaded JPG, PNG, or WebP product photo in MB (1–20 MB).',
    kind: 'integer',
    min: 1,
    max: 20,
    step: '1',
    unit: 'MB',
  },
  max_product_video_mb: {
    label: 'Max Short Video File Size',
    group: 'Cloudinary Media Limits',
    description: 'Maximum size per uploaded MP4 or MOV short product video in MB (5–100 MB).',
    kind: 'integer',
    min: 5,
    max: 100,
    step: '1',
    unit: 'MB',
  },
};

interface AiScanResult {
  productId: string;
  riskLevel: 'low' | 'medium' | 'high';
  recommendedStatus: 'published' | 'pending_review' | 'rejected';
  keywordMatches: string[];
  rationale: string;
  aiEvaluated: boolean;
  model: string;
}

interface PlanDraft {
  monthlyPrice: string;
  annualPrice: string;
  starsMonthly: string;
  starsAnnual: string;
  maxProducts: string;
  aiDailyLimit: string;
  featuredSlots: string;
  promotionalDiscountPct: string;
}

interface AiFeatureDraft {
  modelName: string;
  dailyLimitPerUser: string;
}

export function AdminPage() {
  const { user, switchTab, refreshBootstrap, notify } = useApp();

  const [adminSession, setAdminSession] = useState<AdminSession | null>(null);
  const [permissionCatalog, setPermissionCatalog] = useState<PermissionCatalogItem[]>([]);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [tab, setTab] = useState<AdminTab>('overview');

  // Module datasets
  const [overview, setOverview] = useState<Record<string, number> | null>(null);
  const [analytics, setAnalytics] = useState<{
    productsByStatus: Array<{ status: string; cnt: number }>;
    productsByType: Array<{ listing_type: string; cnt: number }>;
    ordersByStatus: Array<{ status: string; cnt: number; volume_usd: number }>;
    topCategories: Array<{ id: string; name: string; product_count: number; total_views: number }>;
    aiByFeature: Array<{ feature_key: string; total_calls: number; success_calls: number; error_calls: number; avg_latency_ms: number }>;
    engagementTotals: Record<string, number> | null;
    verificationBreakdown: Array<{ verification_status: string; cnt: number }>;
  } | null>(null);

  const [users, setUsers] = useState<Array<Record<string, unknown>>>([]);
  const [userFilter, setUserFilter] = useState('');

  const [sellers, setSellers] = useState<Array<Record<string, unknown>>>([]);
  const [sellerStatusFilter, setSellerStatusFilter] = useState('all');

  const [products, setProducts] = useState<Array<Record<string, unknown>>>([]);
  const [productStatusFilter, setProductStatusFilter] = useState('all');
  const [moderationNotes, setModerationNotes] = useState<Record<string, string>>({});
  const [aiScanResults, setAiScanResults] = useState<Record<string, AiScanResult>>({});
  const [scanningProductId, setScanningProductId] = useState<string | null>(null);

  const [categories, setCategories] = useState<Array<Record<string, unknown>>>([]);
  const [subcategories, setSubcategories] = useState<Array<Record<string, unknown>>>([]);
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, string>>({});

  const [orders, setOrders] = useState<Array<Record<string, unknown>>>([]);
  const [orderStatusFilter, setOrderStatusFilter] = useState('all');

  const [reports, setReports] = useState<Array<Record<string, unknown>>>([]);
  const [reportNotes, setReportNotes] = useState<Record<string, string>>({});
  const [flaggedConvs, setFlaggedConvs] = useState<Array<Record<string, unknown>>>([]);
  const [inspectedMsgs, setInspectedMsgs] = useState<Array<Record<string, unknown>>>([]);

  const [reviews, setReviews] = useState<Array<Record<string, unknown>>>([]);

  const [monetization, setMonetization] = useState<{
    plans: Array<Record<string, unknown>>;
    subscriptions: Array<Record<string, unknown>>;
    promotions: Array<Record<string, unknown>>;
    promotionTransactions: Array<Record<string, unknown>>;
    starsPayments?: Array<Record<string, unknown>>;
  } | null>(null);
  const [planDrafts, setPlanDrafts] = useState<Record<string, PlanDraft>>({});
  const [promoStatusFilter, setPromoStatusFilter] = useState('all');

  const [aiData, setAiData] = useState<{
    features: Array<Record<string, unknown>>;
    usageLogs: Array<Record<string, unknown>>;
    summary: Record<string, number>;
    availableModels?: string[];
    defaultModel?: string;
  } | null>(null);
  const [aiDrafts, setAiDrafts] = useState<Record<string, AiFeatureDraft>>({});
  const [aiLogFilter, setAiLogFilter] = useState('all');

  const [tickets, setTickets] = useState<Array<Record<string, unknown>>>([]);
  const [ticketDrafts, setTicketDrafts] = useState<Record<string, { status: string; response: string }>>({});

  const [countriesData, setCountriesData] = useState<{
    countries: Array<Record<string, unknown>>;
    currencies: Array<Record<string, unknown>>;
  } | null>(null);
  const [countrySearch, setCountrySearch] = useState('');
  const [countryNotesDrafts, setCountryNotesDrafts] = useState<
    Record<string, { shippingNotes: string; verificationNotes: string }>
  >({});

  const [broadcastHistory, setBroadcastHistory] = useState<Array<Record<string, unknown>>>([]);
  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastBody, setBroadcastBody] = useState('');

  const [settingsData, setSettingsData] = useState<{
    settings: Array<Record<string, unknown>>;
    roles: Array<Record<string, unknown>>;
    permissions: Array<Record<string, unknown>>;
    roleAssignments?: Array<Record<string, unknown>>;
    envOwnerTelegramIds?: string[];
  } | null>(null);
  const [settingDrafts, setSettingDrafts] = useState<Record<string, string>>({});
  const [savingSettings, setSavingSettings] = useState(false);

  // RBAC tab state
  const [rbacData, setRbacData] = useState<{
    roles: Array<Record<string, unknown>>;
    permissions: Array<Record<string, unknown>>;
    roleAssignments: Array<Record<string, unknown>>;
    permissionCatalog: PermissionCatalogItem[];
    envOwnerTelegramIds: string[];
  } | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [rolePermDraft, setRolePermDraft] = useState<string[]>([]);
  const [newRoleCode, setNewRoleCode] = useState('');
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleDesc, setNewRoleDesc] = useState('');
  const [newRolePerms, setNewRolePerms] = useState<string[]>(['overview.view']);
  const [assignTgId, setAssignTgId] = useState('');
  const [assignRoleId, setAssignRoleId] = useState('role_mod');
  const [assignLabel, setAssignLabel] = useState('');

  const [auditLogs, setAuditLogs] = useState<Array<Record<string, unknown>>>([]);
  const [auditFilter, setAuditFilter] = useState('');

  // Category creation forms
  const [newCatName, setNewCatName] = useState('');
  const [newCatDesc, setNewCatDesc] = useState('');
  const [newSubCatName, setNewSubCatName] = useState('');
  const [newSubParent, setNewSubParent] = useState('');

  const hasPerm = useCallback(
    (required: string | string[]) => {
      if (!adminSession) return false;
      if (adminSession.isOwner || adminSession.permissions.includes('*')) return true;
      const list = Array.isArray(required) ? required : [required];
      return list.some((p) => adminSession.permissions.includes(p));
    },
    [adminSession]
  );

  const permittedTabs = useMemo(
    () => ADMIN_TABS.filter((item) => hasPerm(item.required)),
    [hasPerm]
  );

  useEffect(() => {
    setCheckingAuth(true);
    setAuthError(null);
    apiFetch<{
      authenticated: boolean;
      admin: AdminSession;
      permissionCatalog?: PermissionCatalogItem[];
    }>('/api/admin/auth/me')
      .then((res) => {
        setAdminSession(res.admin);
        if (res.permissionCatalog) setPermissionCatalog(res.permissionCatalog);
      })
      .catch((err) => {
        setAdminSession(null);
        setAuthError(err instanceof Error ? err.message : 'Administrator privileges required.');
      })
      .finally(() => setCheckingAuth(false));
  }, [user?.id, user?.telegram_id]);

  // Ensure initial active tab is always permitted for the signed-in admin role
  useEffect(() => {
    if (!adminSession || permittedTabs.length === 0) return;
    const isTabAllowed = permittedTabs.some((item) => item.key === tab);
    if (!isTabAllowed) {
      setTab(permittedTabs[0].key);
    }
  }, [adminSession, permittedTabs, tab]);

  const loadTabData = useCallback(
    async (activeTab: AdminTab) => {
      try {
        if (activeTab === 'overview') {
          const res = await apiFetch<{ overview: Record<string, number> }>('/api/admin/overview', { isAdmin: true });
          setOverview(res.overview);
        }
        if (activeTab === 'analytics') {
          const [anRes, ovRes] = await Promise.all([
            apiFetch<NonNullable<typeof analytics>>('/api/admin/analytics', { isAdmin: true }),
            hasPerm('overview.view')
              ? apiFetch<{ overview: Record<string, number> }>('/api/admin/overview', { isAdmin: true })
              : Promise.resolve({ overview: null }),
          ]);
          setAnalytics(anRes);
          if (ovRes.overview) setOverview(ovRes.overview);
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
          const res = await apiFetch<{
            categories: Array<Record<string, unknown>>;
            subcategories: Array<Record<string, unknown>>;
          }>('/api/admin/categories', { isAdmin: true });
          setCategories(res.categories);
          setSubcategories(res.subcategories);
          const nextCatDrafts: Record<string, string> = {};
          res.categories.forEach((c) => {
            nextCatDrafts[String(c.id)] = String(c.name || '');
          });
          setCategoryDrafts(nextCatDrafts);
          if (!newSubParent && res.categories[0]) setNewSubParent(String(res.categories[0].id));
        }
        if (activeTab === 'orders') {
          const res = await apiFetch<{ orders: Array<Record<string, unknown>> }>('/api/admin/orders', { isAdmin: true });
          setOrders(res.orders);
        }
        if (activeTab === 'reports') {
          const res = await apiFetch<{
            reports: Array<Record<string, unknown>>;
            flaggedConversations: Array<Record<string, unknown>>;
          }>('/api/admin/reports', { isAdmin: true });
          setReports(res.reports);
          setFlaggedConvs(res.flaggedConversations);
        }
        if (activeTab === 'reviews') {
          const res = await apiFetch<{ reviews: Array<Record<string, unknown>> }>('/api/admin/reviews', { isAdmin: true });
          setReviews(res.reviews);
        }
        if (activeTab === 'promotions' || activeTab === 'subscriptions' || activeTab === 'revenue') {
          const [monRes, ovRes] = await Promise.all([
            apiFetch<NonNullable<typeof monetization>>('/api/admin/monetization', { isAdmin: true }),
            activeTab === 'revenue' && hasPerm('overview.view')
              ? apiFetch<{ overview: Record<string, number> }>('/api/admin/overview', { isAdmin: true })
              : Promise.resolve({ overview: null }),
          ]);
          setMonetization(monRes);
          if (ovRes.overview) setOverview(ovRes.overview);
          const drafts: Record<string, PlanDraft> = {};
          monRes.plans.forEach((pl) => {
            drafts[String(pl.id)] = {
              monthlyPrice: String(pl.monthly_price ?? 0),
              annualPrice: String(pl.annual_price ?? 0),
              starsMonthly: String(pl.stars_monthly ?? 0),
              starsAnnual: String(pl.stars_annual ?? 0),
              maxProducts: String(pl.max_products ?? 10),
              aiDailyLimit: String(pl.ai_daily_limit ?? 15),
              featuredSlots: String(pl.featured_slots ?? 0),
              promotionalDiscountPct: String(pl.promotional_discount_pct ?? 0),
            };
          });
          setPlanDrafts(drafts);
        }
        if (activeTab === 'ai') {
          const res = await apiFetch<NonNullable<typeof aiData>>('/api/admin/ai', { isAdmin: true });
          setAiData(res);
          const drafts: Record<string, AiFeatureDraft> = {};
          res.features.forEach((f) => {
            drafts[String(f.feature_key)] = {
              modelName: String(f.model_name || res.defaultModel || '@cf/meta/llama-3.1-8b-instruct-fast'),
              dailyLimitPerUser: String(f.daily_limit_per_user ?? 30),
            };
          });
          setAiDrafts(drafts);
        }
        if (activeTab === 'support') {
          const res = await apiFetch<{ tickets: Array<Record<string, unknown>> }>('/api/admin/support', { isAdmin: true });
          setTickets(res.tickets);
          const drafts: Record<string, { status: string; response: string }> = {};
          res.tickets.forEach((t) => {
            drafts[String(t.id)] = {
              status: String(t.status || 'open'),
              response: String(t.admin_response || ''),
            };
          });
          setTicketDrafts(drafts);
        }
        if (activeTab === 'countries') {
          const res = await apiFetch<NonNullable<typeof countriesData>>('/api/admin/countries', { isAdmin: true });
          setCountriesData(res);
          const drafts: Record<string, { shippingNotes: string; verificationNotes: string }> = {};
          res.countries.forEach((co) => {
            drafts[String(co.code)] = {
              shippingNotes: String(co.shipping_notes || ''),
              verificationNotes: String(co.verification_notes || ''),
            };
          });
          setCountryNotesDrafts(drafts);
        }
        if (activeTab === 'notifications') {
          const res = await apiFetch<{ notifications: Array<Record<string, unknown>> }>('/api/admin/notifications', {
            isAdmin: true,
          });
          setBroadcastHistory(res.notifications || []);
        }
        if (activeTab === 'settings') {
          const res = await apiFetch<NonNullable<typeof settingsData>>('/api/admin/settings', { isAdmin: true });
          setSettingsData(res);
          const nextDrafts: Record<string, string> = {};
          res.settings.forEach((st) => {
            nextDrafts[String(st.key)] = String(st.value ?? '');
          });
          setSettingDrafts(nextDrafts);
        }
        if (activeTab === 'roles') {
          const res = await apiFetch<NonNullable<typeof rbacData>>('/api/admin/roles', { isAdmin: true });
          setRbacData(res);
          if (res.permissionCatalog) setPermissionCatalog(res.permissionCatalog);
          const targetId = selectedRoleId && res.roles.some((r) => String(r.id) === selectedRoleId)
            ? selectedRoleId
            : String(res.roles[0]?.id || 'role_mod');
          setSelectedRoleId(targetId);
          setRolePermDraft(
            res.permissions
              .filter((p) => String(p.role_id) === targetId)
              .map((p) => String(p.permission_key))
          );
        }
        if (activeTab === 'audit') {
          const res = await apiFetch<{ logs: Array<Record<string, unknown>> }>('/api/admin/audit-logs', { isAdmin: true });
          setAuditLogs(res.logs);
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Admin load failed', 'error');
      }
    },
    [hasPerm, newSubParent, notify, selectedRoleId]
  );

  useEffect(() => {
    if (adminSession && hasPerm(ADMIN_TABS.find((t) => t.key === tab)?.required || [])) {
      loadTabData(tab);
    }
  }, [adminSession, tab, hasPerm, loadTabData]);

  // Keep selected role permission checkboxes synced when selecting a different role
  const handleSelectRole = (roleId: string) => {
    setSelectedRoleId(roleId);
    if (rbacData) {
      setRolePermDraft(
        rbacData.permissions
          .filter((p) => String(p.role_id) === roleId)
          .map((p) => String(p.permission_key))
      );
    }
  };

  // Dirty settings calculation
  const dirtySettingKeys = useMemo(() => {
    if (!settingsData) return [];
    return settingsData.settings
      .filter((st) => String(st.value ?? '') !== String(settingDrafts[String(st.key)] ?? ''))
      .map((st) => String(st.key));
  }, [settingsData, settingDrafts]);

  const groupedSettings = useMemo(() => {
    const groups: Record<string, Array<Record<string, unknown>>> = {};
    (settingsData?.settings || []).forEach((st) => {
      const meta = SETTING_METADATA[String(st.key)];
      const grp = meta?.group || 'General Platform Settings';
      if (!groups[grp]) groups[grp] = [];
      groups[grp].push(st);
    });
    return groups;
  }, [settingsData]);

  if (checkingAuth) {
    return <div className="p-8 text-sm text-slate-400">Verifying Telegram administrator permissions...</div>;
  }

  if (!adminSession) {
    return (
      <div className="max-w-md mx-auto py-10 space-y-5">
        <button type="button" onClick={() => switchTab('home')} className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white">
          <ArrowLeft className="w-4 h-4" />
          <span>Return to Marketplace</span>
        </button>

        <div className="p-6 sm:p-7 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-950/60 border border-purple-700/50 flex items-center justify-center">
              <Lock className="w-5 h-5 text-purple-300" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white">Administrator Access Restricted</h1>
              <p className="text-xs text-slate-400">Authorized Telegram Admin IDs & Assigned RBAC Roles only</p>
            </div>
          </div>

          <p className="text-xs text-slate-300 leading-relaxed">
            {authError || 'Your Telegram account does not hold an active SOFUMER administrative role.'}
          </p>

          {user?.telegram_id && (
            <div className="p-3 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-slate-400 font-mono-nums">
              Current Telegram ID: <span className="text-slate-200">{user.telegram_id}</span>
            </div>
          )}

          <button
            type="button"
            onClick={() => switchTab('home')}
            className="w-full h-11 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold"
          >
            Return to Marketplace
          </button>
        </div>
      </div>
    );
  }

  const activeRoleObj = rbacData?.roles.find((r) => String(r.id) === selectedRoleId);
  const isOwnerRoleSelected =
    selectedRoleId === 'role_owner' || String(activeRoleObj?.code || '') === 'OWNER';

  return (
    <div className="space-y-6 pb-12">
      {/* Admin Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-6 h-6 text-purple-400" />
          <div>
            <h1 className="text-lg font-bold text-white">SOFUMER Governance Console</h1>
            <p className="text-xs text-slate-400">
              Signed in via Telegram as {adminSession.adminIdentifier} · Role: {adminSession.roleName || adminSession.role} ({adminSession.role})
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => switchTab('home')} className="h-9 px-3.5 rounded-lg bg-[#0E1525] border border-slate-800 text-xs text-slate-200 hover:border-slate-700">
            Marketplace View
          </button>
        </div>
      </div>

      {/* Sidebar + Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <aside className="lg:col-span-3 bg-[#0E1525] border border-slate-800 rounded-2xl p-2 flex lg:flex-col gap-1 overflow-x-auto">
          {permittedTabs.map((item) => (
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
          {/* OVERVIEW TAB */}
          {tab === 'overview' && overview && (
            <div className="space-y-4">
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
                  { label: 'Stars Revenue (XTR)', val: overview.stars_revenue_xtr ?? 0 },
                  { label: 'Pending Stars', val: overview.pending_stars_payments ?? 0 },
                  { label: 'Subscription Rev ($)', val: overview.subscription_revenue_usd },
                  { label: 'Promotion Rev ($)', val: overview.promotion_revenue_usd },
                  { label: 'AI Calls Today', val: overview.ai_calls_today },
                  { label: 'AI Errors Today', val: overview.ai_errors_today ?? 0 },
                ].map((m) => (
                  <div key={m.label} className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800">
                    <div className="text-xs text-slate-400">{m.label}</div>
                    <div className="text-xl font-bold text-white font-mono-nums mt-1">{m.val ?? 0}</div>
                  </div>
                ))}
              </div>
              <div className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
                <span className="text-slate-300">
                  Live database metrics computed directly from Cloudflare D1 tables.
                </span>
                <div className="flex flex-wrap gap-2">
                  {overview.pending_products > 0 && hasPerm('moderation.manage') && (
                    <button
                      type="button"
                      onClick={() => {
                        setProductStatusFilter('pending_review');
                        setTab('products');
                      }}
                      className="h-8 px-3 rounded-lg bg-amber-600/20 border border-amber-500/40 text-amber-200 font-medium"
                    >
                      Review {overview.pending_products} Pending Listing(s)
                    </button>
                  )}
                  {overview.open_reports > 0 && hasPerm('reports.manage') && (
                    <button
                      type="button"
                      onClick={() => setTab('reports')}
                      className="h-8 px-3 rounded-lg bg-red-600/20 border border-red-500/40 text-red-200 font-medium"
                    >
                      Inspect {overview.open_reports} Open Report(s)
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ANALYTICS TAB (Distinct deep database breakdowns) */}
          {tab === 'analytics' && analytics && (
            <div className="space-y-4">
              {analytics.engagementTotals && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  {[
                    { label: 'Catalog Views', val: analytics.engagementTotals.total_views },
                    { label: 'Saved Wishlists', val: analytics.engagementTotals.total_favorites },
                    { label: 'Buyer Inquiries', val: analytics.engagementTotals.total_inquiries },
                    { label: 'Conversations', val: analytics.engagementTotals.total_conversations },
                    { label: 'Published Reviews', val: analytics.engagementTotals.published_reviews },
                  ].map((item) => (
                    <div key={item.label} className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800">
                      <div className="text-xs text-slate-400">{item.label}</div>
                      <div className="text-xl font-bold text-white font-mono-nums mt-1">{item.val ?? 0}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2.5 text-xs">
                  <div className="text-sm font-semibold text-white">Listings by Moderation Status</div>
                  {analytics.productsByStatus.length === 0 ? (
                    <div className="text-slate-400">No product listings recorded yet.</div>
                  ) : (
                    analytics.productsByStatus.map((row) => (
                      <div key={row.status} className="flex justify-between py-1.5 border-b border-slate-800/60">
                        <span className="text-slate-300 capitalize">{row.status.replace('_', ' ')}</span>
                        <span className="font-mono-nums font-semibold text-white">{row.cnt}</span>
                      </div>
                    ))
                  )}
                </div>

                <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2.5 text-xs">
                  <div className="text-sm font-semibold text-white">Listings by Commerce Type</div>
                  {analytics.productsByType.length === 0 ? (
                    <div className="text-slate-400">No product listings recorded yet.</div>
                  ) : (
                    analytics.productsByType.map((row) => (
                      <div key={row.listing_type} className="flex justify-between py-1.5 border-b border-slate-800/60">
                        <span className="text-slate-300 capitalize">{row.listing_type}</span>
                        <span className="font-mono-nums font-semibold text-white">{row.cnt}</span>
                      </div>
                    ))
                  )}
                </div>

                <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2.5 text-xs">
                  <div className="text-sm font-semibold text-white">Order Volume by Status</div>
                  {analytics.ordersByStatus.length === 0 ? (
                    <div className="text-slate-400">No direct orders recorded yet.</div>
                  ) : (
                    analytics.ordersByStatus.map((row) => (
                      <div key={row.status} className="flex justify-between py-1.5 border-b border-slate-800/60">
                        <span className="text-slate-300">{row.status}</span>
                        <span className="font-mono-nums text-white">
                          {row.cnt} orders · ${Number(row.volume_usd || 0).toFixed(2)}
                        </span>
                      </div>
                    ))
                  )}
                </div>

                <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2.5 text-xs">
                  <div className="text-sm font-semibold text-white">Shop Verification Breakdown</div>
                  {analytics.verificationBreakdown.length === 0 ? (
                    <div className="text-slate-400">No shops registered yet.</div>
                  ) : (
                    analytics.verificationBreakdown.map((row) => (
                      <div key={row.verification_status} className="flex justify-between py-1.5 border-b border-slate-800/60">
                        <span className="text-slate-300 capitalize">{row.verification_status}</span>
                        <span className="font-mono-nums font-semibold text-white">{row.cnt}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2.5 text-xs">
                <div className="text-sm font-semibold text-white">Top Categories by Listings & Views</div>
                <div className="divide-y divide-slate-800/60">
                  {analytics.topCategories.map((cat) => (
                    <div key={cat.id} className="py-2 flex items-center justify-between">
                      <span className="text-slate-200 font-medium">{cat.name}</span>
                      <span className="font-mono-nums text-slate-400">
                        {cat.product_count} listings · {cat.total_views} views
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2.5 text-xs">
                <div className="text-sm font-semibold text-white">Cloudflare AI Feature Performance</div>
                {analytics.aiByFeature.length === 0 ? (
                  <div className="text-slate-400">No AI requests logged yet.</div>
                ) : (
                  <div className="divide-y divide-slate-800/60">
                    {analytics.aiByFeature.map((row) => (
                      <div key={row.feature_key} className="py-2 flex flex-wrap justify-between gap-2">
                        <span className="text-white font-medium">{row.feature_key}</span>
                        <span className="font-mono-nums text-slate-300">
                          {row.total_calls} calls · {row.success_calls} ok · {row.error_calls} errors · avg {Math.round(row.avg_latency_ms)}ms
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* USERS TAB */}
          {tab === 'users' && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl overflow-hidden">
              <div className="p-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-semibold text-white">Users & Individual AI Access Control</div>
                <input
                  type="search"
                  value={userFilter}
                  onChange={(e) => setUserFilter(e.target.value)}
                  placeholder="Search name, Telegram ID, or username..."
                  className="h-9 w-full sm:w-64 px-3 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white"
                />
              </div>
              <div className="divide-y divide-slate-800/70">
                {users
                  .filter((u) => {
                    if (!userFilter.trim()) return true;
                    const q = userFilter.trim().toLowerCase();
                    return (
                      String(u.display_name || '').toLowerCase().includes(q) ||
                      String(u.telegram_id || '').toLowerCase().includes(q) ||
                      String(u.telegram_username || '').toLowerCase().includes(q)
                    );
                  })
                  .map((u) => (
                    <div key={String(u.id)} className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                      <div>
                        <div className="font-semibold text-white">
                          {String(u.display_name)}{' '}
                          {u.telegram_username ? (
                            <span className="text-slate-400 font-normal">@{String(u.telegram_username)}</span>
                          ) : null}
                        </div>
                        <div className="text-slate-400 font-mono-nums">
                          TG: {String(u.telegram_id)} · Roles: {String(u.roles || 'buyer')} · Status: {String(u.status)} · AI: {u.ai_enabled ? 'Enabled' : 'Disabled'}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await apiFetch(`/api/admin/users/${u.id}/ai-access`, {
                                method: 'PATCH',
                                isAdmin: true,
                                body: JSON.stringify({ aiEnabled: !u.ai_enabled }),
                              });
                              await loadTabData('users');
                            } catch (err) {
                              notify(err instanceof Error ? err.message : 'Action failed', 'error');
                            }
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
                            try {
                              const nextStatus = u.status === 'active' ? 'suspended' : 'active';
                              await apiFetch(`/api/admin/users/${u.id}/status`, {
                                method: 'PATCH',
                                isAdmin: true,
                                body: JSON.stringify({ status: nextStatus }),
                              });
                              await loadTabData('users');
                            } catch (err) {
                              notify(err instanceof Error ? err.message : 'Action failed', 'error');
                            }
                          }}
                          className="h-8 px-3 rounded-lg bg-[#070B14] border border-slate-700 text-slate-200"
                        >
                          {u.status === 'active' ? 'Suspend' : 'Restore'}
                        </button>
                      </div>
                    </div>
                  ))}
                {users.length === 0 && (
                  <div className="p-6 text-xs text-slate-400">No marketplace users registered yet.</div>
                )}
              </div>
            </div>
          )}

          {/* SELLERS & SHOPS TABS */}
          {(tab === 'sellers' || tab === 'shops') && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-white">
                  {tab === 'sellers' ? 'Seller Accounts & Verification' : 'Storefronts & Shop Governance'}
                </div>
                <select
                  value={sellerStatusFilter}
                  onChange={(e) => setSellerStatusFilter(e.target.value)}
                  className="h-8 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-slate-200"
                >
                  <option value="all">All Verification States</option>
                  <option value="unverified">Unverified</option>
                  <option value="pending">Pending</option>
                  <option value="verified">Verified</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              {sellers.length === 0 ? (
                <div className="p-6 text-xs text-slate-400">No sellers registered yet.</div>
              ) : (
                sellers
                  .filter((s) =>
                    sellerStatusFilter === 'all' ? true : String(s.shop_verification_status) === sellerStatusFilter
                  )
                  .map((s) => (
                    <div key={String(s.id)} className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                      <div>
                        <div className="font-semibold text-white">
                          {String(s.shop_name)} ({String(s.seller_type)})
                          {s.is_featured ? (
                            <span className="ml-2 px-1.5 py-0.5 rounded bg-purple-900/50 text-purple-200 text-[10px]">
                              Featured
                            </span>
                          ) : null}
                        </div>
                        <div className="text-slate-400">
                          Owner: {String(s.display_name)} · Account: {String(s.status)} · Verification:{' '}
                          {String(s.shop_verification_status)} · Slug: {String(s.shop_slug)}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {hasPerm(['sellers.manage', 'shops.manage']) && (
                          <>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await apiFetch(`/api/admin/sellers/${s.id}/status`, {
                                    method: 'PATCH',
                                    isAdmin: true,
                                    body: JSON.stringify({
                                      verificationStatus:
                                        s.shop_verification_status === 'verified' ? 'unverified' : 'verified',
                                    }),
                                  });
                                  await loadTabData(tab);
                                } catch (err) {
                                  notify(err instanceof Error ? err.message : 'Action failed', 'error');
                                }
                              }}
                              className="h-8 px-3 rounded-lg bg-blue-600 text-white"
                            >
                              {s.shop_verification_status === 'verified' ? 'Revoke Verification' : 'Verify Shop'}
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await apiFetch(`/api/admin/sellers/${s.id}/status`, {
                                    method: 'PATCH',
                                    isAdmin: true,
                                    body: JSON.stringify({ isFeatured: !s.is_featured }),
                                  });
                                  await loadTabData(tab);
                                } catch (err) {
                                  notify(err instanceof Error ? err.message : 'Action failed', 'error');
                                }
                              }}
                              className="h-8 px-3 rounded-lg bg-[#070B14] border border-slate-700 text-slate-200"
                            >
                              {s.is_featured ? 'Unfeature' : 'Feature Shop'}
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await apiFetch(`/api/admin/sellers/${s.id}/status`, {
                                method: 'PATCH',
                                isAdmin: true,
                                body: JSON.stringify({ status: s.status === 'active' ? 'suspended' : 'active' }),
                              });
                              await loadTabData(tab);
                            } catch (err) {
                              notify(err instanceof Error ? err.message : 'Action failed', 'error');
                            }
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

          {/* PRODUCTS MODERATION TAB */}
          {tab === 'products' && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-white">Product Moderation & AI Policy Screening</div>
                <select
                  value={productStatusFilter}
                  onChange={(e) => setProductStatusFilter(e.target.value)}
                  className="h-8 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-slate-200"
                >
                  <option value="all">All Statuses</option>
                  <option value="pending_review">Pending Review</option>
                  <option value="published">Published</option>
                  <option value="rejected">Rejected</option>
                  <option value="archived">Archived</option>
                </select>
              </div>
              {products.length === 0 ? (
                <div className="p-6 text-xs text-slate-400">No products submitted yet.</div>
              ) : (
                products
                  .filter((p) => (productStatusFilter === 'all' ? true : String(p.status) === productStatusFilter))
                  .map((p) => {
                    const pid = String(p.id);
                    const scan = aiScanResults[pid];
                    return (
                      <div key={pid} className="p-4 space-y-3 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="font-semibold text-white">{String(p.title)}</div>
                            <div className="text-slate-400 font-mono-nums">
                              {String(p.shop_name)} · {String(p.currency)} {String(p.price)} · {String(p.listing_type)} · Status:{' '}
                              <span className="text-slate-200">{String(p.status)}</span>
                            </div>
                          </div>
                          {hasPerm('moderation.manage') && (
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={scanningProductId === pid}
                                onClick={async () => {
                                  setScanningProductId(pid);
                                  try {
                                    const res = await apiFetch<AiScanResult>(`/api/admin/moderation/products/${pid}/ai-scan`, {
                                      method: 'POST',
                                      isAdmin: true,
                                    });
                                    setAiScanResults((prev) => ({ ...prev, [pid]: res }));
                                  } catch (err) {
                                    notify(err instanceof Error ? err.message : 'AI scan failed', 'error');
                                  } finally {
                                    setScanningProductId(null);
                                  }
                                }}
                                className="h-8 px-3 rounded-lg bg-purple-950/60 border border-purple-700/60 text-purple-200 inline-flex items-center gap-1.5"
                              >
                                <Bot className="w-3.5 h-3.5" />
                                <span>{scanningProductId === pid ? 'Scanning...' : 'AI Scan'}</span>
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await apiFetch(`/api/admin/products/${pid}/moderate`, {
                                      method: 'PATCH',
                                      isAdmin: true,
                                      body: JSON.stringify({
                                        status: 'published',
                                        notes: moderationNotes[pid] || '',
                                      }),
                                    });
                                    await loadTabData('products');
                                  } catch (err) {
                                    notify(err instanceof Error ? err.message : 'Action failed', 'error');
                                  }
                                }}
                                className="h-8 px-3 rounded-lg bg-emerald-600 text-white"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await apiFetch(`/api/admin/products/${pid}/moderate`, {
                                      method: 'PATCH',
                                      isAdmin: true,
                                      body: JSON.stringify({ isFeatured: !p.is_featured }),
                                    });
                                    await loadTabData('products');
                                  } catch (err) {
                                    notify(err instanceof Error ? err.message : 'Action failed', 'error');
                                  }
                                }}
                                className="h-8 px-3 rounded-lg bg-[#070B14] border border-slate-700 text-slate-200"
                              >
                                {p.is_featured ? 'Unfeature' : 'Feature'}
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await apiFetch(`/api/admin/products/${pid}/moderate`, {
                                      method: 'PATCH',
                                      isAdmin: true,
                                      body: JSON.stringify({
                                        status: 'rejected',
                                        notes: moderationNotes[pid] || 'Policy violation',
                                      }),
                                    });
                                    await loadTabData('products');
                                  } catch (err) {
                                    notify(err instanceof Error ? err.message : 'Action failed', 'error');
                                  }
                                }}
                                className="h-8 px-3 rounded-lg bg-red-600 text-white"
                              >
                                Reject
                              </button>
                            </div>
                          )}
                        </div>

                        {hasPerm('moderation.manage') && (
                          <input
                            type="text"
                            value={moderationNotes[pid] ?? String(p.moderation_notes || '')}
                            onChange={(e) => setModerationNotes((prev) => ({ ...prev, [pid]: e.target.value }))}
                            placeholder="Optional moderation note sent to seller on approval/rejection..."
                            className="w-full h-8 px-3 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-slate-200"
                          />
                        )}

                        {scan && (
                          <div className="p-3 rounded-xl bg-[#070B14] border border-slate-800 space-y-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`px-2 py-0.5 rounded font-semibold uppercase ${
                                    scan.riskLevel === 'high'
                                      ? 'bg-red-950 text-red-300 border border-red-800/50'
                                      : scan.riskLevel === 'medium'
                                      ? 'bg-amber-950 text-amber-300 border border-amber-800/50'
                                      : 'bg-emerald-950 text-emerald-300 border border-emerald-800/50'
                                  }`}
                                >
                                  Risk: {scan.riskLevel}
                                </span>
                                <span className="text-slate-400">
                                  Suggested: <strong className="text-white">{scan.recommendedStatus}</strong> ·{' '}
                                  {scan.aiEvaluated ? scan.model : 'Deterministic keyword policy check'}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await apiFetch(`/api/admin/products/${pid}/moderate`, {
                                      method: 'PATCH',
                                      isAdmin: true,
                                      body: JSON.stringify({
                                        status: scan.recommendedStatus,
                                        notes: scan.rationale,
                                      }),
                                    });
                                    await loadTabData('products');
                                    notify(`Applied recommendation (${scan.recommendedStatus})`, 'success');
                                  } catch (err) {
                                    notify(err instanceof Error ? err.message : 'Action failed', 'error');
                                  }
                                }}
                                className="h-7 px-2.5 rounded-lg bg-blue-600 text-white"
                              >
                                Apply ({scan.recommendedStatus})
                              </button>
                            </div>
                            <p className="text-slate-300">{scan.rationale}</p>
                            {scan.keywordMatches.length > 0 && (
                              <p className="text-red-300">Matched keywords: {scan.keywordMatches.join(', ')}</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
              )}
            </div>
          )}

          {/* CATEGORIES TAB */}
          {tab === 'categories' && (
            <div className="space-y-4">
              {hasPerm('catalog.manage') && (
                <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        await apiFetch('/api/admin/categories', {
                          method: 'POST',
                          isAdmin: true,
                          body: JSON.stringify({ name: newCatName, description: newCatDesc }),
                        });
                        setNewCatName('');
                        setNewCatDesc('');
                        await loadTabData('categories');
                        await refreshBootstrap();
                        notify('Category created', 'success');
                      } catch (err) {
                        notify(err instanceof Error ? err.message : 'Action failed', 'error');
                      }
                    }}
                    className="space-y-2"
                  >
                    <div className="text-xs font-semibold text-white">Add Category</div>
                    <input
                      type="text"
                      required
                      value={newCatName}
                      onChange={(e) => setNewCatName(e.target.value)}
                      placeholder="Category name"
                      className="w-full h-10 px-3 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white"
                    />
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newCatDesc}
                        onChange={(e) => setNewCatDesc(e.target.value)}
                        placeholder="Short description (optional)"
                        className="flex-1 h-10 px-3 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white"
                      />
                      <button type="submit" className="h-10 px-4 rounded-lg bg-blue-600 text-white text-xs font-semibold">
                        Add
                      </button>
                    </div>
                  </form>

                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        await apiFetch('/api/admin/subcategories', {
                          method: 'POST',
                          isAdmin: true,
                          body: JSON.stringify({ categoryId: newSubParent, name: newSubCatName }),
                        });
                        setNewSubCatName('');
                        await loadTabData('categories');
                        await refreshBootstrap();
                        notify('Subcategory created', 'success');
                      } catch (err) {
                        notify(err instanceof Error ? err.message : 'Action failed', 'error');
                      }
                    }}
                    className="space-y-2"
                  >
                    <div className="text-xs font-semibold text-white">Add Subcategory</div>
                    <select
                      value={newSubParent}
                      onChange={(e) => setNewSubParent(e.target.value)}
                      className="w-full h-10 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white"
                    >
                      {categories.map((c) => (
                        <option key={String(c.id)} value={String(c.id)}>
                          {String(c.name)}
                        </option>
                      ))}
                    </select>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        required
                        value={newSubCatName}
                        onChange={(e) => setNewSubCatName(e.target.value)}
                        placeholder="Subcategory name"
                        className="flex-1 h-10 px-3 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white"
                      />
                      <button type="submit" className="h-10 px-4 rounded-lg bg-blue-600 text-white text-xs font-semibold">
                        Add
                      </button>
                    </div>
                  </form>
                </div>
              )}

              <div className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800 text-xs divide-y divide-slate-800/70">
                {categories.map((c) => {
                  const cid = String(c.id);
                  const catSubs = subcategories.filter((s) => s.category_id === c.id);
                  return (
                    <div key={cid} className="py-3 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                          <input
                            type="text"
                            value={categoryDrafts[cid] ?? String(c.name)}
                            onChange={(e) => setCategoryDrafts((prev) => ({ ...prev, [cid]: e.target.value }))}
                            className="h-8 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white font-semibold"
                          />
                          {hasPerm('catalog.manage') && (
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await apiFetch(`/api/admin/categories/${cid}`, {
                                    method: 'PATCH',
                                    isAdmin: true,
                                    body: JSON.stringify({ name: categoryDrafts[cid] }),
                                  });
                                  await loadTabData('categories');
                                  await refreshBootstrap();
                                  notify('Category renamed', 'success');
                                } catch (err) {
                                  notify(err instanceof Error ? err.message : 'Rename failed', 'error');
                                }
                              }}
                              className="h-8 px-2.5 rounded-lg bg-[#131C31] border border-slate-700 text-slate-200"
                            >
                              Save
                            </button>
                          )}
                        </div>
                        {hasPerm('catalog.manage') && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await apiFetch(`/api/admin/categories/${cid}`, {
                                  method: 'PATCH',
                                  isAdmin: true,
                                  body: JSON.stringify({ isActive: !c.is_active }),
                                });
                                await loadTabData('categories');
                                await refreshBootstrap();
                              } catch (err) {
                                notify(err instanceof Error ? err.message : 'Toggle failed', 'error');
                              }
                            }}
                            className={`h-8 px-3 rounded-lg ${
                              c.is_active ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'
                            }`}
                          >
                            {c.is_active ? 'Active' : 'Inactive'}
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-[11px]">
                        {catSubs.length === 0 ? (
                          <span className="text-slate-500">No subcategories</span>
                        ) : (
                          catSubs.map((s) => (
                            <button
                              key={String(s.id)}
                              type="button"
                              disabled={!hasPerm('catalog.manage')}
                              onClick={async () => {
                                try {
                                  await apiFetch(`/api/admin/subcategories/${s.id}`, {
                                    method: 'PATCH',
                                    isAdmin: true,
                                    body: JSON.stringify({ isActive: !s.is_active }),
                                  });
                                  await loadTabData('categories');
                                  await refreshBootstrap();
                                } catch (err) {
                                  notify(err instanceof Error ? err.message : 'Subcategory toggle failed', 'error');
                                }
                              }}
                              className={`px-2 py-1 rounded border ${
                                s.is_active
                                  ? 'bg-[#070B14] border-slate-700 text-slate-200'
                                  : 'bg-slate-900 border-slate-800 text-slate-500 line-through'
                              }`}
                            >
                              {String(s.name)}
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ORDERS TAB */}
          {tab === 'orders' && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-white">Direct Transaction Orders</div>
                <select
                  value={orderStatusFilter}
                  onChange={(e) => setOrderStatusFilter(e.target.value)}
                  className="h-8 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-slate-200"
                >
                  <option value="all">All Order Statuses</option>
                  <option value="Pending">Pending</option>
                  <option value="Confirmed">Confirmed</option>
                  <option value="In Progress">In Progress</option>
                  <option value="Delivered">Delivered</option>
                  <option value="Completed">Completed</option>
                  <option value="Disputed">Disputed</option>
                  <option value="Cancelled">Cancelled</option>
                </select>
              </div>
              {orders.length === 0 ? (
                <div className="p-6 text-xs text-slate-400">No orders recorded yet.</div>
              ) : (
                orders
                  .filter((o) => (orderStatusFilter === 'all' ? true : String(o.status) === orderStatusFilter))
                  .map((o) => (
                    <div key={String(o.id)} className="p-4 flex flex-wrap justify-between gap-2 text-xs">
                      <div>
                        <div className="font-semibold text-white font-mono-nums">{String(o.order_number)}</div>
                        <div className="text-slate-400">
                          Buyer: {String(o.buyer_name)} · Seller: {String(o.seller_name)} · Shop: {String(o.shop_name)}
                        </div>
                      </div>
                      <div className="text-right font-mono-nums">
                        <div className="text-white">
                          {String(o.currency)} {String(o.agreed_total)}
                        </div>
                        <div className="text-blue-400">{String(o.status)}</div>
                      </div>
                    </div>
                  ))
              )}
            </div>
          )}

          {/* REPORTS & FLAGGED CONVERSATIONS TAB */}
          {tab === 'reports' && (
            <div className="space-y-4">
              <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
                <div className="p-4 text-sm font-semibold text-white">Abuse Reports & Flagged Conversations</div>
                {reports.length === 0 && flaggedConvs.length === 0 && (
                  <div className="p-6 text-xs text-slate-400">No abuse reports or flagged conversations queued.</div>
                )}
                {reports.map((r) => {
                  const rid = String(r.id);
                  return (
                    <div key={rid} className="p-4 space-y-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="font-semibold text-white">
                            {String(r.target_type)} · {String(r.reason)}
                          </div>
                          <div className="text-slate-400">
                            Reporter: {String(r.reporter_name)} · Status: {String(r.status)}
                          </div>
                        </div>
                        {hasPerm('reports.manage') && (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await apiFetch(`/api/admin/reports/${rid}`, {
                                    method: 'PATCH',
                                    isAdmin: true,
                                    body: JSON.stringify({
                                      status: 'resolved',
                                      resolutionNotes: reportNotes[rid] || 'Reviewed and resolved by moderation',
                                    }),
                                  });
                                  await loadTabData('reports');
                                } catch (err) {
                                  notify(err instanceof Error ? err.message : 'Action failed', 'error');
                                }
                              }}
                              className="h-8 px-3 rounded-lg bg-blue-600 text-white"
                            >
                              Resolve
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await apiFetch(`/api/admin/reports/${rid}`, {
                                    method: 'PATCH',
                                    isAdmin: true,
                                    body: JSON.stringify({
                                      status: 'dismissed',
                                      resolutionNotes: reportNotes[rid] || 'Dismissed after review',
                                    }),
                                  });
                                  await loadTabData('reports');
                                } catch (err) {
                                  notify(err instanceof Error ? err.message : 'Action failed', 'error');
                                }
                              }}
                              className="h-8 px-3 rounded-lg bg-[#070B14] border border-slate-700 text-slate-200"
                            >
                              Dismiss
                            </button>
                          </div>
                        )}
                      </div>
                      {hasPerm('reports.manage') && (
                        <input
                          type="text"
                          value={reportNotes[rid] ?? String(r.resolution_notes || '')}
                          onChange={(e) => setReportNotes((prev) => ({ ...prev, [rid]: e.target.value }))}
                          placeholder="Resolution notes..."
                          className="w-full h-8 px-3 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-slate-200"
                        />
                      )}
                    </div>
                  );
                })}
                {flaggedConvs.map((c) => (
                  <div key={String(c.id)} className="p-4 flex items-center justify-between text-xs">
                    <div className="text-amber-300">
                      Flagged Conversation: {String(c.subject)} ({String(c.message_count)} messages)
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const res = await apiFetch<{ messages: Array<Record<string, unknown>> }>(
                            `/api/admin/conversations/${c.id}/messages`,
                            { isAdmin: true }
                          );
                          setInspectedMsgs(res.messages);
                        } catch (err) {
                          notify(err instanceof Error ? err.message : 'Unable to inspect thread', 'error');
                        }
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

          {/* REVIEWS TAB */}
          {tab === 'reviews' && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 text-sm font-semibold text-white">Verified Reviews Moderation</div>
              {reviews.length === 0 ? (
                <div className="p-6 text-xs text-slate-400">No reviews submitted yet.</div>
              ) : (
                reviews.map((r) => (
                  <div key={String(r.id)} className="p-4 flex flex-wrap justify-between items-center gap-3 text-xs">
                    <div>
                      <div className="font-semibold text-white">
                        {String(r.product_title)} · {String(r.rating)}/5 ({String(r.status)})
                      </div>
                      <div className="text-slate-400">
                        By {String(r.reviewer_name)} · {String(r.comment)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await apiFetch(`/api/admin/reviews/${r.id}`, {
                            method: 'PATCH',
                            isAdmin: true,
                            body: JSON.stringify({ status: r.status === 'published' ? 'hidden' : 'published' }),
                          });
                          await loadTabData('reviews');
                        } catch (err) {
                          notify(err instanceof Error ? err.message : 'Action failed', 'error');
                        }
                      }}
                      className="h-8 px-3 rounded-lg bg-[#070B14] border border-slate-700 text-slate-200"
                    >
                      {r.status === 'published' ? 'Hide' : 'Publish'}
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* SUBSCRIPTIONS TAB (Real Editable Plan + Telegram Stars Pricing & Active Subscriptions) */}
          {tab === 'subscriptions' && monetization && (
            <div className="space-y-4">
              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-4">
                <div className="text-sm font-semibold text-white">
                  Seller Subscription Plans & Telegram Stars (XTR) Pricing
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {monetization.plans.map((pl) => {
                    const pid = String(pl.id);
                    const draft = planDrafts[pid] || {
                      monthlyPrice: String(pl.monthly_price ?? 0),
                      annualPrice: String(pl.annual_price ?? 0),
                      starsMonthly: String(pl.stars_monthly ?? 0),
                      starsAnnual: String(pl.stars_annual ?? 0),
                      maxProducts: String(pl.max_products ?? 10),
                      aiDailyLimit: String(pl.ai_daily_limit ?? 15),
                      featuredSlots: String(pl.featured_slots ?? 0),
                      promotionalDiscountPct: String(pl.promotional_discount_pct ?? 0),
                    };
                    return (
                      <form
                        key={pid}
                        onSubmit={async (e) => {
                          e.preventDefault();
                          try {
                            await apiFetch(`/api/admin/plans/${pid}`, {
                              method: 'PATCH',
                              isAdmin: true,
                              body: JSON.stringify({
                                monthlyPrice: Number(draft.monthlyPrice),
                                annualPrice: Number(draft.annualPrice),
                                starsMonthly: Number(draft.starsMonthly),
                                starsAnnual: Number(draft.starsAnnual),
                                maxProducts: Number(draft.maxProducts),
                                aiDailyLimit: Number(draft.aiDailyLimit),
                                featuredSlots: Number(draft.featuredSlots),
                                promotionalDiscountPct: Number(draft.promotionalDiscountPct),
                              }),
                            });
                            await loadTabData('subscriptions');
                            await refreshBootstrap();
                            notify(`Saved ${String(pl.code)} plan pricing`, 'success');
                          } catch (err) {
                            notify(err instanceof Error ? err.message : 'Plan update failed', 'error');
                          }
                        }}
                        className="p-4 rounded-xl bg-[#070B14] border border-slate-800 space-y-2.5 text-xs"
                      >
                        <div className="font-bold text-white text-sm">
                          {String(pl.code)} — {String(pl.name)}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="space-y-1">
                            <span className="text-slate-400 block">Monthly ($)</span>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={draft.monthlyPrice}
                              onChange={(e) =>
                                setPlanDrafts((prev) => ({
                                  ...prev,
                                  [pid]: { ...draft, monthlyPrice: e.target.value },
                                }))
                              }
                              className="w-full h-8 px-2 rounded bg-[#0E1525] border border-slate-800 text-white font-mono-nums"
                            />
                          </label>
                          <label className="space-y-1">
                            <span className="text-slate-400 block">Annual ($)</span>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={draft.annualPrice}
                              onChange={(e) =>
                                setPlanDrafts((prev) => ({
                                  ...prev,
                                  [pid]: { ...draft, annualPrice: e.target.value },
                                }))
                              }
                              className="w-full h-8 px-2 rounded bg-[#0E1525] border border-slate-800 text-white font-mono-nums"
                            />
                          </label>
                          <label className="space-y-1">
                            <span className="text-slate-400 block">Stars/Mo (XTR)</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={draft.starsMonthly}
                              onChange={(e) =>
                                setPlanDrafts((prev) => ({
                                  ...prev,
                                  [pid]: { ...draft, starsMonthly: e.target.value },
                                }))
                              }
                              className="w-full h-8 px-2 rounded bg-[#0E1525] border border-slate-800 text-white font-mono-nums"
                            />
                          </label>
                          <label className="space-y-1">
                            <span className="text-slate-400 block">Stars/Yr (XTR)</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={draft.starsAnnual}
                              onChange={(e) =>
                                setPlanDrafts((prev) => ({
                                  ...prev,
                                  [pid]: { ...draft, starsAnnual: e.target.value },
                                }))
                              }
                              className="w-full h-8 px-2 rounded bg-[#0E1525] border border-slate-800 text-white font-mono-nums"
                            />
                          </label>
                          <label className="space-y-1">
                            <span className="text-slate-400 block">Max Listings</span>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={draft.maxProducts}
                              onChange={(e) =>
                                setPlanDrafts((prev) => ({
                                  ...prev,
                                  [pid]: { ...draft, maxProducts: e.target.value },
                                }))
                              }
                              className="w-full h-8 px-2 rounded bg-[#0E1525] border border-slate-800 text-white font-mono-nums"
                            />
                          </label>
                          <label className="space-y-1">
                            <span className="text-slate-400 block">AI Limit / Day</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={draft.aiDailyLimit}
                              onChange={(e) =>
                                setPlanDrafts((prev) => ({
                                  ...prev,
                                  [pid]: { ...draft, aiDailyLimit: e.target.value },
                                }))
                              }
                              className="w-full h-8 px-2 rounded bg-[#0E1525] border border-slate-800 text-white font-mono-nums"
                            />
                          </label>
                          <label className="space-y-1">
                            <span className="text-slate-400 block">Featured Slots</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={draft.featuredSlots}
                              onChange={(e) =>
                                setPlanDrafts((prev) => ({
                                  ...prev,
                                  [pid]: { ...draft, featuredSlots: e.target.value },
                                }))
                              }
                              className="w-full h-8 px-2 rounded bg-[#0E1525] border border-slate-800 text-white font-mono-nums"
                            />
                          </label>
                          <label className="space-y-1">
                            <span className="text-slate-400 block">Promo Disc (%)</span>
                            <input
                              type="number"
                              min="0"
                              max="90"
                              step="1"
                              value={draft.promotionalDiscountPct}
                              onChange={(e) =>
                                setPlanDrafts((prev) => ({
                                  ...prev,
                                  [pid]: { ...draft, promotionalDiscountPct: e.target.value },
                                }))
                              }
                              className="w-full h-8 px-2 rounded bg-[#0E1525] border border-slate-800 text-white font-mono-nums"
                            />
                          </label>
                        </div>
                        <button
                          type="submit"
                          className="w-full h-9 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold"
                        >
                          Save Plan
                        </button>
                      </form>
                    );
                  })}
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2 text-xs">
                <div className="text-sm font-semibold text-white">Seller Subscriptions</div>
                {monetization.subscriptions.length === 0 ? (
                  <div className="text-slate-400">No seller subscriptions recorded yet.</div>
                ) : (
                  monetization.subscriptions.map((subItem) => (
                    <div key={String(subItem.id)} className="flex flex-wrap justify-between py-2 border-b border-slate-800/70">
                      <div>
                        <span className="font-semibold text-white">
                          {String(subItem.seller_name)} ({String(subItem.shop_name || 'No shop')})
                        </span>
                        <span className="text-slate-400 ml-2">
                          · {String(subItem.plan_name)} ({String(subItem.plan_code)}) · {String(subItem.billing_cycle)}
                        </span>
                      </div>
                      <span className="font-mono-nums text-blue-300">
                        ${String(subItem.amount_recorded)} · {String(subItem.status)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* PROMOTIONS TAB (Distinct Promotions Moderation & Activation) */}
          {tab === 'promotions' && monetization && (
            <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-white">Seller Promotions & Sponsored Placements</div>
                <select
                  value={promoStatusFilter}
                  onChange={(e) => setPromoStatusFilter(e.target.value)}
                  className="h-8 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-slate-200"
                >
                  <option value="all">All Statuses</option>
                  <option value="pending">Pending</option>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="completed">Completed</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              {monetization.promotions.length === 0 ? (
                <div className="text-slate-400">No promotions submitted yet.</div>
              ) : (
                monetization.promotions
                  .filter((pr) => (promoStatusFilter === 'all' ? true : String(pr.status) === promoStatusFilter))
                  .map((pr) => (
                    <div key={String(pr.id)} className="flex flex-wrap items-center justify-between gap-3 py-2.5 border-b border-slate-800/70">
                      <div>
                        <span className="font-semibold text-white">{String(pr.title)}</span>
                        <span className="text-slate-400 ml-2">
                          ({String(pr.shop_name)} · {String(pr.promo_type)} · ${String(pr.price_amount)} · {String(pr.status)})
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {pr.status !== 'active' && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await apiFetch(`/api/admin/promotions/${pr.id}`, {
                                  method: 'PATCH',
                                  isAdmin: true,
                                  body: JSON.stringify({ status: 'active' }),
                                });
                                await loadTabData('promotions');
                              } catch (err) {
                                notify(err instanceof Error ? err.message : 'Promotion update failed', 'error');
                              }
                            }}
                            className="h-8 px-3 rounded-lg bg-emerald-600 text-white"
                          >
                            Activate
                          </button>
                        )}
                        {pr.status === 'active' && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await apiFetch(`/api/admin/promotions/${pr.id}`, {
                                  method: 'PATCH',
                                  isAdmin: true,
                                  body: JSON.stringify({ status: 'paused' }),
                                });
                                await loadTabData('promotions');
                              } catch (err) {
                                notify(err instanceof Error ? err.message : 'Promotion update failed', 'error');
                              }
                            }}
                            className="h-8 px-3 rounded-lg bg-amber-600 text-white"
                          >
                            Pause
                          </button>
                        )}
                        {pr.status === 'pending' && (
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await apiFetch(`/api/admin/promotions/${pr.id}`, {
                                  method: 'PATCH',
                                  isAdmin: true,
                                  body: JSON.stringify({ status: 'rejected' }),
                                });
                                await loadTabData('promotions');
                              } catch (err) {
                                notify(err instanceof Error ? err.message : 'Promotion update failed', 'error');
                              }
                            }}
                            className="h-8 px-3 rounded-lg bg-red-600 text-white"
                          >
                            Reject
                          </button>
                        )}
                      </div>
                    </div>
                  ))
              )}
            </div>
          )}

          {/* REVENUE TAB (Distinct Ledger & Totals View) */}
          {tab === 'revenue' && monetization && (
            <div className="space-y-4">
              {overview && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800">
                    <div className="text-xs text-slate-400">Stars Revenue (XTR)</div>
                    <div className="text-xl font-bold text-white font-mono-nums mt-1">{overview.stars_revenue_xtr ?? 0}</div>
                  </div>
                  <div className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800">
                    <div className="text-xs text-slate-400">Pending Stars Invoices</div>
                    <div className="text-xl font-bold text-white font-mono-nums mt-1">{overview.pending_stars_payments ?? 0}</div>
                  </div>
                  <div className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800">
                    <div className="text-xs text-slate-400">Subscription Rev (USD)</div>
                    <div className="text-xl font-bold text-white font-mono-nums mt-1">
                      ${Number(overview.subscription_revenue_usd ?? 0).toFixed(2)}
                    </div>
                  </div>
                  <div className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800">
                    <div className="text-xs text-slate-400">Promotion Rev (USD)</div>
                    <div className="text-xl font-bold text-white font-mono-nums mt-1">
                      ${Number(overview.promotion_revenue_usd ?? 0).toFixed(2)}
                    </div>
                  </div>
                </div>
              )}

              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2 text-xs">
                <div className="text-sm font-semibold text-white">Telegram Stars (XTR) Payment Ledger</div>
                {!monetization.starsPayments || monetization.starsPayments.length === 0 ? (
                  <div className="text-slate-400">No Telegram Stars transactions recorded yet.</div>
                ) : (
                  monetization.starsPayments.map((sp) => (
                    <div key={String(sp.id)} className="flex flex-wrap items-center justify-between gap-2 py-2 border-b border-slate-800/70">
                      <div>
                        <span className="font-semibold text-white">
                          {String(sp.payer_name || sp.payer_telegram_id)} · {String(sp.target_type)} ({String(sp.plan_code)})
                        </span>
                        <span className="text-slate-400 ml-2 font-mono-nums">{String(sp.stars_amount)} XTR</span>
                      </div>
                      <span className="uppercase font-mono-nums text-blue-300">{String(sp.status)}</span>
                    </div>
                  ))
                )}
              </div>

              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2 text-xs">
                <div className="text-sm font-semibold text-white">Promotion Transactions Ledger</div>
                {monetization.promotionTransactions.length === 0 ? (
                  <div className="text-slate-400">No promotion revenue transactions recorded yet.</div>
                ) : (
                  monetization.promotionTransactions.map((tx) => (
                    <div key={String(tx.id)} className="flex flex-wrap items-center justify-between gap-2 py-2 border-b border-slate-800/70">
                      <div>
                        <span className="font-semibold text-white">Promotion {String(tx.promotion_id)}</span>
                        <span className="text-slate-400 ml-2 font-mono-nums">
                          {String(tx.currency)} {String(tx.amount)} · {String(tx.status)}
                        </span>
                      </div>
                      <span className="text-slate-500 font-mono-nums">
                        {new Date(String(tx.created_at) + 'Z').toLocaleString()}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* AI MANAGEMENT TAB (Real Model Selector Dropdown + Limits + Usage Telemetry) */}
          {tab === 'ai' && aiData && (
            <div className="space-y-4">
              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-white">Cloudflare Workers AI Governance</div>
                    <div className="text-xs text-slate-400">
                      Default Model: <span className="font-mono-nums text-blue-300">{aiData.defaultModel}</span>
                    </div>
                  </div>
                  <div className="text-xs text-slate-400 font-mono-nums">
                    Calls: {aiData.summary.total_calls ?? 0} · Denied: {aiData.summary.denied_calls ?? 0} · Errors:{' '}
                    {aiData.summary.error_calls ?? 0}
                  </div>
                </div>
                <div className="divide-y divide-slate-800/70">
                  {aiData.features.map((f) => {
                    const fk = String(f.feature_key);
                    const draft = aiDrafts[fk] || {
                      modelName: String(f.model_name || aiData.defaultModel || ''),
                      dailyLimitPerUser: String(f.daily_limit_per_user ?? 30),
                    };
                    const modelOptions = Array.from(
                      new Set([...(aiData.availableModels || []), String(f.model_name || '')].filter(Boolean))
                    );
                    return (
                      <div key={String(f.id)} className="py-3.5 space-y-2.5 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="font-semibold text-white">{String(f.label)}</div>
                            <div className="text-slate-400">{String(f.description || fk)}</div>
                          </div>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await apiFetch(`/api/admin/ai/features/${fk}`, {
                                  method: 'PATCH',
                                  isAdmin: true,
                                  body: JSON.stringify({
                                    isEnabled: !f.is_enabled,
                                    modelName: draft.modelName,
                                    dailyLimitPerUser: Number(draft.dailyLimitPerUser),
                                  }),
                                });
                                await loadTabData('ai');
                              } catch (err) {
                                notify(err instanceof Error ? err.message : 'Action failed', 'error');
                              }
                            }}
                            className={`h-8 px-3.5 rounded-lg font-semibold ${
                              f.is_enabled ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
                            }`}
                          >
                            {f.is_enabled ? 'ON (Disable)' : 'OFF (Enable)'}
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={draft.modelName}
                            onChange={(e) =>
                              setAiDrafts((prev) => ({
                                ...prev,
                                [fk]: { ...draft, modelName: e.target.value },
                              }))
                            }
                            className="h-9 flex-1 min-w-[240px] px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white font-mono-nums"
                          >
                            {modelOptions.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                          <div className="flex items-center gap-1.5">
                            <span className="text-slate-400">Daily/User:</span>
                            <input
                              type="number"
                              min="0"
                              max="10000"
                              value={draft.dailyLimitPerUser}
                              onChange={(e) =>
                                setAiDrafts((prev) => ({
                                  ...prev,
                                  [fk]: { ...draft, dailyLimitPerUser: e.target.value },
                                }))
                              }
                              className="w-20 h-9 px-2 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white font-mono-nums"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await apiFetch(`/api/admin/ai/features/${fk}`, {
                                  method: 'PATCH',
                                  isAdmin: true,
                                  body: JSON.stringify({
                                    isEnabled: Boolean(f.is_enabled),
                                    modelName: draft.modelName,
                                    dailyLimitPerUser: Number(draft.dailyLimitPerUser),
                                  }),
                                });
                                await loadTabData('ai');
                                notify(`Saved AI config for ${fk}`, 'success');
                              } catch (err) {
                                notify(err instanceof Error ? err.message : 'Save failed', 'error');
                              }
                            }}
                            className="h-9 px-3 rounded-lg bg-blue-600 text-white font-semibold"
                          >
                            Save Config
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-white">Recent AI Usage & Error Logs</div>
                  <select
                    value={aiLogFilter}
                    onChange={(e) => setAiLogFilter(e.target.value)}
                    className="h-8 px-2 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-slate-200"
                  >
                    <option value="all">All Statuses</option>
                    <option value="success">Success</option>
                    <option value="denied">Denied</option>
                    <option value="error">Error</option>
                  </select>
                </div>
                {aiData.usageLogs.length === 0 ? (
                  <div className="text-slate-400">No AI usage logs recorded yet.</div>
                ) : (
                  aiData.usageLogs
                    .filter((l) => (aiLogFilter === 'all' ? true : String(l.status) === aiLogFilter))
                    .slice(0, 25)
                    .map((l) => (
                      <div key={String(l.id)} className="py-2 border-b border-slate-800/60 space-y-0.5">
                        <div className="flex justify-between gap-2">
                          <span className="text-slate-200 truncate max-w-[65%]">
                            {String(l.feature_key)} · {String(l.model_name)} · {String(l.prompt_summary)}
                          </span>
                          <span
                            className={`font-mono-nums ${
                              l.status === 'error'
                                ? 'text-red-400'
                                : l.status === 'denied'
                                ? 'text-amber-300'
                                : 'text-emerald-300'
                            }`}
                          >
                            {String(l.status)} ({String(l.latency_ms)}ms)
                          </span>
                        </div>
                        {l.error_message ? (
                          <div className="text-red-300/90 text-[11px]">{String(l.error_message)}</div>
                        ) : null}
                      </div>
                    ))
                )}
              </div>
            </div>
          )}

          {/* SUPPORT TAB (Custom Admin Response & Status Editor) */}
          {tab === 'support' && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 text-sm font-semibold text-white">Support Tickets</div>
              {tickets.length === 0 ? (
                <div className="p-6 text-xs text-slate-400">No support tickets submitted yet.</div>
              ) : (
                tickets.map((t) => {
                  const tid = String(t.id);
                  const draft = ticketDrafts[tid] || {
                    status: String(t.status || 'open'),
                    response: String(t.admin_response || ''),
                  };
                  return (
                    <div key={tid} className="p-4 space-y-2.5 text-xs">
                      <div className="flex justify-between">
                        <span className="font-semibold text-white">
                          {String(t.subject)} — {String(t.display_name)}
                        </span>
                        <span className="text-blue-400 uppercase">{String(t.status)}</span>
                      </div>
                      <p className="text-slate-300">{String(t.message)}</p>
                      <textarea
                        rows={2}
                        value={draft.response}
                        onChange={(e) =>
                          setTicketDrafts((prev) => ({
                            ...prev,
                            [tid]: { ...draft, response: e.target.value },
                          }))
                        }
                        placeholder="Write response to buyer/seller..."
                        className="w-full p-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={draft.status}
                          onChange={(e) =>
                            setTicketDrafts((prev) => ({
                              ...prev,
                              [tid]: { ...draft, status: e.target.value },
                            }))
                          }
                          className="h-8 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-slate-200"
                        >
                          <option value="open">Open</option>
                          <option value="in_progress">In Progress</option>
                          <option value="resolved">Resolved</option>
                          <option value="closed">Closed</option>
                        </select>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await apiFetch(`/api/admin/support/${tid}`, {
                                method: 'PATCH',
                                isAdmin: true,
                                body: JSON.stringify({
                                  status: draft.status,
                                  adminResponse: draft.response,
                                }),
                              });
                              await loadTabData('support');
                              notify('Ticket updated & user notified', 'success');
                            } catch (err) {
                              notify(err instanceof Error ? err.message : 'Action failed', 'error');
                            }
                          }}
                          className="h-8 px-3.5 rounded-lg bg-blue-600 text-white font-semibold"
                        >
                          Send Update
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* COUNTRIES TAB */}
          {tab === 'countries' && countriesData && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-white">Global Countries & Currency Availability</div>
                <input
                  type="search"
                  value={countrySearch}
                  onChange={(e) => setCountrySearch(e.target.value)}
                  placeholder="Filter country or currency..."
                  className="h-8 w-full sm:w-56 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white"
                />
              </div>
              {countriesData.countries
                .filter((co) => {
                  if (!countrySearch.trim()) return true;
                  const q = countrySearch.trim().toLowerCase();
                  return (
                    String(co.name || '').toLowerCase().includes(q) ||
                    String(co.code || '').toLowerCase().includes(q) ||
                    String(co.default_currency || '').toLowerCase().includes(q)
                  );
                })
                .map((co) => {
                  const code = String(co.code);
                  const draft = countryNotesDrafts[code] || {
                    shippingNotes: String(co.shipping_notes || ''),
                    verificationNotes: String(co.verification_notes || ''),
                  };
                  return (
                    <div key={code} className="p-4 space-y-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <span className="font-semibold text-white">
                            {String(co.name)} ({code})
                          </span>
                          <span className="text-slate-400 ml-2">
                            · {String(co.default_currency)} · {String(co.region)}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await apiFetch(`/api/admin/countries/${code}`, {
                                method: 'PATCH',
                                isAdmin: true,
                                body: JSON.stringify({
                                  isEnabled: !co.is_enabled,
                                  shippingNotes: draft.shippingNotes,
                                  verificationNotes: draft.verificationNotes,
                                }),
                              });
                              await loadTabData('countries');
                              await refreshBootstrap();
                            } catch (err) {
                              notify(err instanceof Error ? err.message : 'Action failed', 'error');
                            }
                          }}
                          className={`h-8 px-3 rounded-lg ${
                            co.is_enabled ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          {co.is_enabled ? 'Enabled' : 'Disabled'}
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          type="text"
                          value={draft.shippingNotes}
                          onChange={(e) =>
                            setCountryNotesDrafts((prev) => ({
                              ...prev,
                              [code]: { ...draft, shippingNotes: e.target.value },
                            }))
                          }
                          placeholder="Shipping notes..."
                          className="h-8 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-slate-200"
                        />
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={draft.verificationNotes}
                            onChange={(e) =>
                              setCountryNotesDrafts((prev) => ({
                                ...prev,
                                [code]: { ...draft, verificationNotes: e.target.value },
                              }))
                            }
                            placeholder="Verification requirements..."
                            className="flex-1 h-8 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-slate-200"
                          />
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await apiFetch(`/api/admin/countries/${code}`, {
                                  method: 'PATCH',
                                  isAdmin: true,
                                  body: JSON.stringify({
                                    isEnabled: Boolean(co.is_enabled),
                                    shippingNotes: draft.shippingNotes,
                                    verificationNotes: draft.verificationNotes,
                                  }),
                                });
                                await loadTabData('countries');
                                notify(`Saved notes for ${code}`, 'success');
                              } catch (err) {
                                notify(err instanceof Error ? err.message : 'Save failed', 'error');
                              }
                            }}
                            className="h-8 px-2.5 rounded-lg bg-[#131C31] border border-slate-700 text-slate-200"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}

          {/* NOTIFICATIONS TAB (Broadcast + Sent History) */}
          {tab === 'notifications' && (
            <div className="space-y-4">
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await apiFetch('/api/admin/notifications/broadcast', {
                      method: 'POST',
                      isAdmin: true,
                      body: JSON.stringify({ title: broadcastTitle, body: broadcastBody }),
                    });
                    setBroadcastTitle('');
                    setBroadcastBody('');
                    notify('Global marketplace announcement broadcasted', 'success');
                    await loadTabData('notifications');
                    await refreshBootstrap();
                  } catch (err) {
                    notify(err instanceof Error ? err.message : 'Broadcast failed', 'error');
                  }
                }}
                className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3"
              >
                <div className="text-sm font-semibold text-white">Broadcast Marketplace Announcement</div>
                <input
                  type="text"
                  required
                  value={broadcastTitle}
                  onChange={(e) => setBroadcastTitle(e.target.value)}
                  placeholder="Announcement title"
                  className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
                />
                <textarea
                  rows={3}
                  required
                  value={broadcastBody}
                  onChange={(e) => setBroadcastBody(e.target.value)}
                  placeholder="Announcement message..."
                  className="w-full p-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
                />
                <button type="submit" className="h-10 px-5 rounded-xl bg-blue-600 text-white text-xs font-semibold">
                  Send Announcement
                </button>
              </form>

              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2 text-xs">
                <div className="text-sm font-semibold text-white">Sent Broadcast History</div>
                {broadcastHistory.length === 0 ? (
                  <div className="text-slate-400">No global broadcasts sent yet.</div>
                ) : (
                  broadcastHistory.map((item) => (
                    <div key={String(item.id)} className="py-2.5 border-b border-slate-800/70 space-y-1">
                      <div className="flex justify-between gap-2">
                        <span className="font-semibold text-white">{String(item.title)}</span>
                        <span className="text-slate-500 font-mono-nums">
                          {new Date(String(item.created_at) + 'Z').toLocaleString()}
                        </span>
                      </div>
                      <p className="text-slate-300">{String(item.body)}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* PLATFORM SETTINGS TAB (Full Interactive Admin Settings) */}
          {tab === 'settings' && settingsData && (
            <div className="space-y-4">
              {dirtySettingKeys.length > 0 && (
                <div className="p-4 rounded-2xl bg-blue-950/40 border border-blue-700/50 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <span className="text-blue-200 font-medium">
                    {dirtySettingKeys.length} unsaved setting change(s): {dirtySettingKeys.map((k) => SETTING_METADATA[k]?.label || k).join(', ')}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const reset: Record<string, string> = {};
                        settingsData.settings.forEach((st) => {
                          reset[String(st.key)] = String(st.value ?? '');
                        });
                        setSettingDrafts(reset);
                      }}
                      className="h-8 px-3 rounded-lg bg-[#070B14] border border-slate-700 text-slate-200"
                    >
                      Reset Changes
                    </button>
                    <button
                      type="button"
                      disabled={savingSettings}
                      onClick={async () => {
                        setSavingSettings(true);
                        try {
                          await apiFetch('/api/admin/settings', {
                            method: 'PATCH',
                            isAdmin: true,
                            body: JSON.stringify({
                              updates: dirtySettingKeys.map((key) => ({
                                key,
                                value: settingDrafts[key],
                              })),
                            }),
                          });
                          await loadTabData('settings');
                          await refreshBootstrap();
                          notify('Platform settings saved', 'success');
                        } catch (err) {
                          notify(err instanceof Error ? err.message : 'Failed to save settings', 'error');
                        } finally {
                          setSavingSettings(false);
                        }
                      }}
                      className="h-8 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold"
                    >
                      {savingSettings ? 'Saving...' : 'Save Settings'}
                    </button>
                  </div>
                </div>
              )}

              {Object.entries(groupedSettings).map(([groupName, items]) => (
                <div key={groupName} className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
                  <div className="p-4 text-sm font-semibold text-white">{groupName}</div>
                  {items.map((st) => {
                    const key = String(st.key);
                    const meta = SETTING_METADATA[key];
                    const draftVal = settingDrafts[key] ?? String(st.value ?? '');
                    const label = meta?.label || key.replace(/_/g, ' ');
                    const description = meta?.description || String(st.description || '');
                    const isBool = meta?.kind === 'boolean' || st.value_type === 'boolean';
                    const isNum =
                      meta?.kind === 'number' || meta?.kind === 'integer' || st.value_type === 'number';
                    const isTextarea = meta?.kind === 'textarea' || key === 'marketplace_announcement';
                    const isCsv = meta?.kind === 'csv' || key === 'prohibited_keywords';

                    return (
                      <div key={key} className="p-4 space-y-2.5 text-xs">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="max-w-xl space-y-0.5">
                            <div className="font-semibold text-white text-sm">{label}</div>
                            <div className="text-slate-400 leading-relaxed">{description}</div>
                            {st.updated_by ? (
                              <div className="text-[11px] text-slate-500">
                                Last updated by {String(st.updated_by)}
                              </div>
                            ) : null}
                          </div>

                          {isBool ? (
                            <button
                              type="button"
                              aria-pressed={draftVal === 'true'}
                              onClick={() =>
                                setSettingDrafts((prev) => ({
                                  ...prev,
                                  [key]: draftVal === 'true' ? 'false' : 'true',
                                }))
                              }
                              className={`h-9 px-4 rounded-xl font-semibold transition-colors ${
                                draftVal === 'true'
                                  ? 'bg-emerald-600 text-white'
                                  : 'bg-slate-800 border border-slate-700 text-slate-300'
                              }`}
                            >
                              {draftVal === 'true' ? 'ON · Enabled' : 'OFF · Disabled'}
                            </button>
                          ) : isNum ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                min={meta?.min ?? 0}
                                max={meta?.max ?? 100000}
                                step={meta?.step ?? '1'}
                                value={draftVal}
                                onChange={(e) =>
                                  setSettingDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                                className="w-32 h-9 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white font-mono-nums"
                              />
                              {meta?.unit && <span className="text-slate-400 font-mono-nums">{meta.unit}</span>}
                            </div>
                          ) : null}
                        </div>

                        {isCsv && (
                          <div className="space-y-1.5">
                            <input
                              type="text"
                              value={draftVal}
                              onChange={(e) =>
                                setSettingDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              placeholder="Enter comma-separated blocked terms..."
                              className="w-full h-10 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-white"
                            />
                            <div className="text-[11px] text-slate-400">
                              {draftVal
                                .split(',')
                                .map((t) => t.trim())
                                .filter(Boolean).length}{' '}
                              active blocked keyword(s)
                            </div>
                          </div>
                        )}

                        {isTextarea && (
                          <div className="space-y-1.5">
                            <textarea
                              rows={2}
                              maxLength={500}
                              value={draftVal}
                              onChange={(e) =>
                                setSettingDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              placeholder="Optional global announcement shown in top banner (leave empty to hide)..."
                              className="w-full p-3 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-white"
                            />
                            <div className="text-[11px] text-slate-500 text-right font-mono-nums">
                              {draftVal.length}/500
                            </div>
                          </div>
                        )}

                        {!isBool && !isNum && !isCsv && !isTextarea && (
                          <input
                            type="text"
                            value={draftVal}
                            onChange={(e) =>
                              setSettingDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                            }
                            className="w-full h-9 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-white"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {/* ADMIN ROLES & PERMISSIONS TAB (Real Database-Backed RBAC) */}
          {tab === 'roles' && rbacData && (
            <div className="space-y-4">
              {/* Permanent Env Owners */}
              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2 text-xs">
                <div className="text-sm font-semibold text-white">Permanent Platform Owners (ADMIN_TELEGRAM_IDS)</div>
                <p className="text-slate-400">
                  Telegram IDs listed in Worker environment secrets always hold immutable Owner (*) authority and cannot be locked out by database changes.
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  {rbacData.envOwnerTelegramIds.length === 0 ? (
                    <span className="text-amber-300">No ADMIN_TELEGRAM_IDS configured in environment.</span>
                  ) : (
                    rbacData.envOwnerTelegramIds.map((tg) => (
                      <span
                        key={tg}
                        className="px-3 py-1 rounded-lg bg-purple-950/60 border border-purple-700/50 text-purple-200 font-mono-nums"
                      >
                        TG: {tg} · OWNER (*)
                      </span>
                    ))
                  )}
                </div>
              </div>

              {/* Roles & Permission Matrix */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-5 bg-[#0E1525] border border-slate-800 rounded-2xl p-4 space-y-2 text-xs">
                  <div className="text-sm font-semibold text-white mb-2">Administrative Roles</div>
                  {rbacData.roles.map((r) => {
                    const rid = String(r.id);
                    const permCount = rbacData.permissions.filter((p) => String(p.role_id) === rid).length;
                    const isBuiltIn = ['role_owner', 'role_mod', 'role_ops'].includes(rid);
                    return (
                      <div
                        key={rid}
                        className={`p-3 rounded-xl border transition-colors cursor-pointer ${
                          selectedRoleId === rid
                            ? 'bg-blue-950/30 border-blue-600/70'
                            : 'bg-[#070B14] border-slate-800 hover:border-slate-700'
                        }`}
                        onClick={() => handleSelectRole(rid)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-white">
                            {String(r.code)} — {String(r.name)}
                          </span>
                          <span className="text-[11px] font-mono-nums text-slate-400">
                            {rid === 'role_owner' ? 'All (*)' : `${permCount} perms`}
                          </span>
                        </div>
                        <p className="text-slate-400 mt-1">{String(r.description)}</p>
                        {!isBuiltIn && (
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                await apiFetch(`/api/admin/roles/${rid}`, { method: 'DELETE', isAdmin: true });
                                await loadTabData('roles');
                                notify('Custom role deleted', 'success');
                              } catch (err) {
                                notify(err instanceof Error ? err.message : 'Delete failed', 'error');
                              }
                            }}
                            className="mt-2 h-7 px-2.5 rounded bg-red-950/60 border border-red-800/50 text-red-200"
                          >
                            Delete Role
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="lg:col-span-7 bg-[#0E1525] border border-slate-800 rounded-2xl p-4 space-y-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-white">
                        Role Permissions: {String(activeRoleObj?.name || selectedRoleId)}
                      </div>
                      <div className="text-slate-400">
                        {isOwnerRoleSelected
                          ? 'OWNER holds immutable wildcard (*) authority across all endpoints.'
                          : 'Toggle allowed administrative modules for this role.'}
                      </div>
                    </div>
                    {!isOwnerRoleSelected && (
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await apiFetch(`/api/admin/roles/${selectedRoleId}/permissions`, {
                              method: 'PUT',
                              isAdmin: true,
                              body: JSON.stringify({ permissions: rolePermDraft }),
                            });
                            await loadTabData('roles');
                            notify('Role permissions saved', 'success');
                          } catch (err) {
                            notify(err instanceof Error ? err.message : 'Failed to save permissions', 'error');
                          }
                        }}
                        className="h-9 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold"
                      >
                        Save Permissions
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[420px] overflow-y-auto pr-1">
                    {permissionCatalog
                      .filter((item) => item.key !== '*')
                      .map((item) => {
                        const checked = isOwnerRoleSelected || rolePermDraft.includes(item.key);
                        const disabled = isOwnerRoleSelected || (item.ownerOnly && !adminSession.isOwner);
                        return (
                          <label
                            key={item.key}
                            className={`p-2.5 rounded-xl border flex items-start gap-2.5 ${
                              checked
                                ? 'bg-[#131C31] border-blue-600/40'
                                : 'bg-[#070B14] border-slate-800'
                            } ${disabled ? 'opacity-65' : 'cursor-pointer'}`}
                          >
                            <input
                              type="checkbox"
                              disabled={disabled}
                              checked={checked}
                              onChange={() => {
                                setRolePermDraft((prev) =>
                                  prev.includes(item.key)
                                    ? prev.filter((k) => k !== item.key)
                                    : [...prev, item.key]
                                );
                              }}
                              className="mt-0.5 accent-blue-500"
                            />
                            <div>
                              <div className="font-semibold text-white">
                                {item.label}
                                {item.ownerOnly ? ' (Owner Only)' : ''}
                              </div>
                              <div className="text-[11px] text-slate-400">{item.description}</div>
                            </div>
                          </label>
                        );
                      })}
                  </div>
                </div>
              </div>

              {/* Assigned Admin Telegram Users */}
              <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-4 text-xs">
                <div className="text-sm font-semibold text-white">Database Admin Role Assignments</div>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await apiFetch('/api/admin/role-assignments', {
                        method: 'POST',
                        isAdmin: true,
                        body: JSON.stringify({
                          telegramId: assignTgId,
                          roleId: assignRoleId,
                          displayLabel: assignLabel,
                        }),
                      });
                      setAssignTgId('');
                      setAssignLabel('');
                      await loadTabData('roles');
                      notify('Telegram administrator assigned', 'success');
                    } catch (err) {
                      notify(err instanceof Error ? err.message : 'Assignment failed', 'error');
                    }
                  }}
                  className="grid grid-cols-1 sm:grid-cols-4 gap-2"
                >
                  <input
                    type="text"
                    required
                    value={assignTgId}
                    onChange={(e) => setAssignTgId(e.target.value)}
                    placeholder="Numeric Telegram ID"
                    className="h-10 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-white font-mono-nums"
                  />
                  <select
                    value={assignRoleId}
                    onChange={(e) => setAssignRoleId(e.target.value)}
                    className="h-10 px-2.5 rounded-xl bg-[#070B14] border border-slate-800 text-white"
                  >
                    {rbacData.roles
                      .filter((r) => adminSession.isOwner || String(r.code) !== 'OWNER')
                      .map((r) => (
                        <option key={String(r.id)} value={String(r.id)}>
                          {String(r.code)} — {String(r.name)}
                        </option>
                      ))}
                  </select>
                  <input
                    type="text"
                    value={assignLabel}
                    onChange={(e) => setAssignLabel(e.target.value)}
                    placeholder="Staff label (e.g. Trust Mod)"
                    className="h-10 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-white"
                  />
                  <button type="submit" className="h-10 px-4 rounded-xl bg-blue-600 text-white font-semibold">
                    Assign Admin
                  </button>
                </form>

                <div className="divide-y divide-slate-800/70">
                  {rbacData.roleAssignments.length === 0 ? (
                    <div className="py-3 text-slate-400">No secondary Telegram administrators assigned in database yet.</div>
                  ) : (
                    rbacData.roleAssignments.map((as) => (
                      <div key={String(as.id)} className="py-3 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="font-semibold text-white">
                            {String(as.display_label || as.display_name || as.telegram_id)}
                          </span>
                          <span className="text-slate-400 ml-2 font-mono-nums">
                            TG: {String(as.telegram_id)} · Assigned by {String(as.assigned_by || 'system')}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={String(as.role_id)}
                            onChange={async (e) => {
                              try {
                                await apiFetch(`/api/admin/role-assignments/${as.id}`, {
                                  method: 'PATCH',
                                  isAdmin: true,
                                  body: JSON.stringify({ roleId: e.target.value }),
                                });
                                await loadTabData('roles');
                                notify('Role assignment updated', 'success');
                              } catch (err) {
                                notify(err instanceof Error ? err.message : 'Update failed', 'error');
                              }
                            }}
                            className="h-8 px-2 rounded-lg bg-[#070B14] border border-slate-800 text-white"
                          >
                            {rbacData.roles
                              .filter((r) => adminSession.isOwner || String(r.code) !== 'OWNER')
                              .map((r) => (
                                <option key={String(r.id)} value={String(r.id)}>
                                  {String(r.code)}
                                </option>
                              ))}
                          </select>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await apiFetch(`/api/admin/role-assignments/${as.id}`, {
                                  method: 'PATCH',
                                  isAdmin: true,
                                  body: JSON.stringify({ isActive: !as.is_active }),
                                });
                                await loadTabData('roles');
                              } catch (err) {
                                notify(err instanceof Error ? err.message : 'Toggle failed', 'error');
                              }
                            }}
                            className={`h-8 px-3 rounded-lg ${
                              as.is_active ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300'
                            }`}
                          >
                            {as.is_active ? 'Active' : 'Inactive'}
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await apiFetch(`/api/admin/role-assignments/${as.id}`, {
                                  method: 'DELETE',
                                  isAdmin: true,
                                });
                                await loadTabData('roles');
                                notify('Admin access revoked', 'success');
                              } catch (err) {
                                notify(err instanceof Error ? err.message : 'Revoke failed', 'error');
                              }
                            }}
                            className="h-8 px-3 rounded-lg bg-red-950/60 border border-red-800/50 text-red-200"
                          >
                            Revoke
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Create Custom Role */}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    await apiFetch('/api/admin/roles', {
                      method: 'POST',
                      isAdmin: true,
                      body: JSON.stringify({
                        code: newRoleCode,
                        name: newRoleName,
                        description: newRoleDesc,
                        permissions: newRolePerms,
                      }),
                    });
                    setNewRoleCode('');
                    setNewRoleName('');
                    setNewRoleDesc('');
                    setNewRolePerms(['overview.view']);
                    await loadTabData('roles');
                    notify('Custom admin role created', 'success');
                  } catch (err) {
                    notify(err instanceof Error ? err.message : 'Role creation failed', 'error');
                  }
                }}
                className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3 text-xs"
              >
                <div className="text-sm font-semibold text-white">Create Custom Admin Role</div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <input
                    type="text"
                    required
                    value={newRoleCode}
                    onChange={(e) => setNewRoleCode(e.target.value)}
                    placeholder="Code (e.g. TRUST_LEAD)"
                    className="h-10 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-white"
                  />
                  <input
                    type="text"
                    required
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                    placeholder="Role Name"
                    className="h-10 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-white"
                  />
                  <input
                    type="text"
                    value={newRoleDesc}
                    onChange={(e) => setNewRoleDesc(e.target.value)}
                    placeholder="Role Description"
                    className="h-10 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-white"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {permissionCatalog
                    .filter((item) => item.key !== '*' && (!item.ownerOnly || adminSession.isOwner))
                    .map((item) => (
                      <label key={item.key} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#070B14] border border-slate-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newRolePerms.includes(item.key)}
                          onChange={() =>
                            setNewRolePerms((prev) =>
                              prev.includes(item.key)
                                ? prev.filter((k) => k !== item.key)
                                : [...prev, item.key]
                            )
                          }
                          className="accent-blue-500"
                        />
                        <span className="text-slate-200">{item.label}</span>
                      </label>
                    ))}
                </div>
                <button type="submit" className="h-10 px-5 rounded-xl bg-blue-600 text-white font-semibold">
                  Create Custom Role
                </button>
              </form>
            </div>
          )}

          {/* AUDIT LOGS TAB */}
          {tab === 'audit' && (
            <div className="bg-[#0E1525] border border-slate-800 rounded-2xl divide-y divide-slate-800/70">
              <div className="p-4 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-white">Immutable Admin Audit Logs</div>
                <input
                  type="search"
                  value={auditFilter}
                  onChange={(e) => setAuditFilter(e.target.value)}
                  placeholder="Filter action or admin ID..."
                  className="h-8 w-full sm:w-56 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white"
                />
              </div>
              {auditLogs.length === 0 ? (
                <div className="p-6 text-xs text-slate-400">No administrative actions audited yet.</div>
              ) : (
                auditLogs
                  .filter((log) => {
                    if (!auditFilter.trim()) return true;
                    const q = auditFilter.trim().toLowerCase();
                    return (
                      String(log.action || '').toLowerCase().includes(q) ||
                      String(log.admin_identifier || '').toLowerCase().includes(q) ||
                      String(log.target_type || '').toLowerCase().includes(q)
                    );
                  })
                  .map((log) => (
                    <div key={String(log.id)} className="p-3.5 flex flex-wrap justify-between gap-2 text-xs">
                      <div>
                        <span className="font-semibold text-white">{String(log.action)}</span>
                        <span className="text-slate-400 ml-2">
                          by {String(log.admin_identifier)} ({String(log.target_type)}:{String(log.target_id)})
                        </span>
                      </div>
                      <span className="text-slate-500 font-mono-nums">
                        {new Date(String(log.created_at) + 'Z').toLocaleString()}
                      </span>
                    </div>
                  ))
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
