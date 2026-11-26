const LEGACY_TOKEN_KEY = 'clinic360_token';
let memoryToken: string | null = null;

try {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
  }
} catch {
  // ignore storage access errors
}

export function getAuthToken(): string | null {
  return memoryToken;
}

export function setAuthToken(token: string | null): void {
  memoryToken = token || null;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(LEGACY_TOKEN_KEY);
    }
  } catch {
    // ignore storage access errors
  }
}

export class ApiError extends Error {
  status: number;
  data?: Record<string, unknown>;
  constructor(status: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function apiFetch<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    ...options,
    credentials: options.credentials ?? 'include',
    headers,
  });
  const rawText = await res.text();

  let data: Record<string, unknown> = {};
  if (rawText) {
    try {
      data = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      if (res.ok) {
        throw new ApiError(res.status, 'Server returned non-JSON response. Please retry.');
      }
    }
  }

  if (!res.ok) {
    const errMsg = typeof data.error === 'string' ? data.error : `Request failed (${res.status})`;
    throw new ApiError(res.status, errMsg, data);
  }

  return data as T;
}
