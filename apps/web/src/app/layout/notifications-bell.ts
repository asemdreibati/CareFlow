import { Component, ElementRef, HostListener, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { NotificationsSocketService } from '../core/notifications-socket.service';
import { LanguageService } from '../core/i18n/language.service';
import { Notification } from '../core/models';

@Component({
  selector: 'cf-notifications-bell',
  imports: [TranslatePipe],
  template: `
    <div class="bell-wrap">
      <button type="button" class="btn ghost icon" (click)="open.set(!open())" [attr.aria-label]="'notifications.title' | translate">
        🔔
        @if (svc.unreadCount() > 0) { <span class="badge">{{ svc.unreadCount() > 99 ? '99+' : svc.unreadCount() }}</span> }
      </button>
      @if (open()) {
        <div class="dropdown panel">
          <div class="head">
            <strong>{{ 'notifications.title' | translate }}</strong>
            <div class="row gap-1">
              <span class="dot" [class.on]="svc.connected()" [title]="(svc.connected() ? 'notifications.live' : 'notifications.offline') | translate"></span>
              <button type="button" class="btn ghost xs" (click)="svc.readAll()" [disabled]="!svc.unreadCount()">{{ 'notifications.markAllRead' | translate }}</button>
            </div>
          </div>
          <div class="items">
            @for (n of svc.items(); track n.id) {
              <button type="button" class="n" [class.unread]="!n.readAt" (click)="openItem(n)">
                <div class="row between"><span class="strong">{{ n.title }}</span><span class="subtle nowrap">{{ lang.formatDateTime(n.createdAt) }}</span></div>
                <div class="muted small">{{ n.body }}</div>
              </button>
            } @empty {
              <div class="empty">{{ (svc.available() ? 'notifications.empty' : 'notifications.unavailable') | translate }}</div>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .bell-wrap { position: relative; }
    .badge { position: absolute; top: 2px; inset-inline-end: 2px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--cf-danger); color: #fff; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
    .panel { width: 360px; max-width: calc(100vw - 24px); padding: 0; }
    .head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--cf-border); }
    .items { max-height: 380px; overflow-y: auto; }
    .n { display: block; width: 100%; text-align: start; padding: 10px 12px; border: none; border-bottom: 1px solid var(--cf-border); background: none; font: inherit; cursor: pointer; }
    .n:hover { background: var(--cf-surface-2); }
    .n.unread { background: #f0fdfa; }
    .n:last-child { border-bottom: none; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--cf-text-3); }
    .dot.on { background: var(--cf-success); }
  `],
})
export class NotificationsBellComponent {
  readonly svc = inject(NotificationsSocketService);
  readonly lang = inject(LanguageService);
  private readonly router = inject(Router);
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly open = signal(false);

  openItem(n: Notification) {
    this.svc.markRead(n);
    const d = (n.data ?? {}) as Record<string, unknown>;
    const apptId = (d['appointmentId'] as string) ?? (n.type.startsWith('APPOINTMENT') || n.type === 'PATIENT_CHECKED_IN' ? (d['id'] as string) : undefined);
    const invoiceId = (d['invoiceId'] as string) ?? (n.type.startsWith('INVOICE') || n.type === 'PAYMENT_RECEIVED' ? (d['id'] as string) : undefined);
    if (apptId) void this.router.navigate(['/appointments', apptId]);
    else if (invoiceId) void this.router.navigate(['/billing/invoices', invoiceId]);
    this.open.set(false);
  }
  @HostListener('document:click', ['$event']) onDoc(e: Event) {
    if (!this.host.nativeElement.contains(e.target as Node)) this.open.set(false);
  }
}
