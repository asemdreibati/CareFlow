import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { BillingApi } from '../../core/api/billing.api';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { Invoice, PatientRef, Service } from '../../core/models';
import { num } from '../../core/money';
import { DialogComponent } from '../../shared/dialog';
import { PatientSearchComponent } from '../../shared/patient-search';
import { startOfDayInZone } from '../../core/timezone';

interface Line { serviceId: string; description: string; quantity: number; unitPrice: number; }

@Component({
  selector: 'cf-create-invoice-dialog',
  imports: [FormsModule, TranslatePipe, DialogComponent, PatientSearchComponent],
  template: `
    <cf-dialog [title]="'billing.newInvoice' | translate" [width]="720" (closed)="closed.emit()">
      <div class="field"><label class="req">{{ 'common.patient' | translate }}</label><cf-patient-search (selectedChange)="patient.set($event)" /></div>
      <div class="label-text mb-1">{{ 'billing.items' | translate }}</div>
      <table class="table lines">
        <thead><tr><th style="width: 32%">{{ 'billing.service' | translate }}</th><th>{{ 'common.description' | translate }}</th><th style="width: 70px">{{ 'billing.qty' | translate }}</th><th style="width: 110px">{{ 'billing.unitPrice' | translate }}</th><th class="num" style="width: 100px">{{ 'common.total' | translate }}</th><th style="width: 36px"></th></tr></thead>
        <tbody>
          @for (l of lines(); track $index; let i = $index) {
            <tr>
              <td><select class="input sm" [ngModel]="l.serviceId" (ngModelChange)="pickService(i, $event)">
                <option value="">{{ 'billing.freeText' | translate }}</option>@for (s of services(); track s.id) { <option [value]="s.id">{{ s.code }} · {{ s.name }}</option> }
              </select></td>
              <td><input class="input sm" [(ngModel)]="l.description" [placeholder]="'common.description' | translate" /></td>
              <td><input class="input sm" type="number" min="1" [(ngModel)]="l.quantity" /></td>
              <td><input class="input sm" type="number" min="0" step="0.01" [(ngModel)]="l.unitPrice" /></td>
              <td class="num">{{ lang.formatMoney(l.quantity * l.unitPrice) }}</td>
              <td><button type="button" class="btn ghost xs danger-text" (click)="remove(i)" [attr.aria-label]="'common.remove' | translate">✕</button></td>
            </tr>
          }
        </tbody>
      </table>
      <button type="button" class="btn ghost sm mt-1" (click)="add()">+ {{ 'billing.addLine' | translate }}</button>
      <div class="divider"></div>
      <div class="form-grid">
        <div class="field"><label>{{ 'billing.discount' | translate }}</label><input class="input sm" type="number" min="0" step="0.01" [(ngModel)]="discount" /></div>
        <div class="field"><label>{{ 'billing.tax' | translate }}</label><input class="input sm" type="number" min="0" step="0.01" [(ngModel)]="tax" /></div>
        <div class="field"><label>{{ 'billing.dueDate' | translate }}</label><input class="input sm" type="date" [(ngModel)]="dueAt" /></div>
        <div class="field"><label>{{ 'common.notes' | translate }}</label><input class="input sm" [(ngModel)]="notes" /></div>
      </div>
      <div class="totals">
        <div><span class="muted">{{ 'billing.subtotal' | translate }}</span><span>{{ lang.formatMoney(subtotal()) }}</span></div>
        <div><span class="muted">{{ 'billing.discount' | translate }}</span><span>− {{ lang.formatMoney(discount || 0) }}</span></div>
        <div><span class="muted">{{ 'billing.tax' | translate }}</span><span>+ {{ lang.formatMoney(tax || 0) }}</span></div>
        <div class="strong"><span>{{ 'common.total' | translate }}</span><span>{{ lang.formatMoney(total()) }}</span></div>
      </div>
      <div footer>
        <button type="button" class="btn" (click)="closed.emit()">{{ 'common.cancel' | translate }}</button>
        <button type="button" class="btn primary" (click)="submit()" [disabled]="!valid() || saving()">{{ (saving() ? 'common.creating' : 'billing.createDraft') | translate }}</button>
      </div>
    </cf-dialog>
  `,
  styles: [`
    .lines th, .lines td { padding: 6px 4px; }
    .totals { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; margin-top: 8px; }
    .totals > div { display: flex; gap: 24px; width: 240px; justify-content: space-between; }
  `],
})
export class CreateInvoiceDialog {
  private readonly api = inject(BillingApi);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);
  readonly closed = output<void>();
  readonly created = output<Invoice>();
  readonly services = signal<Service[]>([]);
  readonly patient = signal<PatientRef | null>(null);
  readonly lines = signal<Line[]>([{ serviceId: '', description: '', quantity: 1, unitPrice: 0 }]);
  readonly saving = signal(false);
  discount = 0; tax = 0; dueAt = ''; notes = '';
  readonly subtotal = computed(() => this.lines().reduce((s, l) => s + num(l.quantity) * num(l.unitPrice), 0));
  readonly total = () => Math.max(0, this.subtotal() - num(this.discount) + num(this.tax));
  readonly valid = computed(() => !!this.patient() && this.lines().length > 0 && this.lines().every((l) => (l.serviceId || l.description.trim()) && num(l.quantity) > 0));

  ngOnInit() { this.api.services().subscribe({ next: (s) => this.services.set(s.filter((x) => x.isActive)), error: () => undefined }); }
  add() { this.lines.update((l) => [...l, { serviceId: '', description: '', quantity: 1, unitPrice: 0 }]); }
  remove(i: number) { this.lines.update((l) => l.filter((_, idx) => idx !== i)); }
  pickService(i: number, serviceId: string) {
    const svc = this.services().find((s) => s.id === serviceId);
    this.lines.update((l) => l.map((x, idx) => (idx === i ? { ...x, serviceId, description: svc ? svc.name : x.description, unitPrice: svc ? num(svc.price) : x.unitPrice } : x)));
  }
  submit() {
    if (!this.valid()) return;
    this.saving.set(true);
    this.api.createInvoice({
      patientId: this.patient()!.id,
      items: this.lines().map((l) => ({ serviceId: l.serviceId || undefined, description: l.description.trim() || undefined, quantity: num(l.quantity), unitPrice: num(l.unitPrice) })),
      discount: num(this.discount) || undefined, tax: num(this.tax) || undefined,
      dueAt: this.dueAt ? startOfDayInZone(this.dueAt).toISOString() : undefined, notes: this.notes || undefined,
    }).subscribe({
      next: (inv) => { this.saving.set(false); this.toast.success(this.lang.t('billing.invoiceCreated', { number: inv.number })); this.created.emit(inv); },
      error: (err) => { this.saving.set(false); this.toast.fromError(err); },
    });
  }
}
