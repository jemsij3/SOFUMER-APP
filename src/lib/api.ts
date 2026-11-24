const USER_TOKEN_KEY = 'sofumer_session_token';
let inMemoryToken: string | null = null;

export function getUserToken(): string | null {
  if (inMemoryToken) return inMemoryToken;
  try {
    const stored = sessionStorage.getItem(USER_TOKEN_KEY);
    if (stored) inMemoryToken = stored;
    return stored;
  } catch {
    return inMemoryToken;
  }
}

export function setUserToken(token: string | null) {
  inMemoryToken = token || null;
  try {
    if (token) sessionStorage.setItem(USER_TOKEN_KEY, token);
    else sessionStorage.removeItem(USER_TOKEN_KEY);
  } catch {
    // Ignore storage errors
  }
}

export async function apiFetch<T>(
  url: string,
  options: RequestInit & { isAdmin?: boolean } = {}
): Promise<T> {
  const { isAdmin: _isAdmin, headers, body, ...rest } = options;
  const token = getUserToken();
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

  const mergedHeaders: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(headers as Record<string, string> | undefined),
  };

  const resp = await fetch(url, {
    ...rest,
    body,
    credentials: 'include',
    headers: mergedHeaders,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error((data as { error?: string }).error || `Request failed (${resp.status})`);
  }
  return data as T;
}

export async function apiDownload(url: string, fallbackFilename = 'download.bin'): Promise<void> {
  const token = getUserToken();
  const resp = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!resp.ok) {
    const errJson = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(errJson.error || `Download failed (${resp.status})`);
  }

  const blob = await resp.blob();
  const disposition = resp.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
  const fileName = match?.[1] ? decodeURIComponent(match[1]) : fallbackFilename;

  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
  }
}
