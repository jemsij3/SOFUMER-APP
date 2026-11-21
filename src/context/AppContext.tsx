import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch, setUserToken } from '../lib/api';
import { getTelegramInitData, initTelegramMiniApp, syncTelegramBackButton, triggerHaptic } from '../lib/telegram';
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

interface AppContextValue {
  user: User | null;
  sellerProfile: SellerProfile | null;
  shop: Shop | null;
  authLoading: boolean;
  authError: string | null;
  botName: string;
  botUsername: string;
  telegramConfigured: boolean;
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
  const [telegramConfigured, setTelegramConfigured] = useState(false);

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
    setHistory((prev) => [...prev.slice(-15), next]);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, []);

  const goBack = useCallback(() => {
    triggerHaptic('light');
    setHistory((prev) => (prev.length > 1 ? prev.slice(0, -1) : [{ type: 'tab', tab: 'home' }]));
  }, []);

  const switchTab = useCallback((tab: NavTab) => {
    triggerHaptic('light');
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

  const refreshSession = useCallback(async (): Promise<boolean> => {
    try {
      const me = await apiFetch<{
        authenticated: boolean;
        user: User | null;
        sellerProfile?: SellerProfile | null;
        shop?: Shop | null;
        unreadMessages?: number;
        unreadNotifications?: number;
        favoriteProductIds?: string[];
      }>('/api/auth/me');

      if (me.authenticated && me.user) {
        setUser(me.user);
        setSellerProfile(me.sellerProfile || null);
        setShop(me.shop || null);
        setUnreadMessages(me.unreadMessages || 0);
        setUnreadNotifications(me.unreadNotifications || 0);
        setFavoriteIds(new Set(me.favoriteProductIds || []));
        if (me.user.preferred_currency) setDisplayCurrency(me.user.preferred_currency);
        if (me.user.preferred_language) setLanguage(me.user.preferred_language);
        await refreshBootstrap();
        return true;
      } else {
        setUser(null);
        setSellerProfile(null);
        setShop(null);
        setUnreadMessages(0);
        setUnreadNotifications(0);
        setFavoriteIds(new Set());
        return false;
      }
    } catch {
      setUser(null);
      return false;
    }
  }, [refreshBootstrap]);

  const authenticateTelegram = useCallback(async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const cfg = await apiFetch<{
        botName: string | null;
        botUsername: string | null;
        telegramConfigured: boolean;
      }>('/api/auth/config');
      setBotName(cfg.botName || '');
      setBotUsername(cfg.botUsername || '');
      setTelegramConfigured(Boolean(cfg.telegramConfigured));
    } catch {
      // Ignore config lookup errors
    }

    const initData = getTelegramInitData();
    if (initData) {
      try {
        const authRes = await apiFetch<{ token: string }>('/api/auth/telegram', {
          method: 'POST',
          body: JSON.stringify({ initData }),
        });
        if (authRes.token) setUserToken(authRes.token);
      } catch (err) {
        setUserToken(null);
        setAuthError(err instanceof Error ? err.message : 'Telegram Mini App verification failed.');
      }
    }

    await refreshSession();
    setAuthLoading(false);
  }, [refreshSession]);

  useEffect(() => {
    initTelegramMiniApp();
    authenticateTelegram();
  }, [authenticateTelegram]);

  const requireUserOrPrompt = useCallback(() => {
    if (user) return true;
    setShowAuthModal(true);
    return false;
  }, [user]);

  const toggleFavorite = useCallback(
    async (productId: string) => {
      if (!requireUserOrPrompt()) return;
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
    setUserToken(null);
    setUser(null);
    setSellerProfile(null);
    setShop(null);
    setFavoriteIds(new Set());
    notify('Signed out of SOFUMER', 'info');
  }, [notify]);

  return (
    <AppContext.Provider
      value={{
        user,
        sellerProfile,
        shop,
        authLoading,
        authError,
        botName,
        botUsername,
        telegramConfigured,
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
