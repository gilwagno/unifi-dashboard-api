const BASE_URL = '/api';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface UniFiSite {
  id: string;
  internalReference?: string;
  name: string;
}

export interface UniFiClient {
  id: string;
  macAddress: string;
  ipAddress?: string;
  name?: string;
  hostname?: string;
  connectedAt?: string;
  type: 'WIRED' | 'WIRELESS';
  blocked: boolean;
}

export interface UniFiDevice {
  id: string;
  name: string;
  model: string;
  macAddress: string;
  ipAddress?: string;
  state: 'ONLINE' | 'OFFLINE' | 'PENDING' | 'UPDATING';
}

export interface UniFiEventRecord {
  receivedAt: string;
  data: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

let accessToken: string | null = localStorage.getItem('unifi_token');
let refreshToken: string | null = localStorage.getItem('unifi_refresh_token');

export function getAccessToken() {
  return accessToken;
}

function setTokens(token: string, refresh?: string) {
  accessToken = token;
  localStorage.setItem('unifi_token', token);
  if (refresh) {
    refreshToken = refresh;
    localStorage.setItem('unifi_refresh_token', refresh);
  }
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem('unifi_token');
  localStorage.removeItem('unifi_refresh_token');
}

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshToken) return false;
  const res = await fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;
  const body = await res.json();
  setTokens(body.token);
  return true;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });

  if (res.status === 401 && retry && refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request<T>(path, init, false);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  async login(username: string, password: string) {
    const body = await request<{ token: string; refreshToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setTokens(body.token, body.refreshToken);
    return body;
  },

  logout() {
    clearTokens();
  },

  listSites: () => request<{ data: UniFiSite[] }>('/sites'),

  listClients: (params: { page?: number; pageSize?: number; type?: string; blocked?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.type && params.type !== 'ALL') qs.set('type', params.type);
    if (params.blocked !== undefined) qs.set('blocked', String(params.blocked));
    return request<{ data: UniFiClient[]; pagination: Pagination }>(`/clients?${qs.toString()}`);
  },

  blockClient: (mac: string) => request<{ ok: true }>(`/clients/${mac}/block`, { method: 'POST' }),
  unblockClient: (mac: string) => request<{ ok: true }>(`/clients/${mac}/unblock`, { method: 'POST' }),

  listDevices: (params: { page?: number; pageSize?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    return request<{ data: UniFiDevice[]; pagination: Pagination }>(`/devices?${qs.toString()}`);
  },

  restartDevice: (id: string) => request<{ ok: true }>(`/devices/${id}/restart`, { method: 'POST' }),

  eventsHistory: (limit = 50) => request<{ data: UniFiEventRecord[] }>(`/events/history?limit=${limit}`),
};
