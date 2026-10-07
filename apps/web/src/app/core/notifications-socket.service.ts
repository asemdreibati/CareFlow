import { Injectable, effect, inject, signal } from '@angular/core';
import { Socket, io } from 'socket.io-client';
import { AuthService, SessionChangedError } from './auth.service';
import { NotificationsApi } from './api/notifications.api';
import { Notification } from './models';

/** Socket.IO `connect_error` that means "bad/expired token" (the gateway rejects the handshake). */
export function isSocketAuthError(err: unknown): boolean {
  const e = err as { message?: string; data?: { status?: number; code?: string; message?: string } } | null;
  if (e?.data?.status === 401 || e?.data?.status === 403) return true;
  return /unauthori[sz]ed|jwt|token|expired|forbidden|auth/i.test(`${e?.message ?? ''} ${e?.data?.code ?? ''} ${e?.data?.message ?? ''}`);
}

/** True when a JWT's `exp` is in the past (or within `skewMs`). Unparseable tokens are treated as not expired. */
export function jwtExpired(token: string | null | undefined, now = Date.now(), skewMs = 5_000): boolean {
  try {
    const payload = token?.split('.')[1];
    if (!payload) return false;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof json.exp === 'number' && json.exp * 1000 <= now + skewMs;
  } catch {
    return false;
  }
}

/**
 * Keeps the notification list + unread count in sync over Socket.IO (`/notifications`).
 * Reconnects whenever the access token or the active clinic changes (rooms are clinic-scoped). When the
 * handshake is rejected or the server drops us because the token expired, it triggers the shared
 * `AuthService.refreshShared()` (deduplicated with the HTTP interceptor) and reconnects with the new token.
 */
@Injectable({ providedIn: 'root' })
export class NotificationsSocketService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(NotificationsApi);
  private socket: Socket | null = null;
  private connectedToken: string | null = null;
  private connectedClinic: string | null = null;
  /** Token we already tried to recover from (one refresh attempt per token avoids reconnect loops). */
  private recoveredToken: string | null = null;

  readonly items = signal<Notification[]>([]);
  readonly unreadCount = signal(0);
  readonly connected = signal(false);
  readonly available = signal(true);

  constructor() {
    effect(() => {
      const token = this.auth.token();
      const clinicId = this.auth.clinic()?.id ?? null;
      if (token && (token !== this.connectedToken || clinicId !== this.connectedClinic)) {
        this.connect(token, clinicId);
        this.load();
      } else if (!token) {
        this.disconnect();
        this.items.set([]);
        this.unreadCount.set(0);
      }
    });
  }

  load() {
    this.api.list().subscribe({
      next: (r) => {
        this.items.set(r.items ?? []);
        this.unreadCount.set(r.unreadCount ?? 0);
        this.available.set(true);
      },
      error: () => this.available.set(false),
    });
  }

  markRead(n: Notification) {
    if (n.readAt) return;
    const readAt = new Date().toISOString();
    this.items.update((list) => list.map((x) => (x.id === n.id ? { ...x, readAt } : x)));
    this.unreadCount.update((c) => Math.max(0, c - 1));
    this.api.markRead(n.id).subscribe({ error: () => this.load() });
  }

  readAll() {
    const readAt = new Date().toISOString();
    this.items.update((list) => list.map((x) => (x.readAt ? x : { ...x, readAt })));
    this.unreadCount.set(0);
    this.api.readAll().subscribe({ error: () => this.load() });
  }

  private connect(token: string, clinicId: string | null) {
    this.disconnect();
    this.connectedToken = token;
    this.connectedClinic = clinicId;
    this.socket = io('/notifications', { auth: { token }, transports: ['websocket', 'polling'], reconnectionAttempts: 5 });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', (reason: string) => {
      this.connected.set(false);
      // The gateway disconnects sockets whose token expired; socket.io won't auto-reconnect after a server disconnect.
      if (reason === 'io server disconnect') this.recoverAuth(token, true);
    });
    this.socket.on('connect_error', (err: unknown) => {
      this.connected.set(false);
      if (isSocketAuthError(err) || jwtExpired(token)) this.recoverAuth(token, false);
    });
    this.socket.on('notification', (n: Notification) => {
      this.items.update((list) => [n, ...list.filter((x) => x.id !== n.id)].slice(0, 50));
      if (!n.readAt) this.unreadCount.update((c) => c + 1);
    });
    this.socket.on('unread-count', (p: { count: number }) => this.unreadCount.set(p?.count ?? 0));
  }

  /**
   * Refreshes the access token (shared with the interceptor's in-flight refresh); the token change then
   * reconnects via the effect. A failed refresh leaves the socket offline — the next HTTP 401 ends the session.
   */
  private recoverAuth(token: string, serverDisconnect: boolean) {
    if (this.recoveredToken === token || token !== this.auth.token() || !this.auth.tokens()?.refreshToken) return;
    this.recoveredToken = token;
    // Another tab may already hold a fresher token.
    this.auth.syncFromStorage();
    if (this.auth.token() !== token) return;
    if (serverDisconnect && !jwtExpired(token)) {
      // Dropped for another reason (deploy, clinic-scope change): reconnect once with the same token.
      if (this.connectedToken === token) this.connect(token, this.connectedClinic);
      return;
    }
    this.auth.refreshShared().subscribe({
      error: (err: unknown) => { if (!(err instanceof SessionChangedError)) this.connected.set(false); },
    });
  }

  private disconnect() {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.connectedToken = null;
    this.connectedClinic = null;
    this.connected.set(false);
  }
}
