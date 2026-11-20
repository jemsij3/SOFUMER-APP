import { Heart } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { formatMoney } from '../lib/i18n';
import type { Product } from '../types';
import { ImageWithFallback } from './ImageWithFallback';

export function ProductCard({ product }: { product: Product }) {
  const { currencies, displayCurrency, favoriteIds, toggleFavorite, navigate } = useApp();
  const isFav = favoriteIds.has(product.id);
  const priceInfo = formatMoney(product.price, product.currency, displayCurrency, currencies);

  const typeLabel =
    product.listing_type === 'digital'
      ? 'Digital'
      : product.listing_type === 'service'
      ? 'Service'
      : 'Physical';

  return (
    <article className="group bg-[#0E1525] border border-slate-800/80 rounded-2xl overflow-hidden flex flex-col transition-transform duration-200 hover:-translate-y-0.5 hover:border-slate-700">
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-[#0A101D]">
        <button
          type="button"
          onClick={() => navigate({ type: 'product', productId: product.id })}
          className="w-full h-full block text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <ImageWithFallback
            src={product.primary_image}
            alt={product.title}
            fallbackLabel={product.category_name || typeLabel}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(product.id);
          }}
          aria-label={isFav ? 'Remove from wishlist' : 'Add to wishlist'}
          className="absolute top-2.5 right-2.5 w-10 h-10 rounded-full bg-[#070B14]/75 backdrop-blur-md border border-slate-700/60 flex items-center justify-center text-slate-200 hover:text-white transition-colors"
        >
          <Heart className={`w-4 h-4 ${isFav ? 'fill-blue-500 text-blue-500' : ''}`} />
        </button>
      </div>

      <button
        type="button"
        onClick={() => navigate({ type: 'product', productId: product.id })}
        className="p-3.5 flex-1 flex flex-col justify-between text-left"
      >
        <div>
          <div className="flex items-center gap-1.5 text-xs text-slate-400 truncate">
            <span>{typeLabel}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{product.category_name || 'Marketplace'}</span>
            {product.country_code && (
              <>
                <span aria-hidden="true">·</span>
                <span>{product.country_code}</span>
              </>
            )}
          </div>
          <h3 className="mt-1 text-sm sm:text-[15px] font-semibold text-slate-100 line-clamp-2 leading-snug">
            {product.title}
          </h3>
        </div>

        <div className="mt-3 pt-2.5 border-t border-slate-800/70 flex items-baseline justify-between gap-2">
          <div>
            <div className="text-sm sm:text-base font-semibold text-white font-mono-nums">
              {priceInfo.formatted}
            </div>
            {priceInfo.converted && (
              <div className="text-[11px] text-slate-400 font-mono-nums">
                Orig. {priceInfo.originalFormatted}
              </div>
            )}
          </div>
          <span className="text-xs text-slate-400 truncate max-w-[45%]">
            {product.shop_name}
          </span>
        </div>
      </button>
    </article>
  );
}
