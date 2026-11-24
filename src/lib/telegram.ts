interface TelegramWebApp {
  initData: string;
  platform?: string;
  version?: string;
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
  close?: () => void;
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

export type TelegramInitDataSource =
  | 'Telegram.WebApp.initData'
  | 'url_hash'
  | 'url_search'
  | 'telegram_session_params'
  | 'cached_session'
  | 'none';

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

export function closeTelegramMiniApp(): boolean {
  const tg = getTelegramWebApp();
  if (!tg || typeof tg.close !== 'function') return false;
  try {
    tg.close();
    return true;
  } catch {
    return false;
  }
}

function readHashInitData(): string {
  if (typeof window === 'undefined') return '';
  try {
    let rawHash = (window.location.hash || '').replace(/^#/, '');
    if (rawHash.includes('?') && !rawHash.startsWith('tgWebAppData=')) {
      rawHash = rawHash.slice(rawHash.indexOf('?') + 1);
    }
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
  return '';
}

function readSearchInitData(): string {
  if (typeof window === 'undefined') return '';
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

export function getTelegramInitDataWithSource(): {
  initData: string;
  source: TelegramInitDataSource;
} {
  const tg = getTelegramWebApp();
  if (typeof tg?.initData === 'string' && tg.initData.length > 0) {
    try {
      sessionStorage.setItem(TG_INIT_DATA_CACHE_KEY, tg.initData);
    } catch {
      // Ignore storage errors
    }
    return { initData: tg.initData, source: 'Telegram.WebApp.initData' };
  }

  const fromHash = readHashInitData();
  if (fromHash) {
    try {
      sessionStorage.setItem(TG_INIT_DATA_CACHE_KEY, fromHash);
    } catch {
      // Ignore storage errors
    }
    return { initData: fromHash, source: 'url_hash' };
  }

  const fromSearch = readSearchInitData();
  if (fromSearch) {
    try {
      sessionStorage.setItem(TG_INIT_DATA_CACHE_KEY, fromSearch);
    } catch {
      // Ignore storage errors
    }
    return { initData: fromSearch, source: 'url_search' };
  }

  const fromTgParams = readTelegramSessionInitParams();
  if (fromTgParams) {
    try {
      sessionStorage.setItem(TG_INIT_DATA_CACHE_KEY, fromTgParams);
    } catch {
      // Ignore storage errors
    }
    return { initData: fromTgParams, source: 'telegram_session_params' };
  }

  try {
    const cached = sessionStorage.getItem(TG_INIT_DATA_CACHE_KEY) || '';
    if (cached && cached.includes('hash=')) {
      return { initData: cached, source: 'cached_session' };
    }
  } catch {
    // Ignore storage errors
  }

  return { initData: '', source: 'none' };
}

export function getTelegramInitData(): string {
  return getTelegramInitDataWithSource().initData;
}

export async function waitForTelegramInitData(
  maxWaitMs = 700
): Promise<{ initData: string; source: TelegramInitDataSource }> {
  const immediate = getTelegramInitDataWithSource();
  if (immediate.initData) return immediate;
  if (typeof window === 'undefined' || maxWaitMs <= 0) {
    return { initData: '', source: 'none' };
  }

  return await new Promise<{ initData: string; source: TelegramInitDataSource }>((resolve) => {
    let settled = false;
    const deadline = Date.now() + maxWaitMs;

    const finish = (result: { initData: string; source: TelegramInitDataSource }) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('hashchange', onHashChange);
      clearInterval(timer);
      resolve(result);
    };

    const check = () => {
      initTelegramMiniApp();
      const found = getTelegramInitDataWithSource();
      if (found.initData) {
        finish(found);
        return;
      }
      if (Date.now() >= deadline) {
        finish({ initData: '', source: 'none' });
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
  version: string;
  hasUnsafeUser: boolean;
  hasHashTgData: boolean;
  hasInitData: boolean;
  initDataSource: TelegramInitDataSource;
  initDataLength: number;
}

export function getTelegramClientStatus(): TelegramClientStatus {
  const tg = getTelegramWebApp();
  const rawHash = typeof window !== 'undefined' ? window.location.hash || '' : '';
  const resolved = getTelegramInitDataWithSource();
  return {
    hasTelegramWebApp: Boolean(tg),
    platform: typeof tg?.platform === 'string' ? tg.platform : '',
    version: typeof tg?.version === 'string' ? tg.version : '',
    hasUnsafeUser: Boolean(tg?.initDataUnsafe?.user?.id),
    hasHashTgData: rawHash.includes('tgWebAppData='),
    hasInitData: Boolean(resolved.initData),
    initDataSource: resolved.source,
    initDataLength: resolved.initData.length,
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
