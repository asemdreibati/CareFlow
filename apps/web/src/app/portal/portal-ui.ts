import { Component, computed, inject, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService } from '../core/i18n/language.service';
import type { PortalAppointment, PortalDoctor, PortalInvoice } from './portal.models';

/** Minimum notice (ms) for cancelling online — mirrors the API's 2-hour rule. */
export const CANCEL_NOTICE_MS = 2 * 60 * 60 * 1000;

const CHIP_COLORS: Record<string, string> = {
  SCHEDULED: 'blue', CONFIRMED: 'teal', CHECKED_IN: 'purple', IN_PROGRESS: 'amber', COMPLETED: 'green', CANCELLED: 'red', NO_SHOW: 'gray',
  DRAFT: 'gray', ISSUED: 'blue', PARTIALLY_PAID: 'amber', PAID: 'green', VOID: 'red',
  WAITING: 'blue', OFFERED: 'amber', BOOKED: 'green', EXPIRED: 'gray',
};

/** Localised status chip (`portal.status.*`). */
@Component({
  selector: 'cf-portal-chip',
  imports: [TranslatePipe],
  template: `<span class="chip" [class]="'chip ' + color()"><span class="dot"></span>{{ key() | translate }}</span>`,
})
export class PortalChip {
  readonly status = input.required<string | null | undefined>();
  readonly color = computed(() => CHIP_COLORS[String(this.status() ?? '').toUpperCase()] ?? 'gray');
  readonly key = computed(() => `portal.status.${String(this.status() ?? 'SCHEDULED').toUpperCase()}`);
}

/** "Dr. Sara Salem" with the localised prefix. */
export function doctorName(d: Partial<PortalDoctor> | null | undefined, lang: LanguageService): string {
  if (!d) return '—';
  const prefix = d.title?.trim() || lang.t('portal.common.dr');
  return `${prefix} ${d.firstName ?? ''} ${d.lastName ?? ''}`.replace(/\s+/g, ' ').trim();
}

export const num = (v: number | string | null | undefined): number => (v === null || v === undefined || v === '' ? 0 : Number(v));

/** Remaining balance of one invoice (never negative). */
export function invoiceBalance(inv: Pick<PortalInvoice, 'total' | 'amountPaid' | 'status'>): number {
  if (inv.status === 'VOID' || inv.status === 'DRAFT') return 0;
  return Math.max(0, num(inv.total) - num(inv.amountPaid));
}
/** Sum of balances over open invoices (ISSUED / PARTIALLY_PAID). */
export function outstandingBalance(invoices: readonly PortalInvoice[]): number {
  return invoices.filter((i) => i.status === 'ISSUED' || i.status === 'PARTIALLY_PAID').reduce((s, i) => s + invoiceBalance(i), 0);
}

export const isOpen = (a: Pick<PortalAppointment, 'status'>) => a.status === 'SCHEDULED' || a.status === 'CONFIRMED';
/** Online cancellation is allowed ≥ 2 h before the start for open appointments. */
export function canCancelOnline(a: Pick<PortalAppointment, 'status' | 'startsAt'>, now: number = Date.now()): boolean {
  return isOpen(a) && new Date(a.startsAt).getTime() - now >= CANCEL_NOTICE_MS;
}
export const canConfirm = (a: Pick<PortalAppointment, 'status' | 'startsAt'>, now: number = Date.now()) =>
  a.status === 'SCHEDULED' && new Date(a.startsAt).getTime() > now;

/** Shared date helpers bound to the active locale. */
export function useFormat() {
  const lang = inject(LanguageService);
  return {
    lang,
    date: (v: string | Date | null | undefined) => (v ? lang.formatDate(v, { weekday: 'short', day: 'numeric', month: 'short' }) : '—'),
    longDate: (v: string | Date | null | undefined) => (v ? lang.formatDate(v, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '—'),
    time: (v: string | Date | null | undefined) => (v ? lang.formatTime(v) : '—'),
    dateTime: (v: string | Date | null | undefined) => (v ? `${lang.formatDate(v, { weekday: 'short', day: 'numeric', month: 'short' })} · ${lang.formatTime(v)}` : '—'),
    day: (v: string | Date) => lang.formatDate(v, { day: 'numeric' }),
    month: (v: string | Date) => lang.formatDate(v, { month: 'short' }),
    money: (v: number | string | null | undefined, currency: string) => lang.formatMoney(num(v), currency || 'SAR'),
    doctor: (d: Partial<PortalDoctor> | null | undefined) => doctorName(d, lang),
  };
}
