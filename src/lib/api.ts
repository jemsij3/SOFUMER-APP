let inMemoryToken: string | null = null;

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;

  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export function getUserToken(): string | null {
  return inMemoryToken;
}

export function setUserToken(token: string | null) {
  inMemoryToken = token ? String(token).trim() || null : null;
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
    cache: 'no-store',
    headers: mergedHeaders,
  });

  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    throw new ApiError(
      typeof data.error === 'string' && data.error ? data.error : `Request failed (${resp.status})`,
      resp.status,
      data
    );
  }
  return data as T;
}

export async function apiDownload(url: string, fallbackFilename = 'download.bin'): Promise<void> {
  const token = getUserToken();
  const resp = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!resp.ok) {
    const errJson = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(errJson.error || `Download failed (${resp.status})`, resp.status, errJson);
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
