import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { BillingApi } from '../../core/api/billing.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { ConfirmService } from '../../shared/confirm.service';
import { Invoice, PAYMENT_METHODS, PaymentMethod } from '../../core/models';
import { num } from '../../core/money';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { DialogComponent } from '../../shared/dialog';

@Component({
  selector: 'cf-invoice-detail',
  imports: [FormsModule, RouterLink, TranslatePipe, PageHeaderComponent, StatusChipComponent, DialogComponent],
  template: `
    <div class="page" style="max-width: 1000px">
      @if (inv(); as i) {
        <cf-page-header [title]="('billing.invoice' | translate) + ' ' + i.number" [subtitle]="subtitle()">
          <cf-chip [status]="i.status" group="status" />
          <a class="btn" routerLink="/billing">{{ 'billing.allInvoices' | translate }}</a>
          @if (canWrite) {
            @if (i.status === 'DRAFT') { <button type="button" class="btn primary" (click)="issue()" [disabled]="busy()">{{ 'billing.issue' | translate }}</button> }
            @if (i.status === 'ISSUED' || i.status === 'PARTIALLY_PAID') { <button type="button" class="btn primary" (click)="openPay()" [disabled]="busy()">{{ 'billing.recordPayment' | translate }}</button> }
            @if (i.status !== 'PAID' && i.status !== 'VOID') { <button type="button" class="btn danger-outline" (click)="voidInvoice()" [disabled]="busy()">{{ 'billing.void' | translate }}</button> }
          }
        </cf-page-header>
        <div class="grid" style="grid-template-columns: 3fr 2fr">
          <div class="col">
            <div class="card">
              <div class="card-header"><h3>{{ 'billing.items' | translate }}</h3></div>
              <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>{{ 'common.description' | translate }}</th><th class="num">{{ 'billing.qty' | translate }}</th><th class="num">{{ 'billing.unitPrice' | translate }}</th><th class="num">{{ 'common.total' | translate }}</th></tr></thead>
                  <tbody>
                    @for (it of i.items ?? []; track $index) {
                      <tr><td>{{ it.description }}</td><td class="num">{{ it.quantity }}</td><td class="num">{{ money(it.unitPrice) }}</td><td class="num">{{ money(it.total ?? num(it.unitPrice) * it.quantity) }}</td></tr>
                    } @empty { <tr><td colspan="4" class="empty">{{ 'billing.noItems' | translate }}</td></tr> }
                  </tbody>
                  <tfoot>
                    <tr><td colspan="3" class="num muted">{{ 'billing.subtotal' | translate }}</td><td class="num">{{ money(i.subtotal) }}</td></tr>
                    <tr><td colspan="3" class="num muted">{{ 'billing.discount' | translate }}</td><td class="num">− {{ money(i.discount) }}</td></tr>
                    <tr><td colspan="3" class="num muted">{{ 'billing.tax' | translate }}</td><td class="num">+ {{ money(i.tax) }}</td></tr>
                    <tr class="strong"><td colspan="3" class="num">{{ 'common.total' | translate }}</td><td class="num">{{ money(i.total) }}</td></tr>
                    <tr><td colspan="3" class="num muted">{{ 'billing.paid' | translate }}</td><td class="num success-text">{{ money(i.amountPaid) }}</td></tr>
                    <tr class="strong"><td colspan="3" class="num">{{ 'billing.balanceDue' | translate }}</td><td class="num" [class.danger-text]="balance() > 0">{{ money(balance()) }}</td></tr>
                  </tfoot>
                </table>
              </div>
            </div>
            @if (i.notes) { <div class="card card-body"><div class="label-text">{{ 'common.notes' | translate }}</div><div style="white-space: pre-line">{{ i.notes }}</div></div> }
          </div>
          <div class="col">
            <div class="card">
              <div class="card-header"><h3>{{ 'common.patient' | translate }}</h3></div>
              <div class="card-body">
                @if (i.patient) { <a [routerLink]="['/patients', i.patientId]" class="strong">{{ i.patient.firstName }} {{ i.patient.lastName }}</a><div class="muted">{{ i.patient.mrn }}@if (i.patient.phone) { · <span dir="ltr">{{ i.patient.phone }}</span> }</div> }
                @else { <a [routerLink]="['/patients', i.patientId]">{{ 'patients.open' | translate }}</a> }
              </div>
            </div>
            <div class="card">
              <div class="card-header"><h3>{{ 'billing.payments' | translate }}</h3></div>
              <div class="card-body">
                @for (p of i.payments ?? []; track p.id) {
                  <div class="list-item"><div class="flex-1"><div class="strong">{{ money(p.amount) }}</div><div class="subtle">{{ lang.formatDateTime(p.paidAt) }} · {{ lang.enumLabel(p.method, 'paymentMethod') }}@if (p.reference) { · {{ p.reference }} }</div></div></div>
                } @empty { <div class="muted">{{ 'billing.noPayments' | translate }}</div> }
              </div>
            </div>
          </div>
        </div>
      } @else if (error()) { <div class="inline-alert error">{{ error() }}</div> }
      @else { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
    </div>
    @if (payDialog()) {
      <cf-dialog [title]="'billing.recordPayment' | translate" [width]="440" (closed)="payDialog.set(false)">
        <div class="field"><label class="req">{{ 'billing.amount' | translate }}</label><input class="input" type="number" min="0.01" step="0.01" [(ngModel)]="pay.amount" /><div class="subtle">{{ 'billing.balanceDue' | translate }}: {{ money(balance()) }}</div></div>
        <div class="field"><label class="req">{{ 'billing.method' | translate }}</label><select class="input" [(ngModel)]="pay.method">@for (m of methods; track m) { <option [value]="m">{{ lang.enumLabel(m, 'paymentMethod') }}</option> }</select></div>
        <div class="field"><label>{{ 'billing.reference' | translate }}</label><input class="input" [(ngModel)]="pay.reference" [placeholder]="'billing.referencePlaceholder' | translate" /></div>
        <div footer>
          <button type="button" class="btn" (click)="payDialog.set(false)">{{ 'common.cancel' | translate }}</button>
          <button type="button" class="btn primary" (click)="submitPay()" [disabled]="busy() || !(pay.amount > 0)">{{ 'billing.record' | translate }}</button>
        </div>
      </cf-dialog>
    }
  `,
})
export class InvoiceDetailPage {
  private readonly api = inject(BillingApi);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  readonly lang = inject(LanguageService);
  readonly id = input.required<string>();
  readonly num = num;
  readonly methods = PAYMENT_METHODS;
  private readonly auth = inject(AuthService);
  readonly canWrite = this.auth.hasPermission('billing:write');
  readonly inv = signal<Invoice | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly payDialog = signal(false);
  readonly balance = computed(() => (this.inv() ? num(this.inv()!.total) - num(this.inv()!.amountPaid) : 0));
  readonly money = (v: number | string | null | undefined) => this.lang.formatMoney(v, this.inv()?.currency);
  readonly subtitle = computed(() => {
    const i = this.inv();
    if (!i) return '';
    const parts = [this.lang.t('billing.createdOn', { date: this.lang.formatDate(i.createdAt) })];
    if (i.issuedAt) parts.push(this.lang.t('billing.issuedOn', { date: this.lang.formatDate(i.issuedAt) }));
    if (i.dueAt) parts.push(this.lang.t('billing.dueOn', { date: this.lang.formatDate(i.dueAt) }));
    return parts.join(' · ');
  });
  pay: { amount: number; method: PaymentMethod; reference: string } = { amount: 0, method: 'CASH', reference: '' };

  ngOnInit() { this.load(); }
  load() { this.api.invoice(this.id()).subscribe({ next: (i) => this.inv.set(i), error: (err) => { this.error.set(this.lang.t('billing.loadFailed')); this.toast.fromError(err); } }); }
  issue() { this.run(this.api.issue(this.id()), this.lang.t('billing.issued')); }
  async voidInvoice() {
    if (!(await this.confirm.ask({ title: this.lang.t('billing.voidTitle'), message: this.lang.t('billing.voidConfirm'), danger: true, confirmText: this.lang.t('billing.void') }))) return;
    this.run(this.api.void(this.id()), this.lang.t('billing.voided'));
  }
  openPay() { this.pay = { amount: Math.round(this.balance() * 100) / 100, method: 'CASH', reference: '' }; this.payDialog.set(true); }
  submitPay() {
    this.run(this.api.pay(this.id(), { amount: num(this.pay.amount), method: this.pay.method, reference: this.pay.reference || undefined }), this.lang.t('billing.paymentRecorded'), () => this.payDialog.set(false));
  }
  private run(req: { subscribe: (o: { next: () => void; error: (e: unknown) => void }) => unknown }, msg: string, after?: () => void) {
    this.busy.set(true);
    req.subscribe({
      next: () => { this.busy.set(false); after?.(); this.toast.success(msg); this.load(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
}
