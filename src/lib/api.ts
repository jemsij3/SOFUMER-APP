const USER_TOKEN_KEY = 'sofumer_session_token';
const ADMIN_TOKEN_KEY = 'sofumer_admin_token';

export function getUserToken(): string | null {
  try {
    return sessionStorage.getItem(USER_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setUserToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(USER_TOKEN_KEY, token);
    else sessionStorage.removeItem(USER_TOKEN_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function getAdminToken(): string | null {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // Ignore storage errors
  }
}

export async function apiFetch<T>(
  url: string,
  options: RequestInit & { isAdmin?: boolean } = {}
): Promise<T> {
  const { isAdmin, headers, body, ...rest } = options;
  const token = isAdmin ? getAdminToken() : getUserToken();
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
