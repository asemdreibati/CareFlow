import { Component, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { BillingApi } from '../../../core/api/billing.api';
import { LanguageService } from '../../../core/i18n/language.service';
import { Invoice, Patient } from '../../../core/models';
import { num } from '../../../core/money';
import { StatusChipComponent } from '../../../shared/status-chip';

@Component({
  selector: 'cf-patient-invoices',
  imports: [RouterLink, TranslatePipe, StatusChipComponent],
  template: `
    <div class="card">
      <div class="card-header"><h3>{{ 'billing.invoices' | translate }}</h3><a class="btn sm" routerLink="/billing" [queryParams]="{ patientId: p().id }">{{ 'billing.open' | translate }}</a></div>
      @if (loading()) { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
      @else if (error()) { <div class="empty">{{ error() }}</div> }
      @else {
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>{{ 'billing.number' | translate }}</th><th>{{ 'common.created' | translate }}</th><th>{{ 'billing.due' | translate }}</th><th class="num">{{ 'common.total' | translate }}</th><th class="num">{{ 'billing.paid' | translate }}</th><th class="num">{{ 'billing.balance' | translate }}</th><th>{{ 'common.status' | translate }}</th></tr></thead>
            <tbody>
              @for (i of invoices(); track i.id) {
                <tr>
                  <td><a [routerLink]="['/billing/invoices', i.id]" class="mono">{{ i.number }}</a></td>
                  <td>{{ lang.formatDate(i.createdAt) }}</td>
                  <td>{{ lang.formatDate(i.dueAt) }}</td>
                  <td class="num">{{ lang.formatMoney(i.total, i.currency) }}</td>
                  <td class="num">{{ lang.formatMoney(i.amountPaid, i.currency) }}</td>
                  <td class="num strong">{{ lang.formatMoney(num(i.total) - num(i.amountPaid), i.currency) }}</td>
                  <td><cf-chip [status]="i.status" group="status" /></td>
                </tr>
              } @empty { <tr><td colspan="7" class="empty">{{ 'billing.noInvoices' | translate }}</td></tr> }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class PatientInvoicesTab {
  private readonly api = inject(BillingApi);
  readonly lang = inject(LanguageService);
  readonly p = input.required<Patient>({ alias: 'patient' });
  readonly num = num;
  readonly invoices = signal<Invoice[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  ngOnInit() {
    this.api.invoices({ patientId: this.p().id, pageSize: 50 }).subscribe({
      next: (r) => { this.invoices.set(r.items ?? []); this.loading.set(false); },
      error: (err) => { this.loading.set(false); this.error.set(this.lang.errorMessage(err, this.lang.t('billing.unavailable'))); },
    });
  }
}
