import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { BillingApi } from '../../core/api/billing.api';
import { AuthService } from '../../core/auth.service';
import { BillingSummary } from '../../core/models';
import { money } from '../../core/money';
import { PageHeaderComponent } from '../../shared/page-header';
import { InvoicesTab } from './invoices-tab';
import { ServicesTab } from './services-tab';

@Component({
  selector: 'cf-billing',
  imports: [PageHeaderComponent, InvoicesTab, ServicesTab],
  template: `
    <div class="page">
      <cf-page-header title="Billing" subtitle="Invoices, payments and price list" />
      @if (summary(); as s) {
        <div class="grid grid-4 mb-2">
          <div class="card stat"><span class="label">Invoiced</span><span class="value">{{ money(s.invoiced) }}</span></div>
          <div class="card stat"><span class="label">Collected</span><span class="value success-text">{{ money(s.collected) }}</span></div>
          <div class="card stat"><span class="label">Outstanding</span><span class="value" [class.danger-text]="s.outstanding > 0">{{ money(s.outstanding) }}</span></div>
          <div class="card stat"><span class="label">By status</span><span class="small">@for (kv of entries(s.byStatus); track kv[0]) { <div class="row between"><span class="muted">{{ kv[0] }}</span><strong>{{ kv[1] }}</strong></div> }</span></div>
        </div>
      } @else if (summaryError()) { <div class="inline-alert info mb-2">{{ summaryError() }}</div> }
      <div class="tabs">
        <button type="button" [class.active]="tab() === 'invoices'" (click)="tab.set('invoices')">Invoices</button>
        <button type="button" [class.active]="tab() === 'services'" (click)="tab.set('services')">Services</button>
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
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  readonly money = (v: number) => money(v, this.auth.clinic()?.currency);
  readonly tab = signal<'invoices' | 'services'>('invoices');
  readonly summary = signal<BillingSummary | null>(null);
  readonly summaryError = signal<string | null>(null);
  readonly patientId = this.route.snapshot.queryParamMap.get('patientId') ?? '';
  readonly entries = (o: Record<string, number> | undefined) => Object.entries(o ?? {});
  constructor() { this.loadSummary(); }
  loadSummary() {
    this.api.summary().subscribe({ next: (s) => this.summary.set(s), error: () => this.summaryError.set('Billing summary is not available yet.') });
  }
}
