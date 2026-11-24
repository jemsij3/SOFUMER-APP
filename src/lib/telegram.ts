interface TelegramWebApp {
  initData: string;
  platform?: string;
  initDataUnsafe?: {
    user?: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
      language_code?: string;
    };
  };
  ready: () => void;
  expand: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  BackButton?: {
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy') => void;
  };
  openTelegramLink?: (url: string) => void;
  openInvoice?: (url: string, callback?: (status: string) => void) => void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

const TG_INIT_DATA_CACHE_KEY = 'sofumer_tg_init_data';

export function getTelegramWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp || null;
}

export function initTelegramMiniApp() {
  const tg = getTelegramWebApp();
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.('#070B14');
    tg.setBackgroundColor?.('#070B14');
  } catch {
    // Ignore outside Telegram client
  }
}

function readHashOrQueryInitData(): string {
  if (typeof window === 'undefined') return '';
  try {
    const rawHash = (window.location.hash || '').replace(/^#/, '');
    if (rawHash) {
      const hashParams = new URLSearchParams(rawHash);
      const fromHash = hashParams.get('tgWebAppData') || '';
      if (fromHash && fromHash.includes('hash=')) {
        return fromHash;
      }
    }
  } catch {
    // Ignore malformed hash
  }
  try {
    const searchParams = new URLSearchParams(window.location.search || '');
    const fromSearch = searchParams.get('tgWebAppData') || '';
    if (fromSearch && fromSearch.includes('hash=')) {
      return fromSearch;
    }
  } catch {
    // Ignore malformed query
  }
  return '';
}

function readTelegramSessionInitParams(): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = sessionStorage.getItem('__telegram__initParams');
    if (raw) {
      const parsed = JSON.parse(raw) as { tgWebAppData?: unknown };
      if (typeof parsed?.tgWebAppData === 'string' && parsed.tgWebAppData.includes('hash=')) {
        return parsed.tgWebAppData;
      }
    }
  } catch {
    // Ignore sessionStorage / JSON errors
  }
  return '';
}

export function clearCachedTelegramInitData(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(TG_INIT_DATA_CACHE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function getTelegramInitData(): string {
  const tg = getTelegramWebApp();
  const sdkInitData = typeof tg?.initData === 'string' && tg.initData.length > 0 ? tg.initData : '';
  const urlInitData = readHashOrQueryInitData();
  const tgParamsInitData = readTelegramSessionInitParams();
  const resolved = sdkInitData || urlInitData || tgParamsInitData;

  if (resolved) {
    try {
      sessionStorage.setItem(TG_INIT_DATA_CACHE_KEY, resolved);
    } catch {
      // Ignore storage errors
    }
    return resolved;
  }

  try {
    const cached = sessionStorage.getItem(TG_INIT_DATA_CACHE_KEY) || '';
    if (cached && cached.includes('hash=')) {
      return cached;
    }
  } catch {
    // Ignore storage errors
  }
  return '';
}

export async function waitForTelegramInitData(maxWaitMs = 700): Promise<string> {
  const immediate = getTelegramInitData();
  if (immediate) return immediate;
  if (typeof window === 'undefined' || maxWaitMs <= 0) return '';

  return await new Promise<string>((resolve) => {
    let settled = false;
    const deadline = Date.now() + maxWaitMs;

    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('hashchange', onHashChange);
      clearInterval(timer);
      resolve(value);
    };

    const check = () => {
      initTelegramMiniApp();
      const found = getTelegramInitData();
      if (found) {
        finish(found);
        return;
      }
      if (Date.now() >= deadline) {
        finish('');
      }
    };

    const onHashChange = () => check();
    window.addEventListener('hashchange', onHashChange);
    const timer = window.setInterval(check, 70);
  });
}

export interface TelegramClientStatus {
  hasTelegramWebApp: boolean;
  platform: string;
  hasUnsafeUser: boolean;
  hasHashTgData: boolean;
  hasInitData: boolean;
}

export function getTelegramClientStatus(): TelegramClientStatus {
  const tg = getTelegramWebApp();
  const rawHash = typeof window !== 'undefined' ? window.location.hash || '' : '';
  return {
    hasTelegramWebApp: Boolean(tg),
    platform: typeof tg?.platform === 'string' ? tg.platform : '',
    hasUnsafeUser: Boolean(tg?.initDataUnsafe?.user?.id),
    hasHashTgData: rawHash.includes('tgWebAppData='),
    hasInitData: Boolean(getTelegramInitData()),
  };
}

export function triggerHaptic(style: 'light' | 'medium' | 'heavy' = 'light') {
  try {
    getTelegramWebApp()?.HapticFeedback?.impactOccurred(style);
  } catch {
    // No-op outside Telegram
  }
}

export function syncTelegramBackButton(show: boolean, onBack: () => void) {
  const bb = getTelegramWebApp()?.BackButton;
  if (!bb) return () => {};
  try {
    if (show) {
      bb.show();
      bb.onClick(onBack);
    } else {
      bb.hide();
    }
    return () => {
      try {
        bb.offClick(onBack);
      } catch {
        // Ignore cleanup errors
      }
    };
  } catch {
    return () => {};
  }
}

export type TelegramInvoiceStatus = 'paid' | 'cancelled' | 'failed' | 'pending' | 'unavailable';

export function openTelegramInvoice(invoiceUrl: string): Promise<TelegramInvoiceStatus> {
  const tg = getTelegramWebApp();
  if (!tg || typeof tg.openInvoice !== 'function') {
    return Promise.resolve('unavailable');
  }
  return new Promise((resolve) => {
    try {
      tg.openInvoice!(invoiceUrl, (status: string) => {
        if (status === 'paid' || status === 'cancelled' || status === 'failed' || status === 'pending') {
          resolve(status);
        } else {
          resolve('pending');
        }
      });
    } catch {
      resolve('unavailable');
    }
  });
}
