import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { BillingApi } from '../../core/api/billing.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { Service } from '../../core/models';
import { StatusChipComponent } from '../../shared/status-chip';
import { DialogComponent } from '../../shared/dialog';

@Component({
  selector: 'cf-services-tab',
  imports: [FormsModule, TranslatePipe, StatusChipComponent, DialogComponent],
  template: `
    <div class="card">
      <div class="card-header"><h3>{{ 'billing.priceList' | translate }}</h3>@if (canWrite) { <button type="button" class="btn sm primary" (click)="openNew()">+ {{ 'billing.newService' | translate }}</button> }</div>
      @if (loading()) { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
      @else if (error()) { <div class="empty">{{ error() }}</div> }
      @else {
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>{{ 'billing.code' | translate }}</th><th>{{ 'common.name' | translate }}</th><th class="num">{{ 'billing.price' | translate }}</th><th>{{ 'common.duration' | translate }}</th><th>{{ 'common.status' | translate }}</th><th></th></tr></thead>
            <tbody>
              @for (s of services(); track s.id) {
                <tr>
                  <td class="mono">{{ s.code }}</td><td class="strong">{{ s.name }}</td><td class="num">{{ lang.formatMoney(s.price) }}</td><td>{{ lang.formatMinutes(s.durationMinutes) }}</td>
                  <td><cf-chip [status]="s.isActive" /></td>
                  <td class="actions">@if (canWrite) { <button type="button" class="btn xs" (click)="openEdit(s)">{{ 'common.edit' | translate }}</button> }</td>
                </tr>
              } @empty { <tr><td colspan="6" class="empty">{{ 'billing.noServices' | translate }}</td></tr> }
            </tbody>
          </table>
        </div>
      }
    </div>
    @if (dialog()) {
      <cf-dialog [title]="(editing ? 'billing.editService' : 'billing.newService') | translate" [width]="440" (closed)="dialog.set(false)">
        <div class="field"><label class="req">{{ 'billing.code' | translate }}</label><input class="input" [(ngModel)]="form.code" placeholder="CONS" dir="ltr" /></div>
        <div class="field"><label class="req">{{ 'common.name' | translate }}</label><input class="input" [(ngModel)]="form.name" /></div>
        <div class="form-grid">
          <div class="field"><label class="req">{{ 'billing.price' | translate }}</label><input class="input" type="number" min="0" step="0.01" [(ngModel)]="form.price" /></div>
          <div class="field"><label>{{ 'billing.durationMin' | translate }}</label><input class="input" type="number" min="5" [(ngModel)]="form.durationMinutes" /></div>
        </div>
        @if (editing) { <label class="checkbox"><input type="checkbox" [(ngModel)]="form.isActive" /> {{ 'common.active' | translate }}</label> }
        <div footer>
          <button type="button" class="btn" (click)="dialog.set(false)">{{ 'common.cancel' | translate }}</button>
          <button type="button" class="btn primary" (click)="save()" [disabled]="saving() || !form.code || !form.name">{{ (saving() ? 'common.saving' : 'common.save') | translate }}</button>
        </div>
      </cf-dialog>
    }
  `,
})
export class ServicesTab {
  private readonly api = inject(BillingApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);
  readonly canWrite = this.auth.hasPermission('billing:write');
  readonly services = signal<Service[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly dialog = signal(false);
  readonly saving = signal(false);
  editing: Service | null = null;
  form = { code: '', name: '', price: 0, durationMinutes: 30, isActive: true };

  ngOnInit() { this.load(); }
  load() {
    this.api.services().subscribe({
      next: (s) => { this.services.set(s); this.loading.set(false); },
      error: (err) => { this.loading.set(false); this.error.set(this.lang.errorMessage(err, this.lang.t('billing.servicesUnavailable'))); },
    });
  }
  openNew() { this.editing = null; this.form = { code: '', name: '', price: 0, durationMinutes: 30, isActive: true }; this.dialog.set(true); }
  openEdit(s: Service) { this.editing = s; this.form = { code: s.code, name: s.name, price: Number(s.price), durationMinutes: s.durationMinutes, isActive: s.isActive }; this.dialog.set(true); }
  save() {
    this.saving.set(true);
    const dto = { code: this.form.code.trim(), name: this.form.name.trim(), price: Number(this.form.price), durationMinutes: Number(this.form.durationMinutes) || 30 };
    const req = this.editing ? this.api.updateService(this.editing.id, { ...dto, isActive: this.form.isActive }) : this.api.createService(dto);
    req.subscribe({
      next: () => { this.saving.set(false); this.dialog.set(false); this.toast.success(this.lang.t('billing.serviceSaved')); this.load(); },
      error: (err) => { this.saving.set(false); this.toast.fromError(err); },
    });
  }
}
