import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { BillingApi } from '../../core/api/billing.api';
import { LanguageService } from '../../core/i18n/language.service';
import { BillingSummary } from '../../core/models';
import { PageHeaderComponent } from '../../shared/page-header';
import { InvoicesTab } from './invoices-tab';
import { ServicesTab } from './services-tab';

@Component({
  selector: 'cf-billing',
  imports: [TranslatePipe, PageHeaderComponent, InvoicesTab, ServicesTab],
  template: `
    <div class="page">
      <cf-page-header [title]="'billing.title' | translate" [subtitle]="'billing.subtitle' | translate" />
      @if (summary(); as s) {
        <div class="grid grid-4 mb-2">
          <div class="card stat"><span class="label">{{ 'billing.invoiced' | translate }}</span><span class="value">{{ lang.formatMoney(s.invoiced) }}</span></div>
          <div class="card stat"><span class="label">{{ 'billing.collected' | translate }}</span><span class="value success-text">{{ lang.formatMoney(s.collected) }}</span></div>
          <div class="card stat"><span class="label">{{ 'billing.outstanding' | translate }}</span><span class="value" [class.danger-text]="s.outstanding > 0">{{ lang.formatMoney(s.outstanding) }}</span></div>
          <div class="card stat"><span class="label">{{ 'billing.byStatus' | translate }}</span><span class="small">@for (kv of entries(s.byStatus); track kv[0]) { <div class="row between"><span class="muted">{{ lang.enumLabel(kv[0], 'status') }}</span><strong>{{ lang.formatNumber(kv[1]) }}</strong></div> }</span></div>
        </div>
      } @else if (summaryError()) { <div class="inline-alert info mb-2">{{ summaryError() }}</div> }
      <div class="tabs">
        <button type="button" [class.active]="tab() === 'invoices'" (click)="tab.set('invoices')">{{ 'billing.invoices' | translate }}</button>
        <button type="button" [class.active]="tab() === 'services'" (click)="tab.set('services')">{{ 'billing.services' | translate }}</button>
      </div>
      @switch (tab()) {
        @case ('invoices') { <cf-invoices-tab [patientId]="patientId" (changed)="loadSummary()" /> }
        @case ('services') { <cf-services-tab /> }
      }
    </div>
  `,
})
export class BillingPage {
  private readonly api = inject(BillingApi);
  private readonly route = inject(ActivatedRoute);
  readonly lang = inject(LanguageService);
  readonly tab = signal<'invoices' | 'services'>('invoices');
  readonly summary = signal<BillingSummary | null>(null);
  readonly summaryError = signal<string | null>(null);
  readonly patientId = this.route.snapshot.queryParamMap.get('patientId') ?? '';
  readonly entries = (o: Record<string, number> | undefined) => Object.entries(o ?? {});
  constructor() { this.loadSummary(); }
  loadSummary() {
    this.api.summary().subscribe({ next: (s) => this.summary.set(s), error: () => this.summaryError.set(this.lang.t('billing.summaryUnavailable')) });
  }
}
