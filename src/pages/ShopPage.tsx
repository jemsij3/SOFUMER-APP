import { useEffect, useState } from 'react';
import { ArrowLeft, MessageSquare, Share2, ShieldCheck, Store } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import type { Product, Shop } from '../types';
import { ProductCard } from '../components/ProductCard';
import { ImageWithFallback } from '../components/ImageWithFallback';

interface ShopData {
  shop: Shop;
  products: Product[];
  reviews: Array<{
    id: string;
    rating: number;
    comment: string;
    reviewer_name: string;
    product_title: string;
    created_at: string;
  }>;
}

export function ShopPage({ slug }: { slug: string }) {
  const { goBack, requireUserOrPrompt, setActiveConversationId, switchTab, notify, user } = useApp();
  const [data, setData] = useState<ShopData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    apiFetch<ShopData>(`/api/marketplace/shops/${slug}`)
      .then((res) => {
        if (mounted) setData(res);
      })
      .catch((err) => notify(err instanceof Error ? err.message : 'Shop not found', 'error'))
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [slug, notify]);

  if (loading) {
    return <div className="h-64 rounded-2xl bg-[#0E1525] border border-slate-800 animate-pulse" />;
  }

  if (!data) {
    return (
      <div className="p-8 rounded-2xl bg-[#0E1525] border border-slate-800 text-center space-y-3">
        <p className="text-white font-semibold">Shop unavailable</p>
        <button type="button" onClick={goBack} className="h-10 px-4 rounded-xl bg-blue-600 text-white text-sm">
          Go Back
        </button>
      </div>
    );
  }

  const { shop, products, reviews } = data;

  async function contactShop() {
    if (!requireUserOrPrompt()) return;
    if (user?.id === shop.user_id) {
      notify('This is your own shop.', 'info');
      return;
    }
    try {
      const res = await apiFetch<{ conversationId: string }>('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({
          shopId: shop.id,
          message: `Hello ${shop.name}, I would like to inquire about your listings.`,
        }),
      });
      setActiveConversationId(res.conversationId);
      switchTab('messages');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to start conversation', 'error');
    }
  }

  async function shareShop() {
    const url = `${window.location.origin}/?shop=${shop.slug}`;
    await navigator.clipboard?.writeText(url).catch(() => {});
    notify('Shop link copied to clipboard', 'success');
  }

  return (
    <div className="space-y-6 pb-12">
      <button type="button" onClick={goBack} className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white min-h-[44px]">
        <ArrowLeft className="w-4 h-4" />
        <span>Back</span>
      </button>

      {/* Storefront Header */}
      <div className="rounded-2xl overflow-hidden bg-[#0E1525] border border-slate-800">
        <div className="h-36 sm:h-48 w-full bg-[#131C31] relative overflow-hidden">
          <ImageWithFallback
            src={shop.banner_url || '/src/assets/images/banner_digital_craft_1795188642758.jpg'}
            alt={shop.name}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#0E1525] via-[#0E1525]/35 to-transparent" />
        </div>

        <div className="p-5 sm:p-6 -mt-10 relative flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="flex items-end gap-4">
            <div className="w-20 h-20 rounded-2xl overflow-hidden bg-[#070B14] border-2 border-slate-800 flex items-center justify-center shrink-0">
              {shop.logo_url ? (
                <ImageWithFallback src={shop.logo_url} alt={shop.name} className="w-full h-full object-cover" />
              ) : (
                <Store className="w-8 h-8 text-blue-400" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl sm:text-2xl font-bold text-white">{shop.name}</h1>
                {shop.verification_status === 'verified' && (
                  <ShieldCheck className="w-5 h-5 text-blue-400 shrink-0" aria-label="Verified Shop" />
                )}
              </div>
              <div className="text-xs text-slate-400 mt-1">
                {shop.country_name || shop.country_code} · {products.length} active listings ·{' '}
                {shop.review_count > 0 ? `${shop.rating_avg}/5 (${shop.review_count} reviews)` : 'No reviews yet'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={contactShop}
              className="h-11 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold flex items-center gap-2 whitespace-nowrap"
            >
              <MessageSquare className="w-4 h-4" />
              <span>Contact Seller</span>
            </button>
            <button
              type="button"
              onClick={shareShop}
              className="h-11 px-4 rounded-xl bg-[#131C31] border border-slate-700 text-slate-200 text-sm font-medium flex items-center gap-2 whitespace-nowrap"
            >
              <Share2 className="w-4 h-4" />
              <span>Share</span>
            </button>
          </div>
        </div>

        <div className="px-5 sm:px-6 pb-6 pt-2 grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-slate-800/80 text-sm">
          <div>
            <div className="text-xs text-slate-400">About Shop</div>
            <p className="mt-1 text-slate-300">{shop.description || 'Global SOFUMER storefront.'}</p>
          </div>
          <div>
            <div className="text-xs text-slate-400">Shipping Policy</div>
            <p className="mt-1 text-slate-300">{shop.shipping_policy}</p>
          </div>
          <div>
            <div className="text-xs text-slate-400">Return Policy</div>
            <p className="mt-1 text-slate-300">{shop.return_policy}</p>
          </div>
        </div>
      </div>

      {/* Listings */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-white">Active Listings</h2>
        {products.length === 0 ? (
          <div className="p-8 rounded-2xl bg-[#0E1525] border border-slate-800 text-center text-sm text-slate-400">
            This shop has not published any active listings yet.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 sm:gap-4">
            {products.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        )}
      </section>

      {/* Shop Reviews */}
      {reviews.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-white">Verified Shop Reviews</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {reviews.map((r) => (
              <div key={r.id} className="p-4 rounded-xl bg-[#0E1525] border border-slate-800 space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="font-semibold text-white">{r.reviewer_name} · {r.product_title}</span>
                  <span className="text-amber-400 font-mono-nums">{r.rating}/5</span>
                </div>
                <p className="text-sm text-slate-300">{r.comment}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
