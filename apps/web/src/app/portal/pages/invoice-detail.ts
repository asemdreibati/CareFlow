import { Component, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { PortalApi } from '../portal-api.service';
import { PortalAuthService } from '../portal-auth.service';
import { PortalChip, invoiceBalance, num, useFormat } from '../portal-ui';
import { PortalInvoice } from '../portal.models';

@Component({
  selector: 'cf-portal-invoice-detail',
  imports: [RouterLink, TranslatePipe, PortalChip],
  template: `
    <div class="pt-fade">
      <a class="pt-btn ghost sm" routerLink="/portal/app/invoices" style="padding-inline:4px">‹ {{ 'portal.common.back' | translate }}</a>
      @if (loading()) { <div class="pt-loading"><span class="spinner"></span>{{ 'portal.common.loading' | translate }}</div> }
      @else if (!inv()) { <div class="pt-empty">{{ 'portal.invoices.notFound' | translate }}</div> }
      @else if (inv(); as inv) {
        <div class="pt-row between"><h1 class="pt-title" style="margin-bottom:8px">{{ 'portal.invoices.number' | translate }} {{ inv.number }}</h1><cf-portal-chip [status]="inv.status" /></div>
        <div class="pt-card" [class.warn]="balance(inv) > 0">
          <div class="pt-small pt-muted">{{ (balance(inv) > 0 ? 'portal.invoices.balance' : 'portal.invoices.total') | translate }}</div>
          <div class="pt-amount" [class.danger-text]="balance(inv) > 0">{{ f.money(balance(inv) > 0 ? balance(inv) : inv.total, cur(inv)) }}</div>
          <dl class="pt-kv" style="margin-top:10px">
            <dt>{{ 'portal.invoices.issued' | translate }}</dt><dd>{{ f.date(inv.issuedAt || inv.createdAt) }}</dd>
            @if (inv.dueAt) { <dt>{{ 'portal.invoices.due' | translate }}</dt><dd>{{ f.date(inv.dueAt) }}</dd> }
          </dl>
        </div>

        <div class="pt-section">{{ 'portal.invoices.items' | translate }}</div>
        <div class="pt-card">
          <table class="pt-table">
            <thead><tr><th>{{ 'portal.invoices.items' | translate }}</th><th class="num">{{ 'portal.invoices.qty' | translate }}</th><th class="num">{{ 'portal.invoices.total' | translate }}</th></tr></thead>
            <tbody>
              @for (it of inv.items ?? []; track $index) {
                <tr><td>{{ it.description }}</td><td class="num">{{ it.quantity }}</td><td class="num">{{ f.money(it.total ?? num(it.unitPrice) * it.quantity, cur(inv)) }}</td></tr>
              } @empty { <tr><td colspan="3" class="pt-muted">—</td></tr> }
            </tbody>
          </table>
          <dl class="pt-kv" style="margin-top:12px; grid-template-columns: 1fr auto">
            <dt>{{ 'portal.invoices.subtotal' | translate }}</dt><dd class="num">{{ f.money(inv.subtotal, cur(inv)) }}</dd>
            @if (num(inv.discount) > 0) { <dt>{{ 'portal.invoices.discount' | translate }}</dt><dd>−{{ f.money(inv.discount, cur(inv)) }}</dd> }
            @if (num(inv.tax) > 0) { <dt>{{ 'portal.invoices.tax' | translate }}</dt><dd>{{ f.money(inv.tax, cur(inv)) }}</dd> }
            <dt class="pt-strong">{{ 'portal.invoices.total' | translate }}</dt><dd class="pt-strong">{{ f.money(inv.total, cur(inv)) }}</dd>
            <dt>{{ 'portal.invoices.paid' | translate }}</dt><dd>{{ f.money(inv.amountPaid, cur(inv)) }}</dd>
            <dt class="pt-strong">{{ 'portal.invoices.balance' | translate }}</dt><dd class="pt-strong" [class.danger-text]="balance(inv) > 0">{{ f.money(balance(inv), cur(inv)) }}</dd>
          </dl>
        </div>

        <div class="pt-section">{{ 'portal.invoices.payments' | translate }}</div>
        <div class="pt-card">
          @for (p of inv.payments ?? []; track p.id) {
            <div class="pt-row between" style="padding:6px 0">
              <div><div class="pt-strong">{{ f.money(p.amount, cur(inv)) }}</div><div class="pt-small pt-muted">{{ ('portal.invoices.method.' + p.method) | translate }}@if (p.reference) { · {{ p.reference }} }</div></div>
              <div class="pt-small pt-muted">{{ f.date(p.paidAt) }}</div>
            </div>
          } @empty { <div class="pt-muted">{{ 'portal.invoices.noPayments' | translate }}</div> }
        </div>
      }
    </div>
  `,
  styles: [`.pt-table { width: 100%; border-collapse: collapse; font-size: 13.5px; } .pt-table th, .pt-table td { padding: 8px 4px; text-align: start; border-bottom: 1px solid var(--cf-border); } .pt-table th { font-size: 11.5px; text-transform: uppercase; color: var(--cf-text-2); letter-spacing: 0.04em; } .pt-table .num { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; } .pt-table tr:last-child td { border-bottom: none; }`],
})
export class PortalInvoiceDetailPage {
  readonly id = input.required<string>();
  readonly f = useFormat();
  readonly auth = inject(PortalAuthService);
  private readonly api = inject(PortalApi);
  readonly inv = signal<PortalInvoice | null>(null);
  readonly loading = signal(true);
  readonly balance = invoiceBalance;
  readonly num = num;

  constructor() { effect(() => this.load(this.id())); }
  cur(inv: PortalInvoice) { return inv.currency || this.auth.currency(); }
  load(id: string) {
    this.loading.set(true);
    this.api.invoice(id).subscribe({
      next: (i) => { this.inv.set(i); this.loading.set(false); },
      error: () => { this.inv.set(null); this.loading.set(false); },
    });
  }
}
