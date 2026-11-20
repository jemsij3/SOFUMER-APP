import { useEffect, useState } from 'react';
import { Search, SlidersHorizontal, Store } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import type { Product, Shop } from '../types';
import { ProductCard } from '../components/ProductCard';
import { ImageWithFallback } from '../components/ImageWithFallback';

export function ExplorePage() {
  const {
    categories,
    subcategories,
    countries,
    exploreInitialCategory,
    exploreInitialQuery,
    navigate,
  } = useApp();

  const [mode, setMode] = useState<'products' | 'shops' | 'services'>('products');
  const [q, setQ] = useState(exploreInitialQuery);
  const [categoryId, setCategoryId] = useState(exploreInitialCategory);
  const [subcategoryId, setSubcategoryId] = useState('');
  const [country, setCountry] = useState('');
  const [listingType, setListingType] = useState('');
  const [condition, setCondition] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [sort, setSort] = useState<'newest' | 'price_asc' | 'price_desc' | 'popular'>('newest');
  const [showFilters, setShowFilters] = useState(false);

  const [products, setProducts] = useState<Product[]>([]);
  const [shops, setShops] = useState<Shop[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setCategoryId(exploreInitialCategory);
  }, [exploreInitialCategory]);

  useEffect(() => {
    setQ(exploreInitialQuery);
  }, [exploreInitialQuery]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);

    const params = new URLSearchParams();
    params.set('mode', mode);
    if (q.trim()) params.set('q', q.trim());
    if (categoryId) params.set('categoryId', categoryId);
    if (subcategoryId) params.set('subcategoryId', subcategoryId);
    if (country) params.set('country', country);
    if (listingType) params.set('listingType', listingType);
    if (condition) params.set('condition', condition);
    if (minPrice) params.set('minPrice', minPrice);
    if (maxPrice) params.set('maxPrice', maxPrice);
    params.set('sort', sort);

    apiFetch<{ mode: string; items: unknown[] }>(`/api/marketplace/explore?${params.toString()}`)
      .then((res) => {
        if (!mounted) return;
        if (res.mode === 'shops') {
          setShops(res.items as Shop[]);
          setProducts([]);
        } else {
          setProducts(res.items as Product[]);
          setShops([]);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [mode, q, categoryId, subcategoryId, country, listingType, condition, minPrice, maxPrice, sort]);

  const filteredSubs = subcategories.filter((s) => !categoryId || s.category_id === categoryId);

  return (
    <div className="space-y-5 pb-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white">Explore Marketplace</h1>
          <p className="text-xs text-slate-400">
            Search published physical goods, digital downloads, software licenses, and services.
          </p>
        </div>

        {/* Mode Switcher */}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0E1525] border border-slate-800 self-start">
          {(['products', 'services', 'shops'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3.5 py-2 rounded-lg text-xs font-medium capitalize transition-colors whitespace-nowrap shrink-0 ${
                mode === m
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* Search & Filter Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2.5">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              mode === 'shops'
                ? 'Search shops by name or specialty...'
                : mode === 'services'
                ? 'Search engineering, design, consulting services...'
                : 'Search products, brands, software, or keywords...'
            }
            className="w-full h-11 pl-10 pr-4 rounded-xl bg-[#0E1525] border border-slate-800 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          className={`h-11 px-4 rounded-xl border text-sm font-medium flex items-center justify-center gap-2 whitespace-nowrap shrink-0 transition-colors ${
            showFilters
              ? 'bg-blue-600/20 border-blue-500 text-blue-300'
              : 'bg-[#0E1525] border-slate-800 text-slate-200 hover:border-slate-700'
          }`}
        >
          <SlidersHorizontal className="w-4 h-4" />
          <span>Filters</span>
        </button>

        {mode !== 'shops' && (
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            aria-label="Sort results"
            className="h-11 px-3.5 rounded-xl bg-[#0E1525] border border-slate-800 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
          >
            <option value="newest">Newest</option>
            <option value="popular">Popularity</option>
            <option value="price_asc">Price: Low to High</option>
            <option value="price_desc">Price: High to Low</option>
          </select>
        )}
      </div>

      {/* Expandable Filter Panel */}
      {showFilters && (
        <div className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {mode !== 'shops' && (
            <>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Category</label>
                <select
                  value={categoryId}
                  onChange={(e) => {
                    setCategoryId(e.target.value);
                    setSubcategoryId('');
                  }}
                  className="w-full h-10 px-3 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white"
                >
                  <option value="">All Categories</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Subcategory</label>
                <select
                  value={subcategoryId}
                  onChange={(e) => setSubcategoryId(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white"
                >
                  <option value="">All Subcategories</option>
                  {filteredSubs.map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      {sc.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Type & Condition</label>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={listingType}
                    onChange={(e) => setListingType(e.target.value)}
                    className="h-10 px-2 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white"
                  >
                    <option value="">All Types</option>
                    <option value="physical">Physical</option>
                    <option value="digital">Digital</option>
                    <option value="service">Service</option>
                  </select>
                  <select
                    value={condition}
                    onChange={(e) => setCondition(e.target.value)}
                    className="h-10 px-2 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white"
                  >
                    <option value="">Any Cond.</option>
                    <option value="new">New</option>
                    <option value="like_new">Like New</option>
                    <option value="refurbished">Refurbished</option>
                    <option value="used">Used</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Price Range (Orig.)</label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    min="0"
                    placeholder="Min"
                    value={minPrice}
                    onChange={(e) => setMinPrice(e.target.value)}
                    className="h-10 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white font-mono-nums"
                  />
                  <input
                    type="number"
                    min="0"
                    placeholder="Max"
                    value={maxPrice}
                    onChange={(e) => setMaxPrice(e.target.value)}
                    className="h-10 px-2.5 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white font-mono-nums"
                  />
                </div>
              </div>
            </>
          )}

          <div>
            <label className="block text-xs text-slate-400 mb-1">Seller Country</label>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-[#070B14] border border-slate-800 text-xs text-white"
            >
              <option value="">All Countries</option>
              {countries.map((co) => (
                <option key={co.code} value={co.code}>
                  {co.name} ({co.code})
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Results */}
      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="aspect-[4/5] rounded-2xl bg-[#0E1525] border border-slate-800 animate-pulse" />
          ))}
        </div>
      ) : mode === 'shops' ? (
        shops.length === 0 ? (
          <div className="p-10 rounded-2xl bg-[#0E1525] border border-slate-800 text-center space-y-2">
            <p className="text-sm font-medium text-white">No matching shops found</p>
            <p className="text-xs text-slate-400">Try clearing your country or keyword filters.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {shops.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => navigate({ type: 'shop', slug: s.slug })}
                className="p-4 rounded-2xl bg-[#0E1525] border border-slate-800 hover:border-slate-700 flex items-start gap-3.5 text-left"
              >
                <div className="w-12 h-12 rounded-xl overflow-hidden bg-[#131C31] shrink-0 flex items-center justify-center">
                  {s.logo_url ? (
                    <ImageWithFallback src={s.logo_url} alt={s.name} className="w-full h-full object-cover" />
                  ) : (
                    <Store className="w-5 h-5 text-blue-400" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-white truncate">{s.name}</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {s.country_name || s.country_code} · {s.product_count ?? 0} listings
                    {s.verification_status === 'verified' ? ' · Verified' : ''}
                  </div>
                  <p className="text-xs text-slate-300 mt-1.5 line-clamp-2">{s.description}</p>
                </div>
              </button>
            ))}
          </div>
        )
      ) : products.length === 0 ? (
        <div className="p-10 rounded-2xl bg-[#0E1525] border border-slate-800 text-center space-y-2">
          <p className="text-sm font-medium text-white">No published listings match these filters</p>
          <p className="text-xs text-slate-400">
            Adjust search criteria or publish the first listing in this category from Seller Center.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 sm:gap-4">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}
    </div>
  );
}
