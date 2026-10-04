import { Injectable, effect, inject, signal } from '@angular/core';
import { Socket, io } from 'socket.io-client';
import { AuthService } from './auth.service';
import { NotificationsApi } from './api/notifications.api';
import { Notification } from './models';

/** Keeps the notification list + unread count in sync over Socket.IO (`/notifications`). */
@Injectable({ providedIn: 'root' })
export class NotificationsSocketService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(NotificationsApi);
  private socket: Socket | null = null;
  private connectedToken: string | null = null;

  readonly items = signal<Notification[]>([]);
  readonly unreadCount = signal(0);
  readonly connected = signal(false);
  readonly available = signal(true);

  constructor() {
    effect(() => {
      const token = this.auth.token();
      if (token && token !== this.connectedToken) {
        this.connect(token);
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

  private connect(token: string) {
    this.disconnect();
    this.connectedToken = token;
    this.socket = io('/notifications', { auth: { token }, transports: ['websocket', 'polling'], reconnectionAttempts: 5 });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on('connect_error', () => this.connected.set(false));
    this.socket.on('notification', (n: Notification) => {
      this.items.update((list) => [n, ...list.filter((x) => x.id !== n.id)].slice(0, 50));
      if (!n.readAt) this.unreadCount.update((c) => c + 1);
    });
    this.socket.on('unread-count', (p: { count: number }) => this.unreadCount.set(p?.count ?? 0));
  }

  private disconnect() {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.connectedToken = null;
    this.connected.set(false);
  }
}
