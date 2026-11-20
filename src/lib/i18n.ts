import type { Currency } from '../types';

export type SupportedLang = 'en' | 'fr' | 'es' | 'ar';

const DICT: Record<SupportedLang, Record<string, string>> = {
  en: {
    slogan: 'BUY SMARTER. SELL FASTER.',
    home: 'Home',
    explore: 'Explore',
    aiAssistant: 'AI Assistant',
    messages: 'Messages',
    account: 'Account',
    sell: 'Sell',
    searchPlaceholder: 'Search products, services, or global shops...',
    featuredProducts: 'Featured Listings',
    trendingProducts: 'Trending Now',
    newArrivals: 'New Arrivals',
    featuredShops: 'Featured Shops',
    recentlyViewed: 'Recently Viewed',
    categories: 'Categories',
    directNotice: 'Direct buyer-to-seller arrangement. No platform payment escrow.',
  },
  fr: {
    slogan: 'ACHETEZ MIEUX. VENDEZ PLUS VITE.',
    home: 'Accueil',
    explore: 'Explorer',
    aiAssistant: 'Assistant IA',
    messages: 'Messages',
    account: 'Compte',
    sell: 'Vendre',
    searchPlaceholder: 'Rechercher produits, services ou boutiques...',
    featuredProducts: 'Annonces en vedette',
    trendingProducts: 'Tendances',
    newArrivals: 'Nouveautés',
    featuredShops: 'Boutiques en vedette',
    recentlyViewed: 'Vus récemment',
    categories: 'Catégories',
    directNotice: 'Transaction directe acheteur-vendeur. Aucun séquestre plateforme.',
  },
  es: {
    slogan: 'COMPRA INTELIGENTE. VENDE MÁS RÁPIDO.',
    home: 'Inicio',
    explore: 'Explorar',
    aiAssistant: 'Asistente IA',
    messages: 'Mensajes',
    account: 'Cuenta',
    sell: 'Vender',
    searchPlaceholder: 'Buscar productos, servicios o tiendas...',
    featuredProducts: 'Destacados',
    trendingProducts: 'Tendencias',
    newArrivals: 'Recientes',
    featuredShops: 'Tiendas destacadas',
    recentlyViewed: 'Vistos recientemente',
    categories: 'Categorías',
    directNotice: 'Acuerdo directo entre comprador y vendedor.',
  },
  ar: {
    slogan: 'اشترِ بذكاء. بعْ بشكل أسرع.',
    home: 'الرئيسية',
    explore: 'استكشاف',
    aiAssistant: 'مساعد الذكاء',
    messages: 'الرسائل',
    account: 'الحساب',
    sell: 'بيع',
    searchPlaceholder: 'ابحث عن المنتجات أو الخدمات أو المتاجر...',
    featuredProducts: 'منتجات مميزة',
    trendingProducts: 'الأكثر رواجاً',
    newArrivals: 'وصل حديثاً',
    featuredShops: 'متاجر مميزة',
    recentlyViewed: 'شوهد مؤخراً',
    categories: 'الفئات',
    directNotice: 'اتفاق مباشر بين المشتري والبائع.',
  },
};

export function t(lang: string, key: string): string {
  const l = (['en', 'fr', 'es', 'ar'].includes(lang) ? lang : 'en') as SupportedLang;
  return DICT[l][key] || DICT.en[key] || key;
}

export function formatMoney(
  amount: number,
  fromCurrency: string,
  displayCurrency: string,
  currencies: Currency[]
): { formatted: string; originalFormatted: string; converted: boolean } {
  const fromCur = currencies.find((c) => c.code === fromCurrency);
  const toCur = currencies.find((c) => c.code === displayCurrency);

  const origDecimals = fromCur?.decimal_places ?? 2;
  const origSymbol = fromCur?.symbol ?? `${fromCurrency} `;
  const originalFormatted = `${origSymbol}${Number(amount || 0).toLocaleString(undefined, {
    minimumFractionDigits: origDecimals,
    maximumFractionDigits: origDecimals,
  })}`;

  if (!fromCur || !toCur || fromCurrency === displayCurrency) {
    return { formatted: originalFormatted, originalFormatted, converted: false };
  }

  const usdAmount = Number(amount || 0) / (fromCur.usd_rate || 1);
  const convertedVal = usdAmount * (toCur.usd_rate || 1);
  const formatted = `${toCur.symbol}${convertedVal.toLocaleString(undefined, {
    minimumFractionDigits: toCur.decimal_places,
    maximumFractionDigits: toCur.decimal_places,
  })}`;

  return { formatted, originalFormatted, converted: true };
}
