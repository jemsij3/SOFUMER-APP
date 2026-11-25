import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch, setUserToken } from '../lib/api';
import {
  clearCachedTelegramInitData,
  getTelegramClientStatus,
  initTelegramMiniApp,
  syncTelegramBackButton,
  triggerHaptic,
  waitForTelegramInitData,
} from '../lib/telegram';
import type {
  Category,
  Country,
  Currency,
  NavTab,
  SellerProfile,
  Shop,
  Subcategory,
  SubscriptionPlan,
  SubView,
  User,
} from '../types';

interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

import type { TelegramInitDataSource } from '../lib/telegram';

export interface AuthDiagnostics {
  stageA_launchContext: 'mini_app' | 'telegram_in_app_browser' | 'external_browser';
  stageB_webAppDetected: boolean;
  platform: string;
  version: string;
  stageC_initDataPresent: boolean;
  initDataSource: TelegramInitDataSource;
  initDataLength: number;
  stageD_sentToWorker: boolean;
  stageE_workerReceivedInitData: boolean | null;
  stageF_signatureVerified: boolean | null;
  stageG_sessionEstablished: boolean;
  meStatus?: number;
  meReason?: string | null;
}

interface AppContextValue {
  user: User | null;
  isAdminMode: boolean;
  sellerProfile: SellerProfile | null;
  shop: Shop | null;
  authLoading: boolean;
  authError: string | null;
  authDiagnostics: AuthDiagnostics;
  botName: string;
  botUsername: string;
  launchUrl: string;
  telegramConfigured: boolean;
  jwtConfigured: boolean;
  configLoaded: boolean;
  categories: Category[];
  subcategories: Subcategory[];
  countries: Country[];
  currencies: Currency[];
  plans: SubscriptionPlan[];
  announcement: string;
  sellerRegistrationEnabled: boolean;
  displayCurrency: string;
  setDisplayCurrency: (code: string) => void;
  language: string;
  setLanguage: (lang: string) => void;
  favoriteIds: Set<string>;
  unreadMessages: number;
  unreadNotifications: number;
  view: SubView;
  navigate: (next: SubView) => void;
  goBack: () => void;
  switchTab: (tab: NavTab) => void;
  refreshSession: () => Promise<boolean>;
  refreshBootstrap: () => Promise<void>;
  retryTelegramAuth: () => Promise<void>;
  toggleFavorite: (productId: string) => Promise<void>;
  showAuthModal: boolean;
  setShowAuthModal: (open: boolean) => void;
  requireUserOrPrompt: () => boolean;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
  logout: () => Promise<void>;
  exploreInitialCategory: string;
  setExploreInitialCategory: (catId: string) => void;
  exploreInitialQuery: string;
  setExploreInitialQuery: (q: string) => void;
  aiInitialPrompt: string;
  setAiInitialPrompt: (p: string) => void;
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [sellerProfile, setSellerProfile] = useState<SellerProfile | null>(null);
  const [shop, setShop] = useState<Shop | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [botName, setBotName] = useState('');
  const [botUsername, setBotUsername] = useState('');
  const [launchUrl, setLaunchUrl] = useState('');
  const [telegramConfigured, setTelegramConfigured] = useState(false);
  const [jwtConfigured, setJwtConfigured] = useState(true);
  const [configLoaded, setConfigLoaded] = useState(false);
  const authInFlightRef = useRef<Promise<void> | null>(null);
  const [authDiagnostics, setAuthDiagnostics] = useState<AuthDiagnostics>({
    stageA_launchContext: 'external_browser',
    stageB_webAppDetected: false,
    platform: '',
    version: '',
    stageC_initDataPresent: false,
    initDataSource: 'none',
    initDataLength: 0,
    stageD_sentToWorker: false,
    stageE_workerReceivedInitData: null,
    stageF_signatureVerified: null,
    stageG_sessionEstablished: false,
  });

  const [categories, setCategories] = useState<Category[]>([]);
  const [subcategories, setSubcategories] = useState<Subcategory[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [sellerRegistrationEnabled, setSellerRegistrationEnabled] = useState(true);

  const [displayCurrency, setDisplayCurrency] = useState('USD');
  const [language, setLanguage] = useState('en');
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const [exploreInitialCategory, setExploreInitialCategory] = useState('');
  const [exploreInitialQuery, setExploreInitialQuery] = useState('');
  const [aiInitialPrompt, setAiInitialPrompt] = useState('');
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);

  const initialView: SubView =
    typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')
      ? { type: 'admin' }
      : { type: 'tab', tab: 'home' };

  const isAdminMode = Boolean(user?.isAdmin || user?.mode === 'admin');
  const isAdminModeRef = useRef(isAdminMode);
  isAdminModeRef.current = isAdminMode;

  const [history, setHistory] = useState<SubView[]>([initialView]);
  const view = history[history.length - 1];

  const notify = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev.slice(-3), { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const navigate = useCallback((next: SubView) => {
    triggerHaptic('light');
    if (isAdminModeRef.current) {
      setHistory([{ type: 'admin' }]);
      return;
    }
    setHistory((prev) => [...prev.slice(-15), next]);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, []);

  const goBack = useCallback(() => {
    triggerHaptic('light');
    if (isAdminModeRef.current) {
      setHistory([{ type: 'admin' }]);
      return;
    }
    setHistory((prev) => (prev.length > 1 ? prev.slice(0, -1) : [{ type: 'tab', tab: 'home' }]));
  }, []);

  const switchTab = useCallback((tab: NavTab) => {
    triggerHaptic('light');
    if (isAdminModeRef.current) {
      setHistory([{ type: 'admin' }]);
      return;
    }
    setHistory([{ type: 'tab', tab }]);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, []);

  useEffect(() => {
    const isSubView = view.type !== 'tab';
    return syncTelegramBackButton(isSubView, goBack);
  }, [view.type, goBack]);

  const refreshBootstrap = useCallback(async () => {
    try {
      const data = await apiFetch<{
        categories: Category[];
        subcategories: Subcategory[];
        countries: Country[];
        currencies: Currency[];
        plans: SubscriptionPlan[];
        announcement: string;
        sellerRegistrationEnabled: boolean;
      }>('/api/marketplace/bootstrap');
      setCategories(data.categories);
      setSubcategories(data.subcategories);
      setCountries(data.countries);
      setCurrencies(data.currencies);
      setPlans(data.plans);
      setAnnouncement(data.announcement);
      setSellerRegistrationEnabled(data.sellerRegistrationEnabled);
    } catch {
      // Handled gracefully
    }
  }, []);

  const performSessionCheck = useCallback(async (): Promise<{
    authenticated: boolean;
    status: number;
    reason?: string | null;
    error?: string | null;
  }> => {
    try {
      const me = await apiFetch<{
        authenticated: boolean;
        mode?: 'admin' | 'marketplace';
        user: User | null;
        reason?: string;
        error?: string;
        sellerProfile?: SellerProfile | null;
        shop?: Shop | null;
        unreadMessages?: number;
        unreadNotifications?: number;
        favoriteProductIds?: string[];
      }>('/api/auth/me');

      if (me.authenticated && me.user) {
        const adminActive = Boolean(me.user.isAdmin || me.mode === 'admin' || me.user.mode === 'admin');
        isAdminModeRef.current = adminActive;
        const normalizedUser: User = {
          ...me.user,
          mode: adminActive ? 'admin' : 'marketplace',
        };
        setUser(normalizedUser);
        if (adminActive) {
          setSellerProfile(null);
          setShop(null);
          setUnreadMessages(0);
          setUnreadNotifications(0);
          setFavoriteIds(new Set());
          setHistory([{ type: 'admin' }]);
          await refreshBootstrap();
          return { authenticated: true, status: 200 };
        }
        setSellerProfile(me.sellerProfile || null);
        setShop(me.shop || null);
        setUnreadMessages(me.unreadMessages || 0);
        setUnreadNotifications(me.unreadNotifications || 0);
        setFavoriteIds(new Set(me.favoriteProductIds || []));
        if (me.user.preferred_currency) setDisplayCurrency(me.user.preferred_currency);
        if (me.user.preferred_language) setLanguage(me.user.preferred_language);
        await refreshBootstrap();
        return { authenticated: true, status: 200 };
      }

      isAdminModeRef.current = false;
      setUser(null);
      setSellerProfile(null);
      setShop(null);
      setUnreadMessages(0);
      setUnreadNotifications(0);
      setFavoriteIds(new Set());
      return {
        authenticated: false,
        status: 200,
        reason: me.reason || 'unauthenticated',
        error: me.error || null,
      };
    } catch (err) {
      isAdminModeRef.current = false;
      setUser(null);
      setSellerProfile(null);
      setShop(null);
      setUnreadMessages(0);
      setUnreadNotifications(0);
      setFavoriteIds(new Set());
      if (err instanceof ApiError) {
        const reason = typeof err.data.reason === 'string' ? err.data.reason : null;
        return {
          authenticated: false,
          status: err.status,
          reason,
          error: err.message,
        };
      }
      return {
        authenticated: false,
        status: 0,
        reason: 'network_error',
        error: err instanceof Error ? err.message : 'Unable to reach /api/auth/me',
      };
    }
  }, [refreshBootstrap]);

  const refreshSession = useCallback(async (): Promise<boolean> => {
    const res = await performSessionCheck();
    return res.authenticated;
  }, [performSessionCheck]);

  const authenticateTelegram = useCallback(async () => {
    if (authInFlightRef.current) {
      return authInFlightRef.current;
    }

    const run = (async () => {
      setAuthLoading(true);
      setAuthError(null);
      initTelegramMiniApp();

      let cfgOk = false;
      let tgConfigured = false;
      let jwtCfgOk = true;
      let cfgErrorMsg: string | null = null;

      try {
        const cfg = await apiFetch<{
          botName: string | null;
          botUsername: string | null;
          launchUrl?: string | null;
          telegramConfigured: boolean;
          jwtConfigured?: boolean;
        }>('/api/auth/config');
        cfgOk = true;
        tgConfigured = Boolean(cfg.telegramConfigured);
        jwtCfgOk = cfg.jwtConfigured !== false;
        setBotName(cfg.botName || '');
        setBotUsername(cfg.botUsername || '');
        setLaunchUrl(cfg.launchUrl || (cfg.botUsername ? `https://t.me/${cfg.botUsername}?startapp` : ''));
        setTelegramConfigured(tgConfigured);
        setJwtConfigured(jwtCfgOk);
        setConfigLoaded(true);
      } catch (err) {
        cfgErrorMsg = err instanceof Error ? err.message : 'Unable to reach SOFUMER authentication service.';
        setConfigLoaded(false);
      }

      const { initData, source } = await waitForTelegramInitData(700);
      const tgStatus = getTelegramClientStatus();

      const diag: AuthDiagnostics = {
        stageA_launchContext: tgStatus.hasTelegramWebApp
          ? initData
            ? 'mini_app'
            : 'telegram_in_app_browser'
          : 'external_browser',
        stageB_webAppDetected: tgStatus.hasTelegramWebApp,
        platform: tgStatus.platform || 'unknown',
        version: tgStatus.version || '',
        stageC_initDataPresent: initData.length > 0,
        initDataSource: source,
        initDataLength: initData.length,
        stageD_sentToWorker: false,
        stageE_workerReceivedInitData: null,
        stageF_signatureVerified: null,
        stageG_sessionEstablished: false,
      };

      let postAuthError: string | null = null;
      if (initData) {
        diag.stageD_sentToWorker = true;
        try {
          const authRes = await apiFetch<{
            authenticated?: boolean;
            token?: string;
            diagnostics?: {
              receivedInitData?: boolean;
              signatureVerified?: boolean;
              sessionCreated?: boolean;
            };
          }>('/api/auth/telegram', {
            method: 'POST',
            body: JSON.stringify({ initData }),
          });
          diag.stageE_workerReceivedInitData = authRes.diagnostics?.receivedInitData ?? true;
          const sigOk = Boolean(authRes.authenticated && authRes.token && (authRes.diagnostics?.signatureVerified ?? true));
          diag.stageF_signatureVerified = sigOk;
          if (authRes.authenticated && authRes.token) {
            setUserToken(authRes.token);
          } else {
            setUserToken(null);
            postAuthError = 'Telegram verification succeeded, but no session token was issued.';
          }
        } catch (err) {
          setUserToken(null);
          if (err instanceof ApiError) {
            const serverDiag = err.data?.diagnostics as
              | { receivedInitData?: boolean; signatureVerified?: boolean }
              | undefined;
            if (typeof serverDiag?.receivedInitData === 'boolean') {
              diag.stageE_workerReceivedInitData = serverDiag.receivedInitData;
            } else if (err.status < 500) {
              diag.stageE_workerReceivedInitData = true;
            }
            if (typeof serverDiag?.signatureVerified === 'boolean') {
              diag.stageF_signatureVerified = serverDiag.signatureVerified;
            } else {
              diag.stageF_signatureVerified = err.status >= 500 ? null : false;
            }
            if (err.status < 500 && diag.stageF_signatureVerified === false) {
              clearCachedTelegramInitData();
            }
            postAuthError = err.message;
          } else {
            diag.stageF_signatureVerified = null;
            postAuthError = err instanceof Error ? err.message : 'Telegram Mini App verification failed.';
          }
        }
      }

      const sessionCheck = await performSessionCheck();
      diag.stageG_sessionEstablished = sessionCheck.authenticated;
      diag.meStatus = sessionCheck.status;
      diag.meReason = sessionCheck.reason || null;
      setAuthDiagnostics(diag);

      console.info('[SOFUMER Auth Diagnostics]', {
        stageA_launchContext: diag.stageA_launchContext,
        stageB_webAppDetected: diag.stageB_webAppDetected,
        platform: diag.platform,
        stageC_initDataPresent: diag.stageC_initDataPresent,
        initDataSource: diag.initDataSource,
        initDataLength: diag.initDataLength,
        stageD_sentToWorker: diag.stageD_sentToWorker,
        stageE_workerReceivedInitData: diag.stageE_workerReceivedInitData,
        stageF_signatureVerified: diag.stageF_signatureVerified,
        stageG_sessionEstablished: diag.stageG_sessionEstablished,
        meStatus: diag.meStatus,
        meReason: diag.meReason,
      });

      if (!sessionCheck.authenticated) {
        if (postAuthError) {
          setAuthError(postAuthError);
        } else if (!cfgOk && cfgErrorMsg) {
          setAuthError(`Authentication service check failed: ${cfgErrorMsg}`);
        } else if (cfgOk && (!tgConfigured || !jwtCfgOk)) {
          setAuthError(
            'SOFUMER server secrets (TELEGRAM_BOT_TOKEN or JWT_SECRET) are missing on Cloudflare Worker sofumer-app.'
          );
        } else if (diag.stageD_sentToWorker && diag.stageF_signatureVerified) {
          const detail = sessionCheck.reason
            ? ` (${sessionCheck.status ? `HTTP ${sessionCheck.status}: ` : ''}${sessionCheck.reason})`
            : sessionCheck.status
            ? ` (HTTP ${sessionCheck.status})`
            : '';
          setAuthError(
            `Telegram signature verified, but your session check (/api/auth/me) failed${detail}. ${
              sessionCheck.error || 'Tap Retry Telegram Verification.'
            }`
          );
        } else if (tgStatus.hasTelegramWebApp && !initData) {
          setAuthError(
            `Telegram WebApp loaded (platform: ${diag.platform}), but initData is empty. This happens when SOFUMER is opened from a regular URL link instead of the bot's Menu Button or /start Web App button.`
          );
        }
      }
      setAuthLoading(false);
    })();

    authInFlightRef.current = run;
    try {
      await run;
    } finally {
      authInFlightRef.current = null;
    }
  }, [performSessionCheck]);

  useEffect(() => {
    initTelegramMiniApp();
    authenticateTelegram();
  }, [authenticateTelegram]);

  const requireUserOrPrompt = useCallback(() => {
    if (isAdminModeRef.current) return false;
    if (user) return true;
    setShowAuthModal(true);
    return false;
  }, [user]);

  const toggleFavorite = useCallback(
    async (productId: string) => {
      if (isAdminModeRef.current || !requireUserOrPrompt()) return;
      try {
        const res = await apiFetch<{ favorited: boolean }>(`/api/marketplace/favorites/${productId}`, {
          method: 'POST',
        });
        setFavoriteIds((prev) => {
          const next = new Set(prev);
          if (res.favorited) next.add(productId);
          else next.delete(productId);
          return next;
        });
        notify(res.favorited ? 'Saved to wishlist' : 'Removed from wishlist', 'success');
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Failed to update wishlist', 'error');
      }
    },
    [requireUserOrPrompt, notify]
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore
    }
    isAdminModeRef.current = false;
    setUserToken(null);
    setUser(null);
    setSellerProfile(null);
    setShop(null);
    setUnreadMessages(0);
    setUnreadNotifications(0);
    setFavoriteIds(new Set());
    setHistory([{ type: 'tab', tab: 'home' }]);
    notify('Signed out of SOFUMER', 'info');
  }, [notify]);

  return (
    <AppContext.Provider
      value={{
        user,
        isAdminMode,
        sellerProfile,
        shop,
        authLoading,
        authError,
        authDiagnostics,
        botName,
        botUsername,
        launchUrl,
        telegramConfigured,
        jwtConfigured,
        configLoaded,
        categories,
        subcategories,
        countries,
        currencies,
        plans,
        announcement,
        sellerRegistrationEnabled,
        displayCurrency,
        setDisplayCurrency,
        language,
        setLanguage,
        favoriteIds,
        unreadMessages,
        unreadNotifications,
        view,
        navigate,
        goBack,
        switchTab,
        refreshSession,
        refreshBootstrap,
        retryTelegramAuth: authenticateTelegram,
        toggleFavorite,
        showAuthModal,
        setShowAuthModal,
        requireUserOrPrompt,
        notify,
        logout,
        exploreInitialCategory,
        setExploreInitialCategory,
        exploreInitialQuery,
        setExploreInitialQuery,
        aiInitialPrompt,
        setAiInitialPrompt,
        activeConversationId,
        setActiveConversationId,
      }}
    >
      {children}
      {/* Toast Notifications */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto px-4 py-3 rounded-xl border text-sm font-medium shadow-xl backdrop-blur-md transition-all ${
              toast.type === 'error'
                ? 'bg-red-950/90 border-red-700/60 text-red-100'
                : toast.type === 'success'
                ? 'bg-emerald-950/90 border-emerald-700/60 text-emerald-100'
                : 'bg-[#0E1525]/95 border-slate-700/70 text-slate-100'
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
