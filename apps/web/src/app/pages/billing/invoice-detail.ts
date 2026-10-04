import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { BillingApi } from '../../core/api/billing.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmService } from '../../shared/confirm.service';
import { Invoice, PAYMENT_METHODS, PaymentMethod } from '../../core/models';
import { fmtDate, fmtDateTime } from '../../core/date-utils';
import { money, num } from '../../core/money';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { DialogComponent } from '../../shared/dialog';

@Component({
  selector: 'cf-invoice-detail',
  imports: [FormsModule, RouterLink, PageHeaderComponent, StatusChipComponent, DialogComponent],
  template: `
    <div class="page" style="max-width: 1000px">
      @if (inv(); as i) {
        <cf-page-header [title]="'Invoice ' + i.number" [subtitle]="'Created ' + fmtDate(i.createdAt) + (i.issuedAt ? ' · Issued ' + fmtDate(i.issuedAt) : '') + (i.dueAt ? ' · Due ' + fmtDate(i.dueAt) : '')">
          <cf-chip [status]="i.status" />
          <a class="btn" routerLink="/billing">All invoices</a>
          @if (canWrite) {
            @if (i.status === 'DRAFT') { <button type="button" class="btn primary" (click)="issue()" [disabled]="busy()">Issue</button> }
            @if (i.status === 'ISSUED' || i.status === 'PARTIALLY_PAID') { <button type="button" class="btn primary" (click)="openPay()" [disabled]="busy()">Record payment</button> }
            @if (i.status !== 'PAID' && i.status !== 'VOID') { <button type="button" class="btn danger-outline" (click)="voidInvoice()" [disabled]="busy()">Void</button> }
          }
        </cf-page-header>
        <div class="grid" style="grid-template-columns: 3fr 2fr">
          <div class="col">
            <div class="card">
              <div class="card-header"><h3>Items</h3></div>
              <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th></tr></thead>
                  <tbody>
                    @for (it of i.items ?? []; track $index) {
                      <tr><td>{{ it.description }}</td><td class="num">{{ it.quantity }}</td><td class="num">{{ money(it.unitPrice) }}</td><td class="num">{{ money(it.total ?? num(it.unitPrice) * it.quantity) }}</td></tr>
                    } @empty { <tr><td colspan="4" class="empty">No items</td></tr> }
                  </tbody>
                  <tfoot>
                    <tr><td colspan="3" class="num muted">Subtotal</td><td class="num">{{ money(i.subtotal) }}</td></tr>
                    <tr><td colspan="3" class="num muted">Discount</td><td class="num">− {{ money(i.discount) }}</td></tr>
                    <tr><td colspan="3" class="num muted">Tax</td><td class="num">+ {{ money(i.tax) }}</td></tr>
                    <tr class="strong"><td colspan="3" class="num">Total</td><td class="num">{{ money(i.total) }}</td></tr>
                    <tr><td colspan="3" class="num muted">Paid</td><td class="num success-text">{{ money(i.amountPaid) }}</td></tr>
                    <tr class="strong"><td colspan="3" class="num">Balance due</td><td class="num" [class.danger-text]="balance() > 0">{{ money(balance()) }}</td></tr>
                  </tfoot>
                </table>
              </div>
            </div>
            @if (i.notes) { <div class="card card-body"><div class="label-text">Notes</div><div style="white-space: pre-line">{{ i.notes }}</div></div> }
          </div>
          <div class="col">
            <div class="card">
              <div class="card-header"><h3>Patient</h3></div>
              <div class="card-body">
                @if (i.patient) { <a [routerLink]="['/patients', i.patientId]" class="strong">{{ i.patient.firstName }} {{ i.patient.lastName }}</a><div class="muted">{{ i.patient.mrn }}@if (i.patient.phone) { · {{ i.patient.phone }} }</div> }
                @else { <a [routerLink]="['/patients', i.patientId]">Open patient</a> }
              </div>
            </div>
            <div class="card">
              <div class="card-header"><h3>Payments</h3></div>
              <div class="card-body">
                @for (p of i.payments ?? []; track p.id) {
                  <div class="list-item"><div class="flex-1"><div class="strong">{{ money(p.amount) }}</div><div class="subtle">{{ fmtDateTime(p.paidAt) }} · {{ p.method.replace('_', ' ') }}@if (p.reference) { · {{ p.reference }} }</div></div></div>
                } @empty { <div class="muted">No payments recorded.</div> }
              </div>
            </div>
          </div>
        </div>
      } @else if (error()) { <div class="inline-alert error">{{ error() }}</div> }
      @else { <div class="loading"><span class="spinner"></span> Loading…</div> }
    </div>
    @if (payDialog()) {
      <cf-dialog title="Record payment" [width]="440" (closed)="payDialog.set(false)">
        <div class="field"><label class="req">Amount</label><input class="input" type="number" min="0.01" step="0.01" [(ngModel)]="pay.amount" /><div class="subtle">Balance due: {{ money(balance()) }}</div></div>
        <div class="field"><label class="req">Method</label><select class="input" [(ngModel)]="pay.method">@for (m of methods; track m) { <option [value]="m">{{ m.replace('_', ' ') }}</option> }</select></div>
        <div class="field"><label>Reference</label><input class="input" [(ngModel)]="pay.reference" placeholder="Receipt / transaction no." /></div>
        <div footer>
          <button type="button" class="btn" (click)="payDialog.set(false)">Cancel</button>
          <button type="button" class="btn primary" (click)="submitPay()" [disabled]="busy() || !(pay.amount > 0)">Record</button>
        </div>
      </cf-dialog>
    }
  `,
})
export class InvoiceDetailPage {
  private readonly api = inject(BillingApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  readonly id = input.required<string>();
  readonly fmtDate = fmtDate;
  readonly fmtDateTime = fmtDateTime;
  readonly num = num;
  readonly methods = PAYMENT_METHODS;
  readonly canWrite = this.auth.hasPermission('billing:write');
  readonly inv = signal<Invoice | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly payDialog = signal(false);
  readonly balance = computed(() => (this.inv() ? num(this.inv()!.total) - num(this.inv()!.amountPaid) : 0));
  readonly money = (v: number | string | null | undefined) => money(v, this.inv()?.currency || this.auth.clinic()?.currency);
  pay: { amount: number; method: PaymentMethod; reference: string } = { amount: 0, method: 'CASH', reference: '' };

  ngOnInit() { this.load(); }
  load() { this.api.invoice(this.id()).subscribe({ next: (i) => this.inv.set(i), error: (err) => { this.error.set('Could not load invoice.'); this.toast.fromError(err); } }); }
  issue() { this.run(this.api.issue(this.id()), 'Invoice issued'); }
  async voidInvoice() {
    if (!(await this.confirm.ask({ title: 'Void invoice', message: 'Void this invoice? This cannot be undone.', danger: true, confirmText: 'Void' }))) return;
    this.run(this.api.void(this.id()), 'Invoice voided');
  }
  openPay() { this.pay = { amount: Math.round(this.balance() * 100) / 100, method: 'CASH', reference: '' }; this.payDialog.set(true); }
  submitPay() {
    this.run(this.api.pay(this.id(), { amount: num(this.pay.amount), method: this.pay.method, reference: this.pay.reference || undefined }), 'Payment recorded', () => this.payDialog.set(false));
  }
  private run(req: { subscribe: (o: { next: () => void; error: (e: unknown) => void }) => unknown }, msg: string, after?: () => void) {
    this.busy.set(true);
    req.subscribe({
      next: () => { this.busy.set(false); after?.(); this.toast.success(msg); this.load(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
}
