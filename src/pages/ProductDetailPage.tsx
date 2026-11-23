import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  ChevronLeft,
  ChevronRight,
  Flag,
  Heart,
  MessageSquare,
  Play,
  Share2,
  ShieldAlert,
  Star,
  Store,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import { optimizeCloudinaryUrl } from '../lib/cloudinary';
import { formatMoney, t } from '../lib/i18n';
import type { Product, ProductMedia, Shop } from '../types';
import { ImageWithFallback } from '../components/ImageWithFallback';

interface ProductDetailPayload {
  product: Product;
  images: Array<{ id: string; url: string; alt_text: string }>;
  media?: ProductMedia[];
  videos?: ProductMedia[];
  variants: Array<{ id: string; name: string; price_delta: number }>;
  reviews: Array<{
    id: string;
    rating: number;
    comment: string;
    reviewer_name: string;
    created_at: string;
  }>;
  shop: Shop;
}

export function ProductDetailPage({ productId }: { productId: string }) {
  const {
    user,
    currencies,
    displayCurrency,
    language,
    favoriteIds,
    toggleFavorite,
    navigate,
    goBack,
    switchTab,
    requireUserOrPrompt,
    setActiveConversationId,
    setAiInitialPrompt,
    notify,
  } = useApp();

  const [detail, setDetail] = useState<ProductDetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedImage, setSelectedImage] = useState(0);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('Misleading information');
  const [reportDetails, setReportDetails] = useState('');
  const [contactBusy, setContactBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    apiFetch<ProductDetailPayload>(`/api/marketplace/products/${productId}`)
      .then((res) => {
        if (mounted) {
          setDetail(res);
          setSelectedImage(0);
        }
      })
      .catch((err) => {
        notify(err instanceof Error ? err.message : 'Failed to load listing', 'error');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [productId, notify]);

  if (loading) {
    return <div className="p-8 rounded-2xl bg-[#0E1525] border border-slate-800 animate-pulse h-96" />;
  }

  if (!detail) {
    return (
      <div className="p-8 rounded-2xl bg-[#0E1525] border border-slate-800 text-center space-y-3">
        <p className="text-base font-semibold text-white">Listing unavailable</p>
        <button
          type="button"
          onClick={goBack}
          className="h-10 px-4 rounded-xl bg-blue-600 text-white text-sm font-medium"
        >
          Go Back
        </button>
      </div>
    );
  }

  const { product, images, media, reviews, shop } = detail;
  const priceInfo = formatMoney(product.price, product.currency, displayCurrency, currencies);
  const isFav = favoriteIds.has(product.id);
  const isOwnListing = user?.id === product.seller_user_id;

  let faqs: Array<{ question: string; answer: string }> = [];
  try {
    faqs = JSON.parse(product.faqs_json || '[]');
  } catch {
    faqs = [];
  }

  async function handleContactSeller() {
    if (!requireUserOrPrompt()) return;
    if (isOwnListing) {
      notify('This is your own listing.', 'info');
      return;
    }
    setContactBusy(true);
    try {
      const res = await apiFetch<{ conversationId: string }>('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({
          productId: product.id,
          message: `Hello, I am interested in "${product.title}". Is it available and what are the delivery terms?`,
        }),
      });
      setActiveConversationId(res.conversationId);
      switchTab('messages');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to start conversation', 'error');
    } finally {
      setContactBusy(false);
    }
  }

  async function handleShare() {
    const shareUrl = `${window.location.origin}/?product=${product.id}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: product.title, text: `Check out ${product.title} on SOFUMER`, url: shareUrl });
        return;
      } catch {
        // Fallback to clipboard
      }
    }
    await navigator.clipboard?.writeText(shareUrl).catch(() => {});
    notify('Listing link copied to clipboard', 'success');
  }

  async function submitReport(e: React.FormEvent) {
    e.preventDefault();
    if (!requireUserOrPrompt()) return;
    try {
      await apiFetch('/api/marketplace/reports', {
        method: 'POST',
        body: JSON.stringify({
          targetType: 'product',
          targetId: product.id,
          reason: reportReason,
          details: reportDetails,
        }),
      });
      setReportOpen(false);
      setReportDetails('');
      notify('Listing reported for human moderation review.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Report failed', 'error');
    }
  }

  const normalizedMedia: Array<{
    id: string;
    mediaType: 'image' | 'video';
    url: string;
    altText: string;
    duration: number | null;
  }> =
    media && media.length > 0
      ? [...media]
          .sort((a, b) => {
            if (a.media_type !== b.media_type) return a.media_type === 'image' ? -1 : 1;
            if (a.media_type === 'image' && Number(b.is_primary) !== Number(a.is_primary)) {
              return Number(b.is_primary) - Number(a.is_primary);
            }
            return Number(a.sort_order) - Number(b.sort_order);
          })
          .map((m) => ({
            id: m.id,
            mediaType: m.media_type,
            url: m.secure_url,
            altText: m.alt_text || product.title,
            duration: m.duration ?? null,
          }))
      : images.map((img) => ({
          id: img.id,
          mediaType: 'image' as const,
          url: img.url,
          altText: img.alt_text || product.title,
          duration: null,
        }));

  const gallery =
    normalizedMedia.length > 0
      ? normalizedMedia
      : [{ id: 'empty', mediaType: 'image' as const, url: '', altText: product.title, duration: null }];

  const activeIdx = Math.min(selectedImage, gallery.length - 1);
  const currentMedia = gallery[activeIdx];

  return (
    <div className="space-y-6 pb-20">
      <button
        type="button"
        onClick={goBack}
        className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white min-h-[44px]"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back</span>
      </button>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Gallery */}
        <div className="lg:col-span-7 space-y-3">
          <div className="relative aspect-[4/3] rounded-2xl overflow-hidden bg-[#0E1525] border border-slate-800">
            {currentMedia.mediaType === 'video' ? (
              <video
                key={currentMedia.id}
                src={optimizeCloudinaryUrl(currentMedia.url, 'video') || currentMedia.url}
                poster={optimizeCloudinaryUrl(currentMedia.url, 'poster', 960) || undefined}
                controls
                playsInline
                preload="metadata"
                className="w-full h-full object-contain bg-black"
              />
            ) : (
              <ImageWithFallback
                src={currentMedia.url}
                alt={currentMedia.altText || product.title}
                fallbackLabel={product.category_name}
                transformMode="gallery"
                transformWidth={1200}
                className="w-full h-full object-cover"
              />
            )}

            {gallery.length > 1 && (
              <>
                <div className="pointer-events-none absolute top-3 right-3 px-2.5 py-1 rounded-lg bg-[#070B14]/75 border border-slate-700/70 text-[11px] font-mono-nums text-slate-100">
                  {activeIdx + 1} / {gallery.length}
                </div>
                <button
                  type="button"
                  aria-label="Previous media"
                  onClick={() => setSelectedImage((prev) => (prev - 1 + gallery.length) % gallery.length)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-[#070B14]/75 border border-slate-700/70 text-white flex items-center justify-center hover:bg-[#070B14]"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  aria-label="Next media"
                  onClick={() => setSelectedImage((prev) => (prev + 1) % gallery.length)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-[#070B14]/75 border border-slate-700/70 text-white flex items-center justify-center hover:bg-[#070B14]"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </>
            )}

            {currentMedia.mediaType === 'video' && currentMedia.duration !== null && (
              <span className="pointer-events-none absolute top-3 left-3 px-2 py-0.5 rounded-lg bg-[#070B14]/80 border border-slate-700/70 text-[11px] font-mono-nums text-slate-100">
                {Number(currentMedia.duration).toFixed(1)}s
              </span>
            )}
          </div>

          {gallery.length > 1 && (
            <div className="flex gap-2.5 overflow-x-auto pb-1">
              {gallery.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedImage(idx)}
                  className={`relative w-20 h-16 rounded-xl overflow-hidden border shrink-0 bg-[#0A101D] ${
                    activeIdx === idx ? 'border-blue-500' : 'border-slate-800 opacity-75 hover:opacity-100'
                  }`}
                >
                  {item.mediaType === 'video' ? (
                    <>
                      <ImageWithFallback
                        src={optimizeCloudinaryUrl(item.url, 'poster', 240)}
                        alt={`Video preview ${idx + 1}`}
                        transformMode="none"
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center">
                        <Play className="w-4 h-4 text-white fill-white" />
                        {item.duration !== null && (
                          <span className="text-[10px] font-mono-nums text-white mt-0.5">
                            {Number(item.duration).toFixed(0)}s
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <ImageWithFallback
                      src={item.url}
                      alt={item.altText}
                      transformMode="thumb"
                      transformWidth={240}
                      className="w-full h-full object-cover"
                    />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Contiguous Purchase / Inquiry Module */}
        <div className="lg:col-span-5 bg-[#0E1525] border border-slate-800 rounded-2xl p-5 sm:p-6 space-y-5">
          <div>
            <div className="text-xs text-slate-400">
              {product.listing_type.toUpperCase()} · {product.category_name}
              {product.subcategory_name ? ` / ${product.subcategory_name}` : ''}
              {product.listing_type === 'physical' && product.condition !== 'not_applicable'
                ? ` · Condition: ${product.condition.replace('_', ' ')}`
                : ''}
            </div>
            <h1 className="mt-1.5 text-xl sm:text-2xl font-bold text-white leading-snug">
              {product.title}
            </h1>
            <div className="mt-3 flex items-baseline gap-3">
              <span className="text-2xl font-bold text-white font-mono-nums">
                {priceInfo.formatted}
              </span>
              {priceInfo.converted && (
                <span className="text-xs text-slate-400 font-mono-nums">
                  Original: {priceInfo.originalFormatted}
                </span>
              )}
            </div>
          </div>

          {/* Availability & Delivery Specs */}
          <div className="pt-4 border-t border-slate-800 space-y-2 text-xs sm:text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-slate-400">Availability</span>
              <span className="text-slate-100 font-medium font-mono-nums">
                {product.listing_type === 'digital'
                  ? 'Digital Delivery'
                  : product.listing_type === 'service'
                  ? `Service (${product.service_mode})`
                  : `${product.stock_quantity ?? 1} in stock`}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-slate-400">Seller Location</span>
              <span className="text-slate-100">
                {product.location_text ? `${product.location_text}, ` : ''}
                {product.country_name || product.country_code}
              </span>
            </div>
            {product.listing_type === 'physical' && (
              <div className="flex justify-between gap-4">
                <span className="text-slate-400">Shipping</span>
                <span className="text-slate-100 text-right">
                  {product.international_shipping ? 'International shipping available' : 'Domestic / Direct arrangement'}
                </span>
              </div>
            )}
            {product.listing_type === 'digital' && (
              <>
                <div className="flex justify-between gap-4">
                  <span className="text-slate-400">Format & License</span>
                  <span className="text-slate-100 text-right">
                    {product.file_format || 'Standard digital'} · {product.license_info || 'Standard license'}
                  </span>
                </div>
                {Boolean(product.has_digital_package) && (
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-400">Protected Delivery</span>
                    <span className="text-emerald-300 font-medium text-right">
                      Verified Order Delivery Unlocked After Confirmation
                    </span>
                  </div>
                )}
              </>
            )}
            {product.listing_type === 'service' && (
              <div className="flex justify-between gap-4">
                <span className="text-slate-400">Delivery Timeframe</span>
                <span className="text-slate-100 text-right">
                  {product.delivery_timeframe || 'Confirmed on inquiry'} ({product.pricing_model})
                </span>
              </div>
            )}
          </div>

          {/* Primary Actions */}
          <div className="space-y-2.5 pt-2">
            <button
              type="button"
              onClick={handleContactSeller}
              disabled={contactBusy}
              className="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
            >
              <MessageSquare className="w-4 h-4" />
              <span>{contactBusy ? 'Opening Conversation...' : 'Contact Seller'}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setAiInitialPrompt(`Tell me about the listing "${product.title}" (ID: ${product.id}) and whether it fits international buyers.`);
                switchTab('ai');
              }}
              className="w-full h-11 rounded-xl bg-[#131C31] hover:bg-[#19233D] border border-purple-700/40 text-slate-100 text-sm font-medium flex items-center justify-center gap-2 transition-colors"
            >
              <Bot className="w-4 h-4 text-purple-400" />
              <span>Ask AI About This Product</span>
            </button>

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => toggleFavorite(product.id)}
                className="h-11 rounded-xl bg-[#070B14] border border-slate-800 hover:border-slate-700 text-xs font-medium text-slate-200 flex items-center justify-center gap-1.5"
              >
                <Heart className={`w-4 h-4 ${isFav ? 'fill-blue-500 text-blue-500' : ''}`} />
                <span>{isFav ? 'Saved' : 'Wishlist'}</span>
              </button>
              <button
                type="button"
                onClick={handleShare}
                className="h-11 rounded-xl bg-[#070B14] border border-slate-800 hover:border-slate-700 text-xs font-medium text-slate-200 flex items-center justify-center gap-1.5"
              >
                <Share2 className="w-4 h-4" />
                <span>Share</span>
              </button>
              <button
                type="button"
                onClick={() => setReportOpen((v) => !v)}
                className="h-11 rounded-xl bg-[#070B14] border border-slate-800 hover:border-red-800/70 text-xs font-medium text-slate-300 flex items-center justify-center gap-1.5"
              >
                <Flag className="w-4 h-4" />
                <span>Report</span>
              </button>
            </div>
          </div>

          {/* Direct Transaction Explanation */}
          <div className="p-3.5 rounded-xl bg-[#070B14] border border-slate-800/90 flex gap-2.5 text-xs text-slate-400 leading-relaxed">
            <ShieldAlert className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <span>{t(language, 'directNotice')}</span>
          </div>

          {/* Shop Summary Link */}
          {shop && (
            <button
              type="button"
              onClick={() => navigate({ type: 'shop', slug: shop.slug })}
              className="w-full p-3.5 rounded-xl bg-[#070B14] border border-slate-800 hover:border-slate-700 flex items-center justify-between gap-3 text-left"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-lg bg-[#131C31] overflow-hidden shrink-0 flex items-center justify-center">
                  {shop.logo_url ? (
                    <ImageWithFallback src={shop.logo_url} alt={shop.name} className="w-full h-full object-cover" />
                  ) : (
                    <Store className="w-4 h-4 text-blue-400" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white truncate">{shop.name}</div>
                  <div className="text-xs text-slate-400">
                    {shop.country_name || shop.country_code}
                    {shop.verification_status === 'verified' ? ' · Verified Shop' : ''}
                  </div>
                </div>
              </div>
              <span className="text-xs text-blue-400 font-medium whitespace-nowrap">Visit Shop</span>
            </button>
          )}
        </div>
      </div>

      {/* Report Drawer */}
      {reportOpen && (
        <form onSubmit={submitReport} className="p-5 rounded-2xl bg-[#0E1525] border border-red-900/50 space-y-3">
          <h3 className="text-sm font-semibold text-white">Report Listing for Moderation Review</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              className="h-10 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
            >
              <option>Misleading information</option>
              <option>Prohibited or counterfeit item</option>
              <option>Suspected fraud or scam</option>
              <option>Intellectual property violation</option>
            </select>
            <input
              type="text"
              placeholder="Additional context for moderators..."
              value={reportDetails}
              onChange={(e) => setReportDetails(e.target.value)}
              className="h-10 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="h-10 px-4 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold">
              Submit Report
            </button>
            <button type="button" onClick={() => setReportOpen(false)} className="h-10 px-4 rounded-xl bg-slate-800 text-slate-300 text-xs">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Full Description, Delivery, Return Policy, FAQs & Reviews */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 space-y-6 bg-[#0E1525] border border-slate-800 rounded-2xl p-6">
          <div>
            <h2 className="text-base font-semibold text-white">Description</h2>
            <p className="mt-2 text-sm text-slate-300 whitespace-pre-line leading-relaxed">
              {product.description}
            </p>
          </div>

          {product.shipping_info && (
            <div className="pt-4 border-t border-slate-800">
              <h3 className="text-sm font-semibold text-white">Shipping & Fulfillment</h3>
              <p className="mt-1 text-sm text-slate-300">{product.shipping_info}</p>
            </div>
          )}

          {product.digital_delivery_method && (
            <div className="pt-4 border-t border-slate-800">
              <h3 className="text-sm font-semibold text-white">Digital Delivery Information</h3>
              <p className="mt-1 text-sm text-slate-300">{product.digital_delivery_method}</p>
            </div>
          )}

          <div className="pt-4 border-t border-slate-800">
            <h3 className="text-sm font-semibold text-white">Seller Return Policy</h3>
            <p className="mt-1 text-sm text-slate-300">
              {product.return_policy || shop?.return_policy || 'Arranged directly with seller prior to order confirmation.'}
            </p>
          </div>

          {faqs.length > 0 && (
            <div className="pt-4 border-t border-slate-800 space-y-3">
              <h3 className="text-sm font-semibold text-white">Frequently Asked Questions</h3>
              {faqs.map((f, i) => (
                <div key={i} className="p-3.5 rounded-xl bg-[#070B14] border border-slate-800/80">
                  <div className="text-sm font-medium text-white">{f.question}</div>
                  <div className="mt-1 text-xs text-slate-400">{f.answer}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-5 bg-[#0E1525] border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-white">Verified Transaction Reviews</h2>
            <span className="text-xs text-slate-400 font-mono-nums">
              {reviews.length} reviews
            </span>
          </div>
          {reviews.length === 0 ? (
            <p className="text-sm text-slate-400">
              No verified reviews yet. Buyers can submit reviews after completing a recorded order.
            </p>
          ) : (
            <div className="space-y-3">
              {reviews.map((rev) => (
                <div key={rev.id} className="p-3.5 rounded-xl bg-[#070B14] border border-slate-800/80 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">{rev.reviewer_name}</span>
                    <span className="flex items-center gap-1 text-xs text-amber-400 font-mono-nums">
                      <Star className="w-3.5 h-3.5 fill-amber-400" />
                      {rev.rating}/5
                    </span>
                  </div>
                  <p className="text-xs text-slate-300">{rev.comment}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
