import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Eye,
  ImagePlus,
  KeyRound,
  Package,
  Pencil,
  Plus,
  Sparkles,
  Store,
  Trash2,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import { safeStringArray, safeText } from '../lib/aiFormat';
import {
  type SellerMediaConfig,
  DEFAULT_MEDIA_CONFIG,
  fetchSellerMediaConfig,
  uploadSignedMediaToCloudinary,
  validateImageFile,
} from '../lib/cloudinary';
import { openTelegramInvoice } from '../lib/telegram';
import type { Product, ProductDigitalAsset, ProductMedia, Shop, StarsPayment } from '../types';
import { ImageWithFallback } from '../components/ImageWithFallback';
import { ProductMediaManager, type DraftMediaItem } from '../components/ProductMediaManager';

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
    ends_at?: string | null;
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
  starsPayments?: StarsPayment[];
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

  // Add / Edit Product form state
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [loadingProductEdit, setLoadingProductEdit] = useState(false);
  const [savingProduct, setSavingProduct] = useState(false);
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
  const [mediaConfig, setMediaConfig] = useState<SellerMediaConfig>(DEFAULT_MEDIA_CONFIG);
  const [mediaItems, setMediaItems] = useState<DraftMediaItem[]>([]);
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
  const [analyticsAiBusy, setAnalyticsAiBusy] = useState(false);

  // Billing & Stars checkout state
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'annual'>('monthly');
  const [checkoutBusy, setCheckoutBusy] = useState(false);

  // Digital delivery asset editor state
  const [digitalEditProduct, setDigitalEditProduct] = useState<Product | null>(null);
  const [digitalAssetLoading, setDigitalAssetLoading] = useState(false);
  const [digitalAssetSaving, setDigitalAssetSaving] = useState(false);
  const [digitalR2Configured, setDigitalR2Configured] = useState(false);
  const [digitalFileName, setDigitalFileName] = useState('');
  const [digitalInstructions, setDigitalInstructions] = useState('');
  const [digitalLicenseTpl, setDigitalLicenseTpl] = useState('');
  const [digitalDownloadLimit, setDigitalDownloadLimit] = useState('5');
  const [digitalUploadFile, setDigitalUploadFile] = useState<File | null>(null);

  const loadSellerData = useCallback(async () => {
    if (!user || !sellerProfile) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [d, p, mc] = await Promise.all([
        apiFetch<SellerDashboardData>('/api/seller/dashboard'),
        apiFetch<{ products: Product[] }>('/api/seller/products'),
        fetchSellerMediaConfig().catch(() => DEFAULT_MEDIA_CONFIG),
      ]);
      setDash(d);
      setProducts(p.products);
      setMediaConfig(mc);
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

  function resetProductForm() {
    setEditingProductId(null);
    setListingType('physical');
    setPTitle('');
    setPDesc('');
    setPCat(categories[0]?.id || 'cat_electronics');
    setPSubCat('');
    setPPrice('');
    setPCurrency(dash?.shop.default_currency || 'USD');
    setPCondition('new');
    setPStock('10');
    setPShipping('');
    setPIntlShipping(true);
    setPLocation('');
    setPFileFormat('');
    setPDigitalDelivery('');
    setPLicense('');
    setPPricingModel('fixed');
    setPServiceMode('remote');
    setPTimeframe('');
    setPReturnPolicy('');
    setPKeywords('');
    setMediaItems((prev) => {
      for (const item of prev) {
        if (item.previewUrl && item.previewUrl.startsWith('blob:')) {
          URL.revokeObjectURL(item.previewUrl);
        }
      }
      return [];
    });
    setPreviewOpen(false);
  }

  async function startEditProduct(productId: string) {
    setLoadingProductEdit(true);
    setModule('add_product');
    try {
      const res = await apiFetch<{
        product: Product & { stock_quantity?: number };
        media: ProductMedia[];
      }>(`/api/seller/products/${productId}`);
      const prod = res.product;
      setEditingProductId(prod.id);
      setListingType(prod.listing_type || 'physical');
      setPTitle(prod.title || '');
      setPDesc(prod.description || '');
      setPCat(prod.category_id || categories[0]?.id || 'cat_electronics');
      setPSubCat(prod.subcategory_id || '');
      setPPrice(String(prod.price ?? ''));
      setPCurrency(prod.currency || 'USD');
      setPCondition(prod.condition && prod.condition !== 'not_applicable' ? prod.condition : 'new');
      setPStock(String(prod.stock_quantity ?? 1));
      setPShipping(prod.shipping_info || '');
      setPIntlShipping(Boolean(prod.international_shipping));
      setPLocation(prod.location_text || '');
      setPFileFormat(prod.file_format || '');
      setPDigitalDelivery(prod.digital_delivery_method || '');
      setPLicense(prod.license_info || '');
      setPPricingModel(prod.pricing_model || 'fixed');
      setPServiceMode(prod.service_mode && prod.service_mode !== 'not_applicable' ? prod.service_mode : 'remote');
      setPTimeframe(prod.delivery_timeframe || '');
      setPReturnPolicy(prod.return_policy || '');
      setPKeywords(prod.keywords || '');
      setMediaItems(
        (res.media || []).map((m) => ({
          id: m.id,
          localKey: m.id,
          storageProvider: m.storage_provider,
          mediaType: m.media_type,
          resourceType: m.resource_type,
          publicId: m.public_id,
          secureUrl: m.secure_url,
          previewUrl: m.secure_url,
          format: m.format || '',
          bytes: Number(m.bytes || 0),
          width: Number(m.width || 0),
          height: Number(m.height || 0),
          duration: m.duration ?? null,
          sortOrder: Number(m.sort_order || 0),
          isPrimary: Boolean(m.is_primary),
          altText: m.alt_text || '',
          status: 'ready' as const,
          progress: 100,
        }))
      );
      setPreviewOpen(false);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to load listing for editing', 'error');
      setModule('products');
    } finally {
      setLoadingProductEdit(false);
    }
  }

  async function uploadShopImage(file: File): Promise<string> {
    const check = validateImageFile(file, mediaConfig.maxImageBytes);
    if (check.ok === false) {
      throw new Error(check.error);
    }
    const uploaded = await uploadSignedMediaToCloudinary({
      file,
      mediaType: 'image',
      scope: 'shop',
    });
    return uploaded.secureUrl;
  }

  async function handleAiDraft() {
    if (aiBusy) return;
    if (!pTitle.trim() && !pDesc.trim()) {
      notify('Enter a rough title or notes first so AI can draft your listing for review.', 'info');
      return;
    }
    setAiBusy(true);
    try {
      const res = await apiFetch<{
        suggestedTitle?: unknown;
        improvedDescription?: unknown;
        suggestedCategoryId?: unknown;
        keywords?: unknown;
      }>('/api/ai/seller/assist', {
        method: 'POST',
        body: JSON.stringify({
          action: 'generate_listing',
          title: pTitle.trim(),
          notes: pDesc.trim(),
          listingType,
        }),
      });
      const suggestedTitle = safeText(res.suggestedTitle);
      const improvedDescription = safeText(res.improvedDescription);
      const suggestedCategoryId = safeText(res.suggestedCategoryId);
      const keywords = safeStringArray(res.keywords, 12);
      if (suggestedTitle) setPTitle(suggestedTitle);
      if (improvedDescription) setPDesc(improvedDescription);
      if (suggestedCategoryId && categories.some((c) => c.id === suggestedCategoryId)) {
        setPCat(suggestedCategoryId);
      }
      if (keywords.length > 0) setPKeywords(keywords.join(', '));
      notify('AI draft populated — please review carefully before publishing.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'AI assist failed', 'error');
    } finally {
      setAiBusy(false);
    }
  }

  async function submitProduct(publishStatus: 'draft' | 'published') {
    if (mediaItems.some((m) => m.status === 'uploading')) {
      notify('Please wait for all photos and videos to finish uploading.', 'info');
      return;
    }
    if (mediaItems.some((m) => m.status === 'error')) {
      notify('Remove or retry failed media uploads before saving this listing.', 'error');
      return;
    }

    const readyPhotos = mediaItems.filter((m) => m.status === 'ready' && m.mediaType === 'image');
    const readyVideos = mediaItems.filter((m) => m.status === 'ready' && m.mediaType === 'video');
    if (readyPhotos.length > mediaConfig.maxPhotos) {
      notify(`Maximum ${mediaConfig.maxPhotos} photos allowed per product.`, 'error');
      return;
    }
    if (readyVideos.length > mediaConfig.maxVideos) {
      notify(`Maximum ${mediaConfig.maxVideos} short video(s) allowed per product.`, 'error');
      return;
    }

    const mediaPayload = [
      ...readyPhotos.map((m, idx) => ({
        id: m.id,
        storageProvider: m.storageProvider,
        mediaType: 'image' as const,
        resourceType: 'image' as const,
        publicId: m.publicId,
        version: m.version,
        signature: m.signature,
        secureUrl: m.secureUrl,
        format: m.format,
        bytes: m.bytes,
        width: m.width,
        height: m.height,
        duration: null,
        sortOrder: idx,
        isPrimary: m.isPrimary,
        altText: m.altText || pTitle,
      })),
      ...readyVideos.map((m, idx) => ({
        id: m.id,
        storageProvider: m.storageProvider,
        mediaType: 'video' as const,
        resourceType: 'video' as const,
        publicId: m.publicId,
        version: m.version,
        signature: m.signature,
        secureUrl: m.secureUrl,
        format: m.format,
        bytes: m.bytes,
        width: m.width,
        height: m.height,
        duration: m.duration,
        sortOrder: idx,
        isPrimary: false,
        altText: m.altText || pTitle,
      })),
    ];

    setSavingProduct(true);
    try {
      const payload = {
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
        media: mediaPayload,
        status: publishStatus,
      };

      const res = editingProductId
        ? await apiFetch<{ product: Product; moderationNotes?: string }>(
            `/api/seller/products/${editingProductId}`,
            { method: 'PATCH', body: JSON.stringify(payload) }
          )
        : await apiFetch<{ product: Product; moderationNotes?: string }>('/api/seller/products', {
            method: 'POST',
            body: JSON.stringify(payload),
          });

      notify(
        res.moderationNotes
          ? res.moderationNotes
          : editingProductId
          ? 'Listing changes saved!'
          : publishStatus === 'published'
          ? 'Listing published!'
          : 'Saved as draft',
        'success'
      );
      resetProductForm();
      await loadSellerData();
      setModule('products');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save listing', 'error');
    } finally {
      setSavingProduct(false);
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

  async function openDigitalAssetEditor(p: Product) {
    setDigitalEditProduct(p);
    setDigitalUploadFile(null);
    setDigitalAssetLoading(true);
    try {
      const res = await apiFetch<{ asset: ProductDigitalAsset | null; r2Configured: boolean }>(
        `/api/seller/products/${p.id}/digital-asset`
      );
      setDigitalR2Configured(Boolean(res.r2Configured));
      setDigitalFileName(res.asset?.file_name || '');
      setDigitalInstructions(res.asset?.delivery_instructions || p.digital_delivery_method || '');
      setDigitalLicenseTpl(res.asset?.license_key_template || '');
      setDigitalDownloadLimit(String(res.asset?.download_limit ?? 5));
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to load digital asset settings', 'error');
    } finally {
      setDigitalAssetLoading(false);
    }
  }

  async function saveDigitalAsset(e: React.FormEvent) {
    e.preventDefault();
    if (!digitalEditProduct) return;
    setDigitalAssetSaving(true);
    try {
      if (digitalUploadFile) {
        const fd = new FormData();
        fd.append('file', digitalUploadFile);
        fd.append('fileName', digitalFileName || digitalUploadFile.name);
        fd.append('deliveryInstructions', digitalInstructions);
        fd.append('licenseKeyTemplate', digitalLicenseTpl);
        fd.append('downloadLimit', digitalDownloadLimit);
        await apiFetch(`/api/seller/products/${digitalEditProduct.id}/digital-asset`, {
          method: 'POST',
          body: fd,
        });
      } else {
        await apiFetch(`/api/seller/products/${digitalEditProduct.id}/digital-asset`, {
          method: 'POST',
          body: JSON.stringify({
            fileName: digitalFileName,
            deliveryInstructions: digitalInstructions,
            licenseKeyTemplate: digitalLicenseTpl,
            downloadLimit: Number(digitalDownloadLimit || 5),
          }),
        });
      }
      notify('Protected digital delivery package saved', 'success');
      setDigitalEditProduct(null);
      await loadSellerData();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save digital package', 'error');
    } finally {
      setDigitalAssetSaving(false);
    }
  }

  async function createPromotion(e: React.FormEvent) {
    e.preventDefault();
    setCheckoutBusy(true);
    try {
      const res = await apiFetch<{
        paymentId: string;
        invoiceUrl: string;
        starsAmount: number;
      }>('/api/seller/promotions/invoice', {
        method: 'POST',
        body: JSON.stringify({
          promoType,
          productId: promoProductId || null,
          title: promoTitle,
          durationDays: Number(promoDays || 7),
        }),
      });
      const status = await openTelegramInvoice(res.invoiceUrl);
      if (status === 'paid') {
        setPromoTitle('');
        notify(`Promotion activated via ${res.starsAmount} Telegram Stars!`, 'success');
      } else if (status === 'cancelled') {
        await apiFetch(`/api/seller/payments/${res.paymentId}/cancel`, { method: 'POST' }).catch(() => {});
        notify('Telegram Stars checkout was cancelled.', 'info');
      } else if (status === 'unavailable') {
        notify(`Stars invoice created (${res.starsAmount} XTR). Open SOFUMER inside Telegram to complete payment.`, 'info');
      } else {
        notify(`Promotion invoice status: ${status}`, 'info');
      }
      await loadSellerData();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Promotion checkout failed', 'error');
    } finally {
      setCheckoutBusy(false);
    }
  }

  async function switchPlan(planCode: string, cycle: 'monthly' | 'annual') {
    setCheckoutBusy(true);
    try {
      if (planCode === 'FREE') {
        await apiFetch('/api/seller/subscriptions', {
          method: 'POST',
          body: JSON.stringify({ planCode, billingCycle: cycle }),
        });
        notify('Switched to FREE plan', 'success');
        await loadSellerData();
        return;
      }

      const res = await apiFetch<{
        paymentId: string;
        invoiceUrl: string;
        starsAmount: number;
      }>('/api/seller/subscriptions/invoice', {
        method: 'POST',
        body: JSON.stringify({ planCode, billingCycle: cycle }),
      });
      const status = await openTelegramInvoice(res.invoiceUrl);
      if (status === 'paid') {
        notify(`Subscribed to ${planCode} (${cycle}) with ${res.starsAmount} Stars!`, 'success');
      } else if (status === 'cancelled') {
        await apiFetch(`/api/seller/payments/${res.paymentId}/cancel`, { method: 'POST' }).catch(() => {});
        notify('Telegram Stars checkout was cancelled.', 'info');
      } else if (status === 'unavailable') {
        notify(`Stars invoice created (${res.starsAmount} XTR). Open inside Telegram to complete checkout.`, 'info');
      } else {
        notify(`Checkout status: ${status}`, 'info');
      }
      await loadSellerData();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Plan checkout failed', 'error');
    } finally {
      setCheckoutBusy(false);
    }
  }

  async function cancelPendingPayment(paymentId: string) {
    try {
      await apiFetch(`/api/seller/payments/${paymentId}/cancel`, { method: 'POST' });
      notify('Pending Stars invoice cancelled', 'info');
      await loadSellerData();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to cancel invoice', 'error');
    }
  }

  const navItems: Array<{ key: SellerModule; label: string }> = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'my_shop', label: 'My Shop' },
    { key: 'products', label: 'Products' },
    { key: 'add_product', label: editingProductId ? 'Edit Listing' : 'Add Product' },
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
            onClick={() => {
              resetProductForm();
              setModule('add_product');
            }}
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
                          {(Number(p.media_image_count || 0) > 0 || Number(p.media_video_count || 0) > 0) &&
                            ` · ${p.media_image_count || 0} photos${Number(p.media_video_count || 0) > 0 ? `, ${p.media_video_count} videos` : ''}`}
                        </div>
                        {p.moderation_notes && (
                          <div className="text-[11px] text-amber-300 mt-0.5">{p.moderation_notes}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {p.listing_type === 'digital' && (
                        <button
                          type="button"
                          onClick={() => openDigitalAssetEditor(p)}
                          className="h-9 px-3 rounded-lg bg-emerald-950/60 border border-emerald-700/60 text-xs text-emerald-200 flex items-center gap-1"
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                          <span>{p.has_digital_package ? 'Digital Package' : 'Attach Package'}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => startEditProduct(p.id)}
                        className="h-9 px-3 rounded-lg bg-[#070B14] border border-slate-700 text-xs text-slate-100 flex items-center gap-1 hover:border-blue-500"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        <span>Edit</span>
                      </button>
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

              {digitalEditProduct && (
                <form onSubmit={saveDigitalAsset} className="p-5 rounded-2xl bg-[#0E1525] border border-emerald-800/60 space-y-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-white">
                        Protected Digital Delivery — {digitalEditProduct.title}
                      </h3>
                      <p className="text-xs text-slate-400">
                        Automatically unlocked for buyers after order confirmation. Never exposed on public asset URLs.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDigitalEditProduct(null)}
                      className="h-8 px-3 rounded-lg bg-slate-800 text-xs text-slate-300"
                    >
                      Close
                    </button>
                  </div>
                  {digitalAssetLoading ? (
                    <div className="text-xs text-slate-400">Loading digital package configuration...</div>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Receipt / Package Filename</label>
                          <input
                            type="text"
                            value={digitalFileName}
                            onChange={(e) => setDigitalFileName(e.target.value)}
                            placeholder="software-license.txt"
                            className="w-full h-10 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Max Downloads Per Order</label>
                          <input
                            type="number"
                            min="1"
                            max="100"
                            value={digitalDownloadLimit}
                            onChange={(e) => setDigitalDownloadLimit(e.target.value)}
                            className="w-full h-10 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-white font-mono-nums"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          License Key / Access Template (optional, use {'{ORDER}'} to inject order number)
                        </label>
                        <input
                          type="text"
                          value={digitalLicenseTpl}
                          onChange={(e) => setDigitalLicenseTpl(e.target.value)}
                          placeholder="SFM-PRO-{ORDER}"
                          className="w-full h-10 px-3 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-white font-mono-nums"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          Protected Delivery Instructions / Download Notes
                        </label>
                        <textarea
                          rows={3}
                          value={digitalInstructions}
                          onChange={(e) => setDigitalInstructions(e.target.value)}
                          placeholder="Step-by-step setup notes, activation instructions, or private fulfillment details..."
                          className="w-full p-3 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-white"
                        />
                      </div>
                      {digitalR2Configured ? (
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Optional Binary File Upload (max 50MB)</label>
                          <input
                            type="file"
                            onChange={(e) => setDigitalUploadFile(e.target.files?.[0] || null)}
                            className="text-xs text-slate-300"
                          />
                        </div>
                      ) : (
                        <p className="text-[11px] text-slate-400">
                          Note: Object storage for binary archives is optional and currently omitted; delivery instructions and license keys are delivered as protected order receipts.
                        </p>
                      )}
                      <button
                        type="submit"
                        disabled={digitalAssetSaving}
                        className="h-10 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold disabled:opacity-60"
                      >
                        {digitalAssetSaving ? 'Saving Package...' : 'Save Digital Package'}
                      </button>
                    </>
                  )}
                </form>
              )}
            </div>
          )}

          {module === 'add_product' && (
            <div className="p-5 sm:p-6 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold text-white">
                    {editingProductId ? 'Edit Listing' : 'Publish New Listing'}
                  </h2>
                  {editingProductId && (
                    <button
                      type="button"
                      onClick={() => {
                        resetProductForm();
                        setModule('products');
                      }}
                      className="h-8 px-3 rounded-lg bg-slate-800 text-xs text-slate-300 hover:text-white"
                    >
                      Cancel Edit
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleAiDraft}
                  disabled={aiBusy || loadingProductEdit}
                  className="h-10 px-4 rounded-xl bg-[#131C31] border border-purple-700/40 text-purple-200 text-xs font-medium flex items-center gap-2"
                >
                  <Bot className="w-4 h-4" />
                  <span>{aiBusy ? 'Generating Draft...' : 'AI Draft & Keywords'}</span>
                </button>
              </div>

              {loadingProductEdit && (
                <div className="p-4 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-slate-300">
                  Loading listing details and Cloudinary media...
                </div>
              )}

              {/* Listing Type Selector */}
              <div className="grid grid-cols-3 gap-2">
                {(['physical', 'digital', 'service'] as const).map((lt) => (
                  <button
                    key={lt}
                    type="button"
                    disabled={Boolean(editingProductId)}
                    onClick={() => setListingType(lt)}
                    className={`h-11 rounded-xl border text-xs sm:text-sm font-medium capitalize ${
                      listingType === lt
                        ? 'bg-blue-600 border-blue-500 text-white'
                        : 'bg-[#070B14] border-slate-800 text-slate-300'
                    } ${editingProductId ? 'opacity-70 cursor-not-allowed' : ''}`}
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

              <ProductMediaManager
                items={mediaItems}
                onChange={setMediaItems}
                config={mediaConfig}
                productId={editingProductId || undefined}
                notify={notify}
              />

              <div className="flex flex-wrap gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setPreviewOpen((v) => !v)}
                  className="h-11 px-4 rounded-xl bg-[#131C31] border border-slate-700 text-slate-200 text-sm font-medium flex items-center gap-2"
                >
                  <Eye className="w-4 h-4" />
                  <span>Preview</span>
                </button>
                <button
                  type="button"
                  disabled={savingProduct || loadingProductEdit}
                  onClick={() => submitProduct('draft')}
                  className="h-11 px-4 rounded-xl bg-slate-800 text-slate-100 text-sm font-medium disabled:opacity-60"
                >
                  {savingProduct ? 'Saving...' : 'Save Draft'}
                </button>
                <button
                  type="button"
                  disabled={savingProduct || loadingProductEdit}
                  onClick={() => submitProduct('published')}
                  className="h-11 px-5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-60"
                >
                  {savingProduct
                    ? 'Saving...'
                    : editingProductId
                    ? 'Save & Publish'
                    : 'Publish Listing'}
                </button>
              </div>

              {previewOpen && (
                <div className="p-4 rounded-xl bg-[#070B14] border border-blue-800/50 space-y-2.5">
                  <div className="text-xs text-blue-400">Listing Preview</div>
                  {(() => {
                    const photos = mediaItems.filter((m) => m.mediaType === 'image');
                    const primary = photos.find((p) => p.isPrimary) || photos[0];
                    const videos = mediaItems.filter((m) => m.mediaType === 'video');
                    return (
                      <div className="flex flex-wrap items-center gap-3">
                        {primary && (
                          <div className="w-24 h-18 rounded-lg overflow-hidden border border-slate-800 shrink-0">
                            <ImageWithFallback
                              src={primary.previewUrl || primary.secureUrl}
                              alt={pTitle || 'Listing cover'}
                              className="w-full h-full object-cover"
                            />
                          </div>
                        )}
                        <div className="space-y-1">
                          <div className="text-base font-bold text-white">{pTitle || 'Untitled Listing'}</div>
                          <div className="text-sm font-mono-nums text-slate-200">{pCurrency} {pPrice || '0.00'}</div>
                          <div className="text-xs text-slate-400 font-mono-nums">
                            {photos.length} photo{photos.length === 1 ? '' : 's'} · {videos.length} short video{videos.length === 1 ? '' : 's'}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
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
                  disabled={analyticsAiBusy}
                  onClick={async () => {
                    if (analyticsAiBusy) return;
                    setAnalyticsAiBusy(true);
                    try {
                      const res = await apiFetch<{ insights?: unknown }>('/api/ai/seller/assist', {
                        method: 'POST',
                        body: JSON.stringify({ action: 'analytics' }),
                      });
                      setAnalyticsInsight(safeText(res.insights, 'No analytics insights were returned.'));
                    } catch (err) {
                      notify(err instanceof Error ? err.message : 'AI analytics failed', 'error');
                    } finally {
                      setAnalyticsAiBusy(false);
                    }
                  }}
                  className="h-9 px-3.5 rounded-lg bg-[#131C31] border border-purple-700/40 text-purple-200 text-xs font-medium disabled:opacity-60"
                >
                  {analyticsAiBusy ? 'Analyzing...' : 'Explain with AI'}
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
                <button
                  type="submit"
                  disabled={checkoutBusy}
                  className="h-11 px-5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-60"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>{checkoutBusy ? 'Creating Stars Invoice...' : 'Promote with Telegram Stars'}</span>
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
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-2xl bg-[#0E1525] border border-slate-800">
                <div className="text-xs">
                  <div className="font-semibold text-white">
                    Active Plan: {dash.subscription?.plan_name || 'Free Starter'} ({dash.subscription?.billing_cycle || 'monthly'})
                  </div>
                  {dash.subscription?.ends_at && (
                    <div className="text-slate-400 mt-0.5 font-mono-nums">
                      Renews / Expires: {new Date(dash.subscription.ends_at).toLocaleDateString()}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 p-1 rounded-xl bg-[#070B14] border border-slate-800">
                  {(['monthly', 'annual'] as const).map((cycle) => (
                    <button
                      key={cycle}
                      type="button"
                      onClick={() => setBillingCycle(cycle)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize ${
                        billingCycle === cycle ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {cycle}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {plans.map((pl) => {
                  const isCurrent = dash.subscription?.plan_code === pl.code;
                  const usdPrice = billingCycle === 'annual' ? pl.annual_price : pl.monthly_price;
                  const starsCost = billingCycle === 'annual' ? (pl.stars_annual ?? 0) : (pl.stars_monthly ?? 0);
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
                        <div className="space-y-0.5">
                          <div className="text-2xl font-bold text-white font-mono-nums">
                            {starsCost > 0 ? `${starsCost} XTR` : 'Free'}
                            <span className="text-xs font-normal text-slate-400">
                              {' '}
                              / {billingCycle === 'annual' ? 'yr' : 'mo'}
                            </span>
                          </div>
                          {usdPrice > 0 && (
                            <div className="text-[11px] text-slate-400 font-mono-nums">
                              Approx. ${usdPrice} USD via Telegram Stars
                            </div>
                          )}
                        </div>
                        <ul className="space-y-1.5 text-xs text-slate-300">
                          {feats.map((f, i) => (
                            <li key={i}>· {f}</li>
                          ))}
                        </ul>
                      </div>
                      <button
                        type="button"
                        disabled={isCurrent || checkoutBusy}
                        onClick={() => switchPlan(pl.code, billingCycle)}
                        className={`h-10 rounded-xl text-xs font-semibold ${isCurrent ? 'bg-slate-800 text-slate-400' : 'bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-60'}`}
                      >
                        {isCurrent
                          ? 'Current Active Plan'
                          : starsCost > 0
                          ? `Pay ${starsCost} Stars (${pl.code})`
                          : `Select ${pl.code}`}
                      </button>
                    </div>
                  );
                })}
              </div>

              {dash.starsPayments && dash.starsPayments.length > 0 && (
                <div className="p-5 rounded-2xl bg-[#0E1525] border border-slate-800 space-y-2.5 text-xs">
                  <div className="text-sm font-semibold text-white">Telegram Stars Billing History</div>
                  {dash.starsPayments.map((pay) => (
                    <div key={pay.id} className="flex flex-wrap items-center justify-between gap-2 py-2 border-b border-slate-800/70">
                      <div>
                        <span className="font-semibold text-white">
                          {pay.target_type} · {pay.plan_code} ({pay.billing_cycle})
                        </span>
                        <span className="text-slate-400 ml-2 font-mono-nums">{pay.stars_amount} XTR</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="uppercase font-mono-nums text-blue-300">{pay.status}</span>
                        {pay.status === 'pending' && (
                          <button
                            type="button"
                            onClick={() => cancelPendingPayment(pay.id)}
                            className="h-7 px-2.5 rounded-lg bg-slate-800 text-slate-300 hover:text-white"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
                    <input type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" className="hidden" onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (!f) return;
                      try {
                        setEditLogo(await uploadShopImage(f));
                        notify('Logo uploaded to Cloudinary. Click Save Settings to apply.', 'success');
                      } catch (err) {
                        notify(err instanceof Error ? err.message : 'Logo upload failed', 'error');
                      }
                    }} />
                  </label>
                  <label className="h-10 px-3.5 rounded-xl bg-[#070B14] border border-slate-800 text-xs text-slate-200 flex items-center gap-2 cursor-pointer">
                    <ImagePlus className="w-4 h-4" />
                    <span>Upload Banner</span>
                    <input type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" className="hidden" onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (!f) return;
                      try {
                        setEditBanner(await uploadShopImage(f));
                        notify('Banner uploaded to Cloudinary. Click Save Settings to apply.', 'success');
                      } catch (err) {
                        notify(err instanceof Error ? err.message : 'Banner upload failed', 'error');
                      }
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
