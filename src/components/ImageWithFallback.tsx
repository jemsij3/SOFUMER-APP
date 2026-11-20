import { useState } from 'react';
import { Package } from 'lucide-react';

interface Props {
  src?: string | null;
  alt: string;
  className?: string;
  fallbackLabel?: string;
}

export function ImageWithFallback({ src, alt, className = '', fallbackLabel }: Props) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-gradient-to-br from-[#0E1525] via-[#131C31] to-[#1A1635] text-slate-400 select-none ${className}`}
        aria-label={alt}
      >
        <Package className="w-7 h-7 text-blue-400/70 mb-1.5" />
        {fallbackLabel && (
          <span className="text-[11px] text-slate-400 px-3 text-center line-clamp-1">
            {fallbackLabel}
          </span>
        )}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
