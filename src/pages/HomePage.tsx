import { useEffect, useState } from 'react';
import { ArrowRight, Bell, Bot, PlusCircle, Search, Store } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import { t } from '../lib/i18n';
import type { Product, Shop } from '../types';
import { ProductCard } from '../components/ProductCard';
import { ImageWithFallback } from '../components/ImageWithFallback';

interface HomeData {
  featuredProducts: Product[];
  trendingProducts: Product[];
  newArrivals: Product[];
  featuredShops: Shop[];
  activePromotions: Array<{
    id: string;
    title: string;
    promo_type: string;
    shop_name: string;
    shop_slug: string;
    product_id?: string;
    product_title?: string;
  }>;
  recentlyViewed: Product[];
  totalPublished: number;
}

export function HomePage() {
  const {
    user,
    categories,
    language,
    unreadNotifications,
    navigate,
    switchTab,
    setExploreInitialCategory,
    setExploreInitialQuery,
    setAiInitialPrompt,
    requireUserOrPrompt,
  } = useApp();

  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');

  useEffect(() => {
    let mounted = true;
    apiFetch<HomeData>('/api/marketplace/home')
      .then((res) => {
        if (mounted) setData(res);
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [user?.id]);

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setExploreInitialCategory('');
    setExploreInitialQuery(searchInput.trim());
    switchTab('explore');
  }

  function openSell() {
    if (!requireUserOrPrompt()) return;
    navigate({ type: 'seller' });
  }

  return (
    <div className="space-y-8 pb-8">
      {/* Compact Search + AI & Sell Action Strip */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium tracking-wide text-blue-400">
              {t(language, 'slogan')}
            </p>
            <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
              Global AI Marketplace
            </h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                if (!requireUserOrPrompt()) return;
                navigate({ type: 'notifications' });
              }}
              aria-label="Notifications"
              className="relative min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-[#0E1525] border border-slate-800 text-slate-200 hover:border-slate-700"
            >
              <Bell className="w-4 h-4" />
              {unreadNotifications > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-[10px] font-semibold text-white flex items-center justify-center font-mono-nums">
                  {unreadNotifications}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={openSell}
              className="h-11 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
            >
              <PlusCircle className="w-4 h-4" />
              <span>{t(language, 'sell')}</span>
            </button>
          </div>
        </div>

        <form onSubmit={handleSearchSubmit} className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t(language, 'searchPlaceholder')}
              className="w-full h-11 pl-10 pr-4 rounded-xl bg-[#0E1525] border border-slate-800 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setAiInitialPrompt('Find top products or services available for international delivery');
              switchTab('ai');
            }}
            className="h-11 px-4 rounded-xl bg-[#131C31] hover:bg-[#19233D] border border-purple-700/40 text-slate-100 text-sm font-medium flex items-center justify-center gap-2 whitespace-nowrap shrink-0 transition-colors"
          >
            <Bot className="w-4 h-4 text-purple-400" />
            <span>Ask AI Assistant</span>
          </button>
        </form>
      </section>

      {/* Editorial Hero Banner */}
      <section className="relative rounded-2xl overflow-hidden border border-slate-800/80 bg-[#0E1525]">
        <div className="grid grid-cols-1 lg:grid-cols-12 items-stretch">
          <div className="lg:col-span-6 p-6 sm:p-8 flex flex-col justify-between gap-6">
            <div className="space-y-3">
              <div className="text-xs text-slate-400">
                Direct Global Commerce · Physical, Digital & Services
              </div>
              <h2 className="text-2xl sm:text-3xl font-bold text-white leading-tight [text-wrap:balance]">
                Connect directly with verified global sellers and AI-guided discovery.
              </h2>
              <p className="text-sm text-slate-300 leading-relaxed max-w-xl">
                Browse international hardware, digital assets, software licenses, and professional
                services. Negotiate terms directly with sellers inside private Telegram-authenticated
                conversations.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => switchTab('explore')}
                className="h-11 px-5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold inline-flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
              >
                <span>Browse Marketplace</span>
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={openSell}
                className="h-11 px-5 rounded-xl bg-[#131C31] hover:bg-[#19243E] border border-slate-700 text-slate-100 text-sm font-medium whitespace-nowrap shrink-0 transition-colors"
              >
                Open Your Shop
              </button>
            </div>
          </div>
          <div className="lg:col-span-6 relative min-h-[210px] lg:min-h-[280px]">
            <img
              src="/src/assets/images/hero_sofumer_global_1795188643158.jpg"
              alt="SOFUMER Global Marketplace Showcase"
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover lg:absolute lg:inset-0"
            />
            <div className="absolute inset-0 bg-gradient-to-t lg:bg-gradient-to-r from-[#0E1525] via-[#0E1525]/35 to-transparent" />
          </div>
        </div>
      </section>

      {/* Categories Strip */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base sm:text-lg font-semibold text-white">
            {t(language, 'categories')}
          </h2>
          <button
            type="button"
            onClick={() => {
              setExploreInitialCategory('');
              switchTab('explore');
            }}
            className="text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap"
          >
            View All
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5">
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => {
                setExploreInitialCategory(cat.id);
                setExploreInitialQuery('');
                switchTab('explore');
              }}
              className="p-3.5 rounded-xl bg-[#0E1525] border border-slate-800/80 hover:border-blue-500/50 text-left transition-colors"
            >
              <div className="text-sm font-medium text-slate-100 truncate">{cat.name}</div>
              <div className="mt-1 text-xs text-slate-400 line-clamp-1">{cat.description}</div>
            </button>
          ))}
        </div>
      </section>

      {/* Active Seller Promotions (only when real promotions exist) */}
      {data && data.activePromotions.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base sm:text-lg font-semibold text-white">Seller Promotions</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {data.activePromotions.map((promo) => (
              <button
                key={promo.id}
                type="button"
                onClick={() =>
                  promo.product_id
                    ? navigate({ type: 'product', productId: promo.product_id })
                    : navigate({ type: 'shop', slug: promo.shop_slug })
                }
                className="p-4 rounded-xl bg-gradient-to-r from-[#131C31] to-[#1A1434] border border-purple-700/40 text-left hover:border-purple-500/70 transition-colors"
              >
                <div className="text-xs text-purple-300">
                  {promo.shop_name} · {promo.promo_type.replace('_', ' ')}
                </div>
                <div className="mt-1 text-sm font-semibold text-white">{promo.title}</div>
                {promo.product_title && (
                  <div className="mt-1 text-xs text-slate-300 truncate">{promo.product_title}</div>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Marketplace Catalog Sections or Honest Empty State */}
      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="aspect-[4/5] rounded-2xl bg-[#0E1525] border border-slate-800 animate-pulse" />
          ))}
        </div>
      ) : data && data.totalPublished === 0 ? (
        <section className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 sm:p-8 grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
          <div className="md:col-span-7 space-y-3">
            <div className="text-xs text-slate-400">Live Catalog · 0 Published Listings</div>
            <h3 className="text-xl font-semibold text-white">
              Marketplace catalog is ready for your first published listings
            </h3>
            <p className="text-sm text-slate-300 leading-relaxed">
              SOFUMER never displays invented products or fabricated sales statistics. Register as an
              individual or business seller in Seller Center to publish physical goods, digital
              downloads, software licenses, or professional services.
            </p>
            <div className="pt-2 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={openSell}
                className="h-11 px-5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
              >
                Start Selling on SOFUMER
              </button>
              <button
                type="button"
                onClick={() => switchTab('ai')}
                className="h-11 px-5 rounded-xl bg-[#131C31] border border-slate-700 text-slate-200 text-sm font-medium hover:border-slate-600"
              >
                Explore AI Capabilities
              </button>
            </div>
          </div>
          <div className="md:col-span-5 rounded-xl overflow-hidden border border-slate-800 aspect-[16/9]">
            <img
              src="/src/assets/images/banner_digital_craft_1795188642758.jpg"
              alt="SOFUMER Seller Workspace"
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover"
            />
          </div>
        </section>
      ) : (
        <>
          {data && data.featuredProducts.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base sm:text-lg font-semibold text-white">
                  {t(language, 'featuredProducts')}
                </h2>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 sm:gap-4">
                {data.featuredProducts.map((p) => (
                  <ProductCard key={p.id} product={p} />
                ))}
              </div>
            </section>
          )}

          {data && data.trendingProducts.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base sm:text-lg font-semibold text-white">
                  {t(language, 'trendingProducts')}
                </h2>
                <button
                  type="button"
                  onClick={() => switchTab('explore')}
                  className="text-xs font-medium text-blue-400 hover:text-blue-300"
                >
                  Explore More
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 sm:gap-4">
                {data.trendingProducts.map((p) => (
                  <ProductCard key={p.id} product={p} />
                ))}
              </div>
            </section>
          )}

          {data && data.newArrivals.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-base sm:text-lg font-semibold text-white">
                {t(language, 'newArrivals')}
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 sm:gap-4">
                {data.newArrivals.map((p) => (
                  <ProductCard key={p.id} product={p} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Featured Shops */}
      {data && data.featuredShops.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base sm:text-lg font-semibold text-white">
            {t(language, 'featuredShops')}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {data.featuredShops.map((shop) => (
              <button
                key={shop.id}
                type="button"
                onClick={() => navigate({ type: 'shop', slug: shop.slug })}
                className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800 hover:border-slate-700 flex items-center gap-3.5 text-left transition-colors"
              >
                <div className="w-12 h-12 rounded-xl overflow-hidden bg-[#131C31] border border-slate-800 shrink-0 flex items-center justify-center">
                  {shop.logo_url ? (
                    <ImageWithFallback src={shop.logo_url} alt={shop.name} className="w-full h-full object-cover" />
                  ) : (
                    <Store className="w-5 h-5 text-blue-400" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-white truncate">{shop.name}</div>
                  <div className="text-xs text-slate-400 truncate mt-0.5">
                    {shop.country_name || shop.country_code} · {shop.product_count ?? 0} listings
                    {shop.verification_status === 'verified' ? ' · Verified' : ''}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Recently Viewed (authenticated users) */}
      {data && data.recentlyViewed.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base sm:text-lg font-semibold text-white">
            {t(language, 'recentlyViewed')}
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 sm:gap-4">
            {data.recentlyViewed.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
