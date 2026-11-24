import { Bot, Compass, ExternalLink, Home, Lock, MessageSquare, PlusCircle, RefreshCw, ShieldCheck, User as UserIcon } from 'lucide-react';
import { AppProvider, useApp } from './context/AppContext';
import { t } from './lib/i18n';
import { AuthGateModal } from './components/AuthGateModal';
import { HomePage } from './pages/HomePage';
import { ExplorePage } from './pages/ExplorePage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { ShopPage } from './pages/ShopPage';
import { AiAssistantPage } from './pages/AiAssistantPage';
import { MessagesPage } from './pages/MessagesPage';
import { OrdersPage } from './pages/OrdersPage';
import { SellerCenterPage } from './pages/SellerCenterPage';
import {
  AccountPage,
  NotificationsSupportPoliciesPage,
  WishlistOrRecentPage,
} from './pages/AccountPage';
import { AdminPage } from './pages/AdminPage';
import type { NavTab } from './types';

function TelegramOnlyGate() {
  const { authError, botName, botUsername, telegramConfigured, jwtConfigured, configLoaded, retryTelegramAuth } = useApp();
  const missingServerSecrets = configLoaded && (!telegramConfigured || !jwtConfigured);

  return (
    <div className="min-h-screen bg-[#070B14] text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-3xl bg-[#0E1525] border border-slate-800/90 p-7 shadow-2xl space-y-6">
        <div className="flex items-center gap-3.5">
          <img
            src="/src/assets/images/sofumer_brand_mark_1795188643094.jpg"
            alt="SOFUMER"
            className="w-11 h-11 rounded-2xl object-cover border border-slate-700/80 shrink-0"
          />
          <div>
            <h1 className="text-xl font-extrabold tracking-tight text-white font-display">SOFUMER</h1>
            <p className="text-xs text-slate-400">AI-Powered Global Marketplace</p>
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-[#070B14] border border-slate-800 space-y-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Lock className="w-4 h-4 text-blue-400 shrink-0" />
            <span>Telegram Mini App Access Only</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            SOFUMER runs exclusively inside Telegram. Standard browser access without verified Telegram Mini App authentication is disabled.
          </p>
          {authError && (
            <div className="p-2.5 rounded-xl bg-red-950/40 border border-red-800/50 text-xs text-red-200 leading-relaxed">
              {authError}
            </div>
          )}
        </div>

        <div className="space-y-3">
          {botUsername ? (
            <a
              href={`https://t.me/${botUsername}`}
              target="_blank"
              rel="noreferrer"
              className="w-full h-11 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              <span>Open {botName || 'SOFUMER'} (@{botUsername})</span>
              <ExternalLink className="w-4 h-4" />
            </a>
          ) : (
            <div className="p-3.5 rounded-xl bg-[#131C31]/70 border border-slate-800 flex items-center gap-2.5 text-xs text-slate-300">
              <ShieldCheck className="w-4 h-4 text-blue-400 shrink-0" />
              <span>
                {missingServerSecrets
                  ? 'Bot link unavailable because TELEGRAM_BOT_TOKEN is not set on Worker sofumer-app.'
                  : 'Launch this Mini App directly from the official SOFUMER Telegram bot.'}
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={() => retryTelegramAuth()}
            className="w-full h-10 px-4 rounded-xl bg-[#131C31] hover:bg-slate-800 border border-slate-700/80 text-xs font-medium text-slate-200 flex items-center justify-center gap-2 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Retry Telegram Verification</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function AppShell() {
  const {
    user,
    authLoading,
    language,
    announcement,
    unreadMessages,
    view,
    switchTab,
    navigate,
  } = useApp();

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#070B14] text-slate-100 flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="w-10 h-10 rounded-2xl bg-[#0E1525] border border-slate-800 flex items-center justify-center animate-pulse">
            <ShieldCheck className="w-5 h-5 text-blue-400" />
          </div>
          <p className="text-sm font-medium text-slate-300">Verifying Telegram Mini App session...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <TelegramOnlyGate />;
  }

  const isAdminView = view.type === 'admin';
  const activeTab: NavTab | null = view.type === 'tab' ? view.tab : null;

  const navItems: Array<{ key: NavTab; label: string; icon: typeof Home; badge?: number }> = [
    { key: 'home', label: t(language, 'home'), icon: Home },
    { key: 'explore', label: t(language, 'explore'), icon: Compass },
    { key: 'ai', label: t(language, 'aiAssistant'), icon: Bot },
    { key: 'messages', label: t(language, 'messages'), icon: MessageSquare, badge: unreadMessages },
    { key: 'account', label: t(language, 'account'), icon: UserIcon },
  ];

  return (
    <div
      dir={language === 'ar' ? 'rtl' : 'ltr'}
      className="min-h-screen bg-[#070B14] text-slate-100 flex flex-col"
    >
      {/* Optional Global Announcement Slim Strip (<= 40px) */}
      {!isAdminView && announcement && (
        <div className="bg-[#131C31] border-b border-slate-800 px-4 py-1.5 text-center text-xs text-blue-200 truncate">
          {announcement}
        </div>
      )}

      {/* Clean 3-Zone Desktop & Mobile Top Navigation */}
      {!isAdminView && (
        <header className="sticky top-0 z-30 h-14 bg-[#070B14]/90 backdrop-blur-md border-b border-slate-800/80 pt-safe">
          <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between gap-8">
            {/* Zone 1: Brand Wordmark */}
            <button
              type="button"
              onClick={() => switchTab('home')}
              className="flex items-center gap-2.5 whitespace-nowrap shrink-0 focus-visible:outline-none"
            >
              <img
                src="/src/assets/images/sofumer_brand_mark_1795188643094.jpg"
                alt="SOFUMER"
                className="w-7 h-7 rounded-lg object-cover border border-slate-700/70"
              />
              <span className="text-base sm:text-lg font-extrabold tracking-tight text-white font-display">
                SOFUMER
              </span>
            </button>

            {/* Zone 2: 5 Single-Line Navigation Links (Desktop) */}
            <nav className="hidden lg:flex items-center gap-7 text-sm font-medium">
              {navItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => switchTab(item.key)}
                  className={`relative py-1 whitespace-nowrap shrink-0 transition-colors ${
                    activeTab === item.key
                      ? 'text-white'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  <span>{item.label}</span>
                  {item.badge && item.badge > 0 ? (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-blue-600 text-[10px] text-white font-mono-nums">
                      {item.badge}
                    </span>
                  ) : null}
                  {activeTab === item.key && (
                    <span className="absolute left-0 right-0 -bottom-[17px] h-0.5 bg-blue-500" />
                  )}
                </button>
              ))}
            </nav>

            {/* Zone 3: Primary Action */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => navigate({ type: 'seller' })}
                className="h-9 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                <span>{t(language, 'sell')}</span>
              </button>
            </div>
          </div>
        </header>
      )}

      {/* Main Content Container */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 pt-5 pb-24 lg:pb-12">
        {view.type === 'tab' && view.tab === 'home' && <HomePage />}
        {view.type === 'tab' && view.tab === 'explore' && <ExplorePage />}
        {view.type === 'tab' && view.tab === 'ai' && <AiAssistantPage />}
        {view.type === 'tab' && view.tab === 'messages' && <MessagesPage />}
        {view.type === 'tab' && view.tab === 'account' && <AccountPage />}
        {view.type === 'product' && <ProductDetailPage productId={view.productId} />}
        {view.type === 'shop' && <ShopPage slug={view.slug} />}
        {view.type === 'seller' && <SellerCenterPage initialSection={view.section} />}
        {view.type === 'orders' && <OrdersPage initialOrderId={view.orderId} />}
        {view.type === 'wishlist' && <WishlistOrRecentPage mode="wishlist" />}
        {view.type === 'recently_viewed' && <WishlistOrRecentPage mode="recently_viewed" />}
        {view.type === 'notifications' && <NotificationsSupportPoliciesPage mode="notifications" />}
        {view.type === 'support' && <NotificationsSupportPoliciesPage mode="support" />}
        {view.type === 'policies' && <NotificationsSupportPoliciesPage mode="policies" />}
        {view.type === 'admin' && <AdminPage />}
      </main>

      {/* 5 Permanent Bottom Navigation Destinations (Mobile & Telegram Mini App) */}
      {!isAdminView && (
        <nav
          aria-label="Primary Mobile Navigation"
          className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#070B14]/95 backdrop-blur-md border-t border-slate-800/90 pb-safe"
        >
          <div className="grid grid-cols-5 h-14 items-center">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => switchTab(item.key)}
                  className={`relative h-full flex flex-col items-center justify-center gap-0.5 transition-colors ${
                    isActive ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="relative">
                    <Icon className="w-5 h-5" />
                    {item.badge && item.badge > 0 ? (
                      <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-blue-600 text-[9px] font-bold text-white flex items-center justify-center font-mono-nums">
                        {item.badge}
                      </span>
                    ) : null}
                  </div>
                  <span className="text-[10px] font-medium tracking-tight whitespace-nowrap">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>
      )}

      <AuthGateModal />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
