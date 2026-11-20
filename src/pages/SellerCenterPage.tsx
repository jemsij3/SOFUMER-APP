import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Eye,
  ImagePlus,
  Package,
  Plus,
  Store,
  Trash2,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import type { Product, Shop } from '../types';
import { ImageWithFallback } from '../components/ImageWithFallback';

type SellerModule =
  | 'dashboard'
  | 'my_shop'
  | 'products'
  | 'add_product'
  | 'orders'
  | 'analytics'
  | 'promotions'
  | 'plans'
  | 'settings';

interface SellerDashboardData {
  shop: Shop;
  subscription: {
    plan_code: string;
    plan_name: string;
    max_products: number;
    ai_daily_limit: number;
    featured_slots: number;
    promotional_discount_pct: number;
    billing_cycle: string;
  } | null;
  stats: {
    total_products: number;
    published_products: number;
    draft_products: number;
    total_views: number;
    total_favorites: number;
    total_inquiries: number;
    total_orders: number;
    active_orders: number;
  };
  promotions: Array<{
    id: string;
    title: string;
    promo_type: string;
    price_amount: number;
    duration_days: number;
    status: string;
    product_title?: string;
  }>;
  verifications: Array<{
    id: string;
    document_type: string;
    status: string;
    review_notes: string;
    created_at: string;
  }>;
}

export function SellerCenterPage({ initialSection }: { initialSection?: string }) {
  const {
    user,
    sellerProfile,
    categories,
    subcategories,
    countries,
    currencies,
    plans,
    goBack,
    navigate,
    switchTab,
    refreshSession,
    requireUserOrPrompt,
    notify,
  } = useApp();

  const [module, setModule] = useState<SellerModule>(
    (initialSection as SellerModule) || 'dashboard'
  );
  const [dash, setDash] = useState<SellerDashboardData | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  // Registration form state
  const [sellerType, setSellerType] = useState<'individual' | 'business'>('individual');
  const [legalName, setLegalName] = useState(user?.display_name || '');
  const [shopName, setShopName] = useState('');
  const [regCountry, setRegCountry] = useState(user?.country_code || 'US');
  const [regDesc, setRegDesc] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regBusy, setRegBusy] = useState(false);

  // Add Product form state
  const [listingType, setListingType] = useState<'physical' | 'digital' | 'service'>('physical');
  const [pTitle, setPTitle] = useState('');
  const [pDesc, setPDesc] = useState('');
  const [pCat, setPCat] = useState(categories[0]?.id || 'cat_electronics');
  const [pSubCat, setPSubCat] = useState('');
  const [pPrice, setPPrice] = useState('');
  const [pCurrency, setPCurrency] = useState('USD');
  const [pCondition, setPCondition] = useState('new');
  const [pStock, setPStock] = useState('10');
  const [pShipping, setPShipping] = useState('');
  const [pIntlShipping, setPIntlShipping] = useState(true);
  const [pLocation, setPLocation] = useState('');
  const [pFileFormat, setPFileFormat] = useState('');
  const [pDigitalDelivery, setPDigitalDelivery] = useState('');
  const [pLicense, setPLicense] = useState('');
  const [pPricingModel, setPPricingModel] = useState('fixed');
  const [pServiceMode, setPServiceMode] = useState('remote');
  const [pTimeframe, setPTimeframe] = useState('');
  const [pReturnPolicy, setPReturnPolicy] = useState('');
  const [pKeywords, setPKeywords] = useState('');
  const [pImages, setPImages] = useState<string[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);

  // Shop Edit & Verification
  const [editShopName, setEditShopName] = useState('');
  const [editShopDesc, setEditShopDesc] = useState('');
  const [editReturnPolicy, setEditReturnPolicy] = useState('');
  const [editShippingPolicy, setEditShippingPolicy] = useState('');
  const [editLogo, setEditLogo] = useState('');
  const [editBanner, setEditBanner] = useState('');
  const [verDocType, setVerDocType] = useState('Business Registration / National ID');
  const [verDocRef, setVerDocRef] = useState('');

  // Promotion Form
  const [promoType, setPromoType] = useState('featured_product');
  const [promoProductId, setPromoProductId] = useState('');
  const [promoTitle, setPromoTitle] = useState('');
  const [promoDays, setPromoDays] = useState('7');

  // AI Analytics explanation
  const [analyticsInsight, setAnalyticsInsight] = useState('');

  const loadSellerData = useCallback(async () => {
    if (!user || !sellerProfile) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [d, p] = await Promise.all([
        apiFetch<SellerDashboardData>('/api/seller/dashboard'),
        apiFetch<{ products: Product[] }>('/api/seller/products'),
      ]);
      setDash(d);
      setProducts(p.products);
      setEditShopName(d.shop.name);
      setEditShopDesc(d.shop.description);
      setEditReturnPolicy(d.shop.return_policy);
      setEditShippingPolicy(d.shop.shipping_policy);
      setEditLogo(d.shop.logo_url);
      setEditBanner(d.shop.banner_url);
      setPCurrency(d.shop.default_currency || 'USD');
    } catch {
      // Handled
    } finally {
      setLoading(false);
    }
  }, [user, sellerProfile]);

  useEffect(() => {
    loadSellerData();
  }, [loadSellerData]);

  if (!user) {
    return (
      <div className="p-8 rounded-2xl bg-[#0E1525] border border-slate-800 text-center space-y-3">
        <Store className="w-8 h-8 text-blue-400 mx-auto" />
        <h1 className="text-lg font-semibold text-white">SOFUMER Seller Center</h1>
        <p className="text-sm text-slate-400">Connect with Telegram to open a storefront and publish listings.</p>
        <button type="button" onClick={() => requireUserOrPrompt()} className="h-11 px-5 rounded-xl bg-blue-600 text-white text-sm font-semibold">
          Connect Account
        </button>
      </div>
    );
  }

  async function handleRegisterSeller(e: React.FormEvent) {
    e.preventDefault();
    setRegBusy(true);
    try {
      await apiFetch('/api/seller/register', {
        method: 'POST',
        body: JSON.stringify({
          sellerType,
          legalName,
          shopName,
          countryCode: regCountry,
          description: regDesc,
          contactEmail: regEmail,
          contactPhone: regPhone,
        }),
      });
      await refreshSession();
      notify('Seller profile and storefront created!', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Seller registration failed', 'error');
    } finally {
      setRegBusy(false);
    }
  }

  // Show Seller Registration Form if user is not yet a seller
  if (!sellerProfile) {
    return (
      <div className="max-w-2xl mx-auto space-y-6 pb-12">
        <button type="button" onClick={goBack} className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white min-h-[44px]">
          <ArrowLeft className="w-4 h-4" />
          <span>Back</span>
        </button>

        <form onSubmit={handleRegisterSeller} className="p-6 sm:p-8 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-5">
          <div>
            <h1 className="text-xl font-bold text-white">Open Your SOFUMER Storefront</h1>
            <p className="mt-1 text-sm text-slate-400">
              Sell physical products, digital goods, software licenses, or professional services directly to global buyers.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            {(['individual', 'business'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setSellerType(t)}
                className={`h-11 rounded-xl border text-sm font-medium capitalize ${
                  sellerType === t
                    ? 'bg-blue-600/20 border-blue-500 text-white'
                    : 'bg-[#070B14] border-slate-800 text-slate-400'
                }`}
              >
                {t} Seller
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Seller / Business Legal Name</label>
              <input
                type="text"
                required
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Public Shop Name</label>
              <input
                type="text"
                required
                value={shopName}
                onChange={(e) => setShopName(e.target.value)}
                placeholder="e.g. Nordic Precision Studio"
                className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Country</label>
              <select
                value={regCountry}
                onChange={(e) => setRegCountry(e.target.value)}
                className="w-full h-11 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
              >
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name} ({c.code})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Contact Phone (Optional)</label>
              <input
                type="tel"
                value={regPhone}
                onChange={(e) => setRegPhone(e.target.value)}
                placeholder="+1 555 0100"
                className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1">Contact Email (Optional)</label>
            <input
              type="email"
              value={regEmail}
              onChange={(e) => setRegEmail(e.target.value)}
              className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1">Shop Description</label>
            <textarea
              rows={3}
              value={regDesc}
              onChange={(e) => setRegDesc(e.target.value)}
              placeholder="Describe what you sell and your shipping or service delivery standards..."
              className="w-full p-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
            />
          </div>

          <button
            type="submit"
            disabled={regBusy}
            className="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors disabled:opacity-60"
          >
            {regBusy ? 'Creating Storefront...' : 'Create Seller Account & Shop'}
          </button>
        </form>
      </div>
    );
  }

  async function uploadImage(file: File): Promise<string> {
    const fd = new FormData();
    fd.append('file', file);
    const res = await apiFetch<{ url: string }>('/api/uploads', { method: 'POST', body: fd });
    return res.url;
  }

  async function handleProductImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []).slice(0, 6 - pImages.length);
    for (const f of files) {
      try {
        const url = await uploadImage(f);
        setPImages((prev) => [...prev, url]);
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Upload failed', 'error');
      }
    }
    e.target.value = '';
  }

  async function handleAiDraft() {
    if (!pTitle.trim() && !pDesc.trim()) {
      notify('Enter a rough title or notes first so AI can draft your listing for review.', 'info');
      return;
    }
    setAiBusy(true);
    try {
      const res = await apiFetch<{
        suggestedTitle: string;
        improvedDescription: string;
        suggestedCategoryId: string;
        keywords: string[];
      }>('/api/ai/seller/assist', {
        method: 'POST',
        body: JSON.stringify({
          action: 'generate_listing',
          title: pTitle,
          notes: pDesc,
          listingType,
        }),
      });
      if (res.suggestedTitle) setPTitle(res.suggestedTitle);
      if (res.improvedDescription) setPDesc(res.improvedDescription);
      if (res.suggestedCategoryId && categories.some((c) => c.id === res.suggestedCategoryId)) {
        setPCat(res.suggestedCategoryId);
      }
      if (Array.isArray(res.keywords)) setPKeywords(res.keywords.join(', '));
      notify('AI draft populated — please review carefully before publishing.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'AI assist failed', 'error');
    } finally {
      setAiBusy(false);
    }
  }

  async function submitProduct(publishStatus: 'draft' | 'published') {
    try {
      const res = await apiFetch<{ product: Product; moderationNotes?: string }>('/api/seller/products', {
        method: 'POST',
        body: JSON.stringify({
          listingType,
          title: pTitle,
          description: pDesc,
          categoryId: pCat,
          subcategoryId: pSubCat || null,
          price: Number(pPrice || 0),
          currency: pCurrency,
          condition: pCondition,
          stockQuantity: Number(pStock || 1),
          shippingInfo: pShipping,
          internationalShipping: pIntlShipping,
          locationText: pLocation,
          fileFormat: pFileFormat,
          digitalDeliveryMethod: pDigitalDelivery,
          licenseInfo: pLicense,
          pricingModel: pPricingModel,
          serviceMode: pServiceMode,
          deliveryTimeframe: pTimeframe,
          returnPolicy: pReturnPolicy,
          keywords: pKeywords,
          images: pImages,
          status: publishStatus,
        }),
      });
      notify(
        res.moderationNotes
          ? res.moderationNotes
          : publishStatus === 'published'
          ? 'Listing published!'
          : 'Saved as draft',
        'success'
      );
      setPTitle('');
      setPDesc('');
      setPPrice('');
      setPImages([]);
      setPreviewOpen(false);
      await loadSellerData();
      setModule('products');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save listing', 'error');
    }
  }

  async function deleteProduct(id: string) {
    try {
      await apiFetch(`/api/seller/products/${id}`, { method: 'DELETE' });
      notify('Listing deleted', 'info');
      await loadSellerData();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  }

  async function toggleProductPublish(p: Product) {
    const next = p.status === 'published' ? 'draft' : 'published';
    try {
      await apiFetch(`/api/seller/products/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      });
      notify(`Listing set to ${next}`, 'success');
      await loadSellerData();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Update failed', 'error');
    }
  }

  async function saveShopSettings(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/seller/shop', {
        method: 'PATCH',
        body: JSON.stringify({
          name: editShopName,
          description: editShopDesc,
          returnPolicy: editReturnPolicy,
          shippingPolicy: editShippingPolicy,
          logoUrl: editLogo,
          bannerUrl: editBanner,
        }),
      });
      notify('Shop settings saved', 'success');
      await loadSellerData();
      await refreshSession();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to update shop', 'error');
    }
  }

  async function submitVerification(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiFetch('/api/seller/verification', {
        method: 'POST',
        body: JSON.stringify({ documentType: verDocType, documentReference: verDocRef }),
      });
      setVerDocRef('');
      notify('Verification submitted for admin review', 'success');
      await loadSellerData();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Verification failed', 'error');
    }
  }

  async function createPromotion(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ priceAmount: number }>('/api/seller/promotions', {
        method: 'POST',
        body: JSON.stringify({
          promoType,
          productId: promoProductId || null,
          title: promoTitle,
          durationDays: Number(promoDays || 7),
        }),
      });
      setPromoTitle('');
      notify(`Promotion submitted ($${res.priceAmount} USD) for admin activation`, 'success');
      await loadSellerData();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Promotion failed', 'error');
    }
  }

  async function switchPlan(planCode: string, billingCycle: 'monthly' | 'annual') {
    try {
      await apiFetch('/api/seller/subscriptions', {
        method: 'POST',
        body: JSON.stringify({ planCode, billingCycle }),
      });
      notify(`Subscribed to ${planCode} (${billingCycle})`, 'success');
      await loadSellerData();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Plan change failed', 'error');
    }
  }

  const navItems: Array<{ key: SellerModule; label: string }> = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'my_shop', label: 'My Shop' },
    { key: 'products', label: 'Products' },
    { key: 'add_product', label: 'Add Product' },
    { key: 'orders', label: 'Orders & Inquiries' },
    { key: 'analytics', label: 'Analytics' },
    { key: 'promotions', label: 'Promotions' },
    { key: 'plans', label: 'Plans & Billing' },
    { key: 'settings', label: 'Shop Settings' },
  ];

  const filteredSubcats = subcategories.filter((s) => s.category_id === pCat);

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={goBack} className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl bg-[#0E1525] border border-slate-800 text-slate-300 hover:text-white">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-xl font-bold text-white">Seller Center</h1>
            <p className="text-xs text-slate-400">
              {dash?.shop.name || 'Storefront'} · {dash?.subscription?.plan_name || 'Free Starter'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => switchTab('messages')}
            className="h-10 px-3.5 rounded-xl bg-[#0E1525] border border-slate-800 text-xs font-medium text-slate-200 whitespace-nowrap"
          >
            Messages
          </button>
          {dash?.shop && (
            <button
              type="button"
              onClick={() => navigate({ type: 'shop', slug: dash.shop.slug })}
              className="h-10 px-3.5 rounded-xl bg-[#131C31] border border-slate-700 text-xs font-medium text-blue-300 whitespace-nowrap"
            >
              Public Storefront
            </button>
          )}
          <button
            type="button"
            onClick={() => setModule('add_product')}
            className="h-10 px-4 rounded-xl bg-blue-600 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>Add Listing</span>
          </button>
        </div>
      </div>

      {/* Horizontal Module Navigation */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {navItems.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setModule(item.key)}
            className={`h-9 px-3.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
              module === item.key
                ? 'bg-blue-600 text-white'
                : 'bg-[#0E1525] border border-slate-800 text-slate-300 hover:text-white'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="h-48 rounded-2xl bg-[#0E1525] border border-slate-800 animate-pulse" />
      ) : (
        <>
          {module === 'dashboard' && dash && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
              {[
                { label: 'Published Listings', val: `${dash.stats.published_products} / ${dash.subscription?.max_products ?? 10}` },
                { label: 'Total Views', val: dash.stats.total_views },
                { label: 'Total Inquiries', val: dash.stats.total_inquiries },
                { label: 'Active Orders', val: dash.stats.active_orders },
              ].map((kpi) => (
                <div key={kpi.label} className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800">
                  <div className="text-xs text-slate-400">{kpi.label}</div>
                  <div className="mt-1.5 text-2xl font-bold text-white font-mono-nums">{kpi.val}</div>
                </div>
              ))}
            </div>
          )}

          {module === 'my_shop' && dash && (
            <div className="p-6 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-white">{dash.shop.name}</h2>
                  <p className="text-xs text-slate-400">
                    Slug: /shop/{dash.shop.slug} · Verification: {dash.shop.verification_status}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate({ type: 'shop', slug: dash.shop.slug })}
                  className="h-10 px-4 rounded-xl bg-blue-600 text-white text-xs font-semibold"
                >
                  Open Live Storefront
                </button>
              </div>
              <p className="text-sm text-slate-300">{dash.shop.description || 'No shop description set yet.'}</p>
            </div>
          )}

          {module === 'products' && (
            <div className="space-y-3">
              {products.length === 0 ? (
                <div className="p-8 rounded-2xl bg-[#0E1525] border border-slate-800 text-center space-y-3">
                  <Package className="w-8 h-8 text-blue-400 mx-auto" />
                  <p className="text-sm text-white font-medium">No products or services yet</p>
                  <button
                    type="button"
                    onClick={() => setModule('add_product')}
                    className="h-10 px-4 rounded-xl bg-blue-600 text-white text-xs font-semibold"
                  >
                    Create First Listing
                  </button>
                </div>
              ) : (
                products.map((p) => (
                  <div key={p.id} className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="w-16 h-12 rounded-xl overflow-hidden bg-[#070B14] shrink-0">
                        <ImageWithFallback src={p.primary_image} alt={p.title} className="w-full h-full object-cover" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-white truncate">{p.title}</div>
                        <div className="text-xs text-slate-400 font-mono-nums">
                          {p.listing_type} · {p.currency} {p.price} · Status: {p.status} · Views: {p.view_count}
                        </div>
                        {p.moderation_notes && (
                          <div className="text-[11px] text-amber-300 mt-0.5">{p.moderation_notes}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => navigate({ type: 'product', productId: p.id })}
                        className="h-9 px-3 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-slate-200"
                      >
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleProductPublish(p)}
                        className="h-9 px-3 rounded-lg bg-[#131C31] border border-slate-700 text-xs text-blue-300"
                      >
                        {p.status === 'published' ? 'Unpublish' : 'Publish'}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteProduct(p.id)}
                        aria-label="Delete listing"
                        className="h-9 w-9 rounded-lg bg-[#070B14] border border-slate-800 text-red-400 flex items-center justify-center"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {module === 'add_product' && (
            <div className="p-5 sm:p-6 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-white">Publish New Listing</h2>
                <button
                  type="button"
                  onClick={handleAiDraft}
                  disabled={aiBusy}
                  className="h-10 px-4 rounded-xl bg-[#131C31] border border-purple-700/40 text-purple-200 text-xs font-medium flex items-center gap-2"
                >
                  <Bot className="w-4 h-4" />
                  <span>{aiBusy ? 'Generating Draft...' : 'AI Draft & Keywords'}</span>
                </button>
              </div>

              {/* Listing Type Selector */}
              <div className="grid grid-cols-3 gap-2">
                {(['physical', 'digital', 'service'] as const).map((lt) => (
                  <button
                    key={lt}
                    type="button"
                    onClick={() => setListingType(lt)}
                    className={`h-11 rounded-xl border text-xs sm:text-sm font-medium capitalize ${
                      listingType === lt
                        ? 'bg-blue-600 border-blue-500 text-white'
                        : 'bg-[#070B14] border-slate-800 text-slate-300'
                    }`}
                  >
                    {lt === 'physical' ? 'Physical Product' : lt === 'digital' ? 'Digital Product' : 'Service'}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="sm:col-span-2">
                  <label className="block text-xs text-slate-400 mb-1">Title</label>
                  <input
                    type="text"
                    value={pTitle}
                    onChange={(e) => setPTitle(e.target.value)}
                    placeholder="Clear, accurate product or service title"
                    className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Category</label>
                  <select
                    value={pCat}
                    onChange={(e) => {
                      setPCat(e.target.value);
                      setPSubCat('');
                    }}
                    className="w-full h-11 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Subcategory</label>
                  <select
                    value={pSubCat}
                    onChange={(e) => setPSubCat(e.target.value)}
                    className="w-full h-11 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
                  >
                    <option value="">None</option>
                    {filteredSubcats.map((sc) => (
                      <option key={sc.id} value={sc.id}>{sc.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Price</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={pPrice}
                    onChange={(e) => setPPrice(e.target.value)}
                    placeholder="0.00"
                    className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white font-mono-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Original Listing Currency</label>
                  <select
                    value={pCurrency}
                    onChange={(e) => setPCurrency(e.target.value)}
                    className="w-full h-11 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
                  >
                    {currencies.map((cur) => (
                      <option key={cur.code} value={cur.code}>{cur.code} — {cur.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Description</label>
                <textarea
                  rows={4}
                  value={pDesc}
                  onChange={(e) => setPDesc(e.target.value)}
                  placeholder="Detailed specifications, scope, what is included..."
                  className="w-full p-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white"
                />
              </div>

              {/* Type-Specific Fields */}
              {listingType === 'physical' && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Condition</label>
                    <select value={pCondition} onChange={(e) => setPCondition(e.target.value)} className="w-full h-11 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white">
                      <option value="new">New</option>
                      <option value="like_new">Like New</option>
                      <option value="refurbished">Refurbished</option>
                      <option value="used">Used</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Stock Quantity</label>
                    <input type="number" min="0" value={pStock} onChange={(e) => setPStock(e.target.value)} className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white font-mono-nums" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">City / Location</label>
                    <input type="text" value={pLocation} onChange={(e) => setPLocation(e.target.value)} placeholder="e.g. Berlin" className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs text-slate-400 mb-1">Shipping Information</label>
                    <input type="text" value={pShipping} onChange={(e) => setPShipping(e.target.value)} placeholder="DHL / FedEx / Local courier details" className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-slate-300 pt-6">
                    <input type="checkbox" checked={pIntlShipping} onChange={(e) => setPIntlShipping(e.target.checked)} className="rounded" />
                    <span>Offers International Shipping</span>
                  </label>
                </div>
              )}

              {listingType === 'digital' && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">File Format</label>
                    <input type="text" value={pFileFormat} onChange={(e) => setPFileFormat(e.target.value)} placeholder="ZIP / PDF / Figma / Key" className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Delivery Method</label>
                    <input type="text" value={pDigitalDelivery} onChange={(e) => setPDigitalDelivery(e.target.value)} placeholder="Direct download link via chat" className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Licensing Terms</label>
                    <input type="text" value={pLicense} onChange={(e) => setPLicense(e.target.value)} placeholder="Single commercial license" className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                  </div>
                </div>
              )}

              {listingType === 'service' && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Pricing Model</label>
                    <select value={pPricingModel} onChange={(e) => setPPricingModel(e.target.value)} className="w-full h-11 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white">
                      <option value="fixed">Fixed Price</option>
                      <option value="hourly">Hourly Rate</option>
                      <option value="milestone">Milestone Based</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Availability Mode</label>
                    <select value={pServiceMode} onChange={(e) => setPServiceMode(e.target.value)} className="w-full h-11 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white">
                      <option value="remote">Remote Worldwide</option>
                      <option value="onsite">Location-Based / On-Site</option>
                      <option value="hybrid">Hybrid</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Delivery Timeframe</label>
                    <input type="text" value={pTimeframe} onChange={(e) => setPTimeframe(e.target.value)} placeholder="e.g. 5 business days" className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Return / Cancellation Policy</label>
                  <input type="text" value={pReturnPolicy} onChange={(e) => setPReturnPolicy(e.target.value)} placeholder="7-day inspection window agreed with seller" className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Search Keywords</label>
                  <input type="text" value={pKeywords} onChange={(e) => setPKeywords(e.target.value)} placeholder="laptop, workstation, 32gb" className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                </div>
              </div>

              {/* Image Uploader */}
              <div className="space-y-2">
                <label className="block text-xs text-slate-400">Product / Preview Images (up to 6)</label>
                <div className="flex flex-wrap gap-3">
                  {pImages.map((url, idx) => (
                    <div key={idx} className="relative w-24 h-20 rounded-xl overflow-hidden border border-slate-800">
                      <ImageWithFallback src={url} alt="Upload" className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => setPImages((prev) => prev.filter((_, i) => i !== idx))}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white text-xs"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {pImages.length < 6 && (
                    <label className="w-24 h-20 rounded-xl border border-dashed border-slate-700 hover:border-blue-500 flex flex-col items-center justify-center text-xs text-slate-400 cursor-pointer">
                      <ImagePlus className="w-5 h-5 mb-1" />
                      <span>Upload</span>
                      <input type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" onChange={handleProductImageUpload} className="hidden" />
                    </label>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-2.5 pt-2">
                <button type="button" onClick={() => setPreviewOpen((v) => !v)} className="h-11 px-4 rounded-xl bg-[#131C31] border border-slate-700 text-slate-200 text-sm font-medium flex items-center gap-2">
                  <Eye className="w-4 h-4" />
                  <span>Preview</span>
                </button>
                <button type="button" onClick={() => submitProduct('draft')} className="h-11 px-4 rounded-xl bg-slate-800 text-slate-100 text-sm font-medium">
                  Save Draft
                </button>
                <button type="button" onClick={() => submitProduct('published')} className="h-11 px-5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold">
                  Publish Listing
                </button>
              </div>

              {previewOpen && (
                <div className="p-4 rounded-xl bg-[#070B14] border border-blue-800/50 space-y-2">
                  <div className="text-xs text-blue-400">Listing Preview</div>
                  <div className="text-base font-bold text-white">{pTitle || 'Untitled Listing'}</div>
                  <div className="text-sm font-mono-nums text-slate-200">{pCurrency} {pPrice || '0.00'}</div>
                  <p className="text-xs text-slate-300 whitespace-pre-line">{pDesc || 'No description yet.'}</p>
                </div>
              )}
            </div>
          )}

          {module === 'orders' && (
            <div className="p-6 rounded-2xl bg-[#0E1525] border border-slate-800 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-white">Seller Orders & Inquiries</h2>
                <p className="text-xs text-slate-400 mt-1">
                  Manage buyer confirmations, update shipping status, and review order timelines.
                </p>
              </div>
              <button type="button" onClick={() => navigate({ type: 'orders' })} className="h-10 px-4 rounded-xl bg-blue-600 text-white text-xs font-semibold">
                Open Orders Manager
              </button>
            </div>
          )}

          {module === 'analytics' && dash && (
            <div className="p-6 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-white">Shop Performance Analytics</h2>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const res = await apiFetch<{ insights: string }>('/api/ai/seller/assist', {
                        method: 'POST',
                        body: JSON.stringify({ action: 'analytics' }),
                      });
                      setAnalyticsInsight(res.insights);
                    } catch (err) {
                      notify(err instanceof Error ? err.message : 'AI analytics failed', 'error');
                    }
                  }}
                  className="h-9 px-3.5 rounded-lg bg-[#131C31] border border-purple-700/40 text-purple-200 text-xs font-medium"
                >
                  Explain with AI
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div className="p-3.5 rounded-xl bg-[#070B14] border border-slate-800">
                  <div className="text-slate-400">Listing Views</div>
                  <div className="text-xl font-bold text-white font-mono-nums mt-1">{dash.stats.total_views}</div>
                </div>
                <div className="p-3.5 rounded-xl bg-[#070B14] border border-slate-800">
                  <div className="text-slate-400">Wishlist Saves</div>
                  <div className="text-xl font-bold text-white font-mono-nums mt-1">{dash.stats.total_favorites}</div>
                </div>
                <div className="p-3.5 rounded-xl bg-[#070B14] border border-slate-800">
                  <div className="text-slate-400">Buyer Inquiries</div>
                  <div className="text-xl font-bold text-white font-mono-nums mt-1">{dash.stats.total_inquiries}</div>
                </div>
                <div className="p-3.5 rounded-xl bg-[#070B14] border border-slate-800">
                  <div className="text-slate-400">Total Orders</div>
                  <div className="text-xl font-bold text-white font-mono-nums mt-1">{dash.stats.total_orders}</div>
                </div>
              </div>
              {analyticsInsight && (
                <div className="p-4 rounded-xl bg-[#070B14] border border-purple-800/40 text-sm text-slate-200 whitespace-pre-line">
                  {analyticsInsight}
                </div>
              )}
            </div>
          )}

          {module === 'promotions' && dash && (
            <div className="space-y-4">
              <form onSubmit={createPromotion} className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3.5">
                <h2 className="text-base font-semibold text-white">Promote a Listing or Shop</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <select value={promoType} onChange={(e) => setPromoType(e.target.value)} className="h-11 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white">
                    <option value="featured_product">Featured Product</option>
                    <option value="sponsored_placement">Sponsored Search Placement</option>
                    <option value="shop_spotlight">Shop Spotlight</option>
                    <option value="banner_ad">Homepage Banner Ad</option>
                  </select>
                  <select value={promoProductId} onChange={(e) => setPromoProductId(e.target.value)} className="h-11 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white">
                    <option value="">Select Listing (optional for Shop Spotlight)</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.title}</option>
                    ))}
                  </select>
                  <input type="text" required value={promoTitle} onChange={(e) => setPromoTitle(e.target.value)} placeholder="Campaign Headline" className="h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                  <input type="number" min="1" max="30" value={promoDays} onChange={(e) => setPromoDays(e.target.value)} placeholder="Duration Days" className="h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white font-mono-nums" />
                </div>
                <button type="submit" className="h-11 px-5 rounded-xl bg-blue-600 text-white text-sm font-semibold">
                  Submit Promotion Campaign
                </button>
              </form>

              <div className="space-y-2">
                {dash.promotions.map((pr) => (
                  <div key={pr.id} className="p-4 rounded-xl bg-[#0E1525] border border-slate-800 flex justify-between text-xs">
                    <div>
                      <div className="font-semibold text-white">{pr.title}</div>
                      <div className="text-slate-400">{pr.promo_type} · {pr.duration_days} days</div>
                    </div>
                    <div className="text-right font-mono-nums">
                      <div className="text-white">${pr.price_amount} USD</div>
                      <div className="text-blue-400">{pr.status}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {module === 'plans' && dash && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {plans.map((pl) => {
                const isCurrent = dash.subscription?.plan_code === pl.code;
                let feats: string[] = [];
                try {
                  feats = JSON.parse(pl.features_json || '[]');
                } catch {
                  feats = [];
                }
                return (
                  <div key={pl.id} className={`p-5 rounded-2xl border flex flex-col justify-between gap-4 ${isCurrent ? 'bg-blue-600/10 border-blue-500' : 'bg-[#0E1525] border-slate-800'}`}>
                    <div className="space-y-3">
                      <div>
                        <div className="text-xs text-blue-400 font-semibold">{pl.code}</div>
                        <h3 className="text-lg font-bold text-white">{pl.name}</h3>
                        <p className="text-xs text-slate-400 mt-0.5">{pl.tagline}</p>
                      </div>
                      <div className="text-2xl font-bold text-white font-mono-nums">
                        ${pl.monthly_price} <span className="text-xs font-normal text-slate-400">/ mo</span>
                      </div>
                      <ul className="space-y-1.5 text-xs text-slate-300">
                        {feats.map((f, i) => (
                          <li key={i}>· {f}</li>
                        ))}
                      </ul>
                    </div>
                    <button
                      type="button"
                      disabled={isCurrent}
                      onClick={() => switchPlan(pl.code, 'monthly')}
                      className={`h-10 rounded-xl text-xs font-semibold ${isCurrent ? 'bg-slate-800 text-slate-400' : 'bg-blue-600 hover:bg-blue-500 text-white'}`}
                    >
                      {isCurrent ? 'Current Active Plan' : `Select ${pl.code}`}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {module === 'settings' && dash && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <form onSubmit={saveShopSettings} className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3.5">
                <h2 className="text-base font-semibold text-white">Shop Profile & Policies</h2>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Shop Name</label>
                  <input type="text" value={editShopName} onChange={(e) => setEditShopName(e.target.value)} className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Description</label>
                  <textarea rows={3} value={editShopDesc} onChange={(e) => setEditShopDesc(e.target.value)} className="w-full p-3 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Shipping Policy</label>
                  <input type="text" value={editShippingPolicy} onChange={(e) => setEditShippingPolicy(e.target.value)} className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Return Policy</label>
                  <input type="text" value={editReturnPolicy} onChange={(e) => setEditReturnPolicy(e.target.value)} className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                </div>
                <div className="flex flex-wrap gap-3">
                  <label className="h-10 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-slate-200 flex items-center gap-2 cursor-pointer">
                    <ImagePlus className="w-4 h-4" />
                    <span>Upload Logo</span>
                    <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) setEditLogo(await uploadImage(f));
                    }} />
                  </label>
                  <label className="h-10 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-slate-200 flex items-center gap-2 cursor-pointer">
                    <ImagePlus className="w-4 h-4" />
                    <span>Upload Banner</span>
                    <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) setEditBanner(await uploadImage(f));
                    }} />
                  </label>
                </div>
                <button type="submit" className="h-11 px-5 rounded-xl bg-blue-600 text-white text-sm font-semibold">
                  Save Settings
                </button>
              </form>

              <form onSubmit={submitVerification} className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-3.5">
                <h2 className="text-base font-semibold text-white">Shop Verification</h2>
                <p className="text-xs text-slate-400">
                  Current Status: <span className="text-white font-semibold uppercase">{dash.shop.verification_status}</span>
                </p>
                <input type="text" value={verDocType} onChange={(e) => setVerDocType(e.target.value)} className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                <input type="text" required value={verDocRef} onChange={(e) => setVerDocRef(e.target.value)} placeholder="Registration Number / Document Reference" className="w-full h-11 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-sm text-white" />
                <button type="submit" className="h-11 px-5 rounded-xl bg-[#131C31] border border-slate-700 text-white text-sm font-medium">
                  Submit for Review
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}
