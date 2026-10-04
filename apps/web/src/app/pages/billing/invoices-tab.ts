import { Component, inject, input, output, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { BillingApi } from '../../core/api/billing.api';
import { AuthService } from '../../core/auth.service';
import { errorMessage } from '../../core/toast.service';
import { INVOICE_STATUSES, Invoice, InvoiceStatus } from '../../core/models';
import { fmtDate } from '../../core/date-utils';
import { money, num } from '../../core/money';
import { StatusChipComponent } from '../../shared/status-chip';
import { PaginationComponent } from '../../shared/pagination';
import { HasPermissionDirective } from '../../core/permission.directive';
import { CreateInvoiceDialog } from './create-invoice-dialog';

@Component({
  selector: 'cf-invoices-tab',
  imports: [RouterLink, StatusChipComponent, PaginationComponent, HasPermissionDirective, CreateInvoiceDialog],
  template: `
    <div class="card">
      <div class="card-header">
        <div class="row gap-1">
          <select class="input sm" style="width: 170px" [value]="status()" (change)="onStatus($event)">
            <option value="">All statuses</option>@for (s of statuses; track s) { <option [value]="s">{{ s.replace('_', ' ') }}</option> }
          </select>
          @if (patientId()) { <span class="chip teal">Filtered by patient <button type="button" class="btn ghost xs" (click)="clearPatient()">✕</button></span> }
        </div>
        <button *hasPermission="'billing:write'" type="button" class="btn sm primary" (click)="dialog.set(true)">+ New invoice</button>
      </div>
      @if (loading()) { <div class="loading"><span class="spinner"></span> Loading…</div> }
      @else if (error()) { <div class="empty">{{ error() }}</div> }
      @else {
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Number</th><th>Patient</th><th>Created</th><th>Due</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Balance</th><th>Status</th></tr></thead>
            <tbody>
              @for (i of items(); track i.id) {
                <tr class="clickable" (click)="open(i)">
                  <td class="mono">{{ i.number }}</td>
                  <td>@if (i.patient) { <a [routerLink]="['/patients', i.patientId]" (click)="$event.stopPropagation()">{{ i.patient.firstName }} {{ i.patient.lastName }}</a> } @else { — }</td>
                  <td class="nowrap">{{ fmtDate(i.createdAt) }}</td>
                  <td class="nowrap">{{ fmtDate(i.dueAt) }}</td>
                  <td class="num">{{ money(i.total, i.currency) }}</td>
                  <td class="num">{{ money(i.amountPaid, i.currency) }}</td>
                  <td class="num strong">{{ money(num(i.total) - num(i.amountPaid), i.currency) }}</td>
                  <td><cf-chip [status]="i.status" /></td>
                </tr>
              } @empty { <tr><td colspan="8" class="empty">No invoices.</td></tr> }
            </tbody>
          </table>
        </div>
        <cf-pagination [page]="page()" [pageSize]="pageSize" [total]="total()" (pageChange)="page.set($event); load()" />
      }
    </div>
    @if (dialog()) { <cf-create-invoice-dialog (closed)="dialog.set(false)" (created)="onCreated($event)" /> }
  `,
})
export class InvoicesTab {
  private readonly api = inject(BillingApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly patientId = input('');
  readonly changed = output<void>();
  readonly statuses = INVOICE_STATUSES;
  readonly fmtDate = fmtDate;
  readonly num = num;
  readonly money = (v: number | string, c?: string) => money(v, c || this.auth.clinic()?.currency);
  readonly pageSize = 25;
  readonly items = signal<Invoice[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly status = signal<InvoiceStatus | ''>('');
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly dialog = signal(false);
  private patientFilter = '';

  ngOnInit() { this.patientFilter = this.patientId(); this.load(); }
  onStatus(e: Event) { this.status.set((e.target as HTMLSelectElement).value as InvoiceStatus | ''); this.page.set(1); this.load(); }
  clearPatient() { this.patientFilter = ''; void this.router.navigate([], { queryParams: {} }); this.load(); }
  open(i: Invoice) { void this.router.navigate(['/billing/invoices', i.id]); }
  onCreated(i: Invoice) { this.dialog.set(false); this.changed.emit(); void this.router.navigate(['/billing/invoices', i.id]); }
  load() {
    this.loading.set(true);
    this.api.invoices({ status: this.status() || undefined, patientId: this.patientFilter || undefined, page: this.page(), pageSize: this.pageSize }).subscribe({
      next: (r) => { this.items.set(r.items ?? []); this.total.set(r.total ?? 0); this.loading.set(false); },
      error: (err) => { this.loading.set(false); this.error.set(errorMessage(err, 'Billing is not available yet.')); },
    });
  }
}
