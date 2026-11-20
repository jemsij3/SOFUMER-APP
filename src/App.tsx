import { Bot, Compass, Home, MessageSquare, PlusCircle, User as UserIcon } from 'lucide-react';
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

function AppShell() {
  const {
    user,
    language,
    announcement,
    unreadMessages,
    view,
    switchTab,
    navigate,
    requireUserOrPrompt,
  } = useApp();

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
              {!user ? (
                <button
                  type="button"
                  onClick={() => requireUserOrPrompt()}
                  className="h-9 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold whitespace-nowrap shrink-0 transition-colors"
                >
                  Connect
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => navigate({ type: 'seller' })}
                  className="h-9 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
                >
                  <PlusCircle className="w-3.5 h-3.5" />
                  <span>{t(language, 'sell')}</span>
                </button>
              )}
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
