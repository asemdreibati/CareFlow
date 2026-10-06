import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { PortalApi } from '../portal-api.service';
import { PortalAuthService } from '../portal-auth.service';
import { PortalChip, invoiceBalance, useFormat } from '../portal-ui';
import { PortalInvoice } from '../portal.models';

@Component({
  selector: 'cf-portal-invoices',
  imports: [RouterLink, TranslatePipe, PortalChip],
  template: `
    <div class="pt-fade">
      <h1 class="pt-title">{{ 'portal.invoices.title' | translate }}</h1>
      @if (loading()) { <div class="pt-loading"><span class="spinner"></span>{{ 'portal.common.loading' | translate }}</div> }
      @else if (error()) { <div class="pt-alert error pt-row between">{{ error() }} <button type="button" class="pt-btn sm" (click)="load()">{{ 'portal.common.retry' | translate }}</button></div> }
      @else if (!items().length) { <div class="pt-empty"><div class="big">🧾</div>{{ 'portal.invoices.empty' | translate }}</div> }
      @else {
        <div class="pt-list">
          @for (inv of items(); track inv.id) {
            <a class="pt-item" [routerLink]="['/portal/app/invoices', inv.id]">
              <div class="body">
                <div class="pt-row between"><span class="primary">{{ 'portal.invoices.number' | translate }} {{ inv.number }}</span><cf-portal-chip [status]="inv.status" /></div>
                <div class="secondary">{{ f.date(inv.issuedAt || inv.createdAt) }} · {{ 'portal.invoices.total' | translate }} {{ f.money(inv.total, inv.currency || auth.currency()) }}</div>
                @if (balance(inv) > 0) { <div class="secondary danger-text pt-strong">{{ 'portal.invoices.balance' | translate }}: {{ f.money(balance(inv), inv.currency || auth.currency()) }}</div> }
              </div>
              <svg class="pt-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
            </a>
          }
        </div>
      }
    </div>
  `,
})
export class PortalInvoicesPage {
  readonly f = useFormat();
  readonly auth = inject(PortalAuthService);
  private readonly api = inject(PortalApi);
  readonly items = signal<PortalInvoice[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly balance = invoiceBalance;

  constructor() { this.load(); }
  load() {
    this.loading.set(true);
    this.error.set(null);
    this.api.invoices().subscribe({
      next: (list) => { this.items.set([...list].sort((a, b) => (b.issuedAt || b.createdAt).localeCompare(a.issuedAt || a.createdAt))); this.loading.set(false); },
      error: (err: unknown) => { this.loading.set(false); this.error.set((err as { status?: number })?.status === 0 ? this.f.lang.t('portal.errors.network') : this.f.lang.t('portal.errors.notAvailable')); },
    });
  }
}
