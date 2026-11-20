interface TelegramWebApp {
  initData: string;
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
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

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

export function getTelegramInitData(): string {
  const tg = getTelegramWebApp();
  return tg?.initData || '';
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
