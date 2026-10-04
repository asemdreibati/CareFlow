import { Component, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BillingApi } from '../../../core/api/billing.api';
import { AuthService } from '../../../core/auth.service';
import { errorMessage } from '../../../core/toast.service';
import { Invoice, Patient } from '../../../core/models';
import { fmtDate } from '../../../core/date-utils';
import { money, num } from '../../../core/money';
import { StatusChipComponent } from '../../../shared/status-chip';

@Component({
  selector: 'cf-patient-invoices',
  imports: [RouterLink, StatusChipComponent],
  template: `
    <div class="card">
      <div class="card-header"><h3>Invoices</h3><a class="btn sm" routerLink="/billing" [queryParams]="{ patientId: p().id }">Open billing</a></div>
      @if (loading()) { <div class="loading"><span class="spinner"></span> Loading…</div> }
      @else if (error()) { <div class="empty">{{ error() }}</div> }
      @else {
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Number</th><th>Created</th><th>Due</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Balance</th><th>Status</th></tr></thead>
            <tbody>
              @for (i of invoices(); track i.id) {
                <tr>
                  <td><a [routerLink]="['/billing/invoices', i.id]" class="mono">{{ i.number }}</a></td>
                  <td>{{ fmtDate(i.createdAt) }}</td>
                  <td>{{ fmtDate(i.dueAt) }}</td>
                  <td class="num">{{ money(i.total, i.currency) }}</td>
                  <td class="num">{{ money(i.amountPaid, i.currency) }}</td>
                  <td class="num strong">{{ money(num(i.total) - num(i.amountPaid), i.currency) }}</td>
                  <td><cf-chip [status]="i.status" /></td>
                </tr>
              } @empty { <tr><td colspan="7" class="empty">No invoices.</td></tr> }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class PatientInvoicesTab {
  private readonly api = inject(BillingApi);
  private readonly auth = inject(AuthService);
  readonly p = input.required<Patient>({ alias: 'patient' });
  readonly fmtDate = fmtDate;
  readonly num = num;
  readonly money = (v: number | string, c?: string) => money(v, c || this.auth.clinic()?.currency);
  readonly invoices = signal<Invoice[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  ngOnInit() {
    this.api.invoices({ patientId: this.p().id, pageSize: 50 }).subscribe({
      next: (r) => { this.invoices.set(r.items ?? []); this.loading.set(false); },
      error: (err) => { this.loading.set(false); this.error.set(errorMessage(err, 'Billing is not available yet.')); },
    });
  }
}
