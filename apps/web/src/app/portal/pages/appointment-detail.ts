import { Component, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ConfirmService } from '../../shared/confirm.service';
import { ToastService } from '../../core/toast.service';
import { PortalApi } from '../portal-api.service';
import { PortalChip, canCancelOnline, canConfirm, isOpen, useFormat } from '../portal-ui';
import { PortalAppointment } from '../portal.models';

@Component({
  selector: 'cf-portal-appointment-detail',
  imports: [RouterLink, TranslatePipe, PortalChip],
  template: `
    <div class="pt-fade">
      <a class="pt-btn ghost sm" routerLink="/portal/app/appointments" style="padding-inline:4px">‹ {{ 'portal.common.back' | translate }}</a>
      <h1 class="pt-title">{{ 'portal.appointments.detail' | translate }}</h1>
      @if (loading()) { <div class="pt-loading"><span class="spinner"></span>{{ 'portal.common.loading' | translate }}</div> }
      @else if (!appt()) { <div class="pt-empty">{{ 'portal.appointments.notFound' | translate }}</div> }
      @else if (appt(); as a) {
        <div class="pt-card">
          <div class="pt-row between" style="margin-bottom:12px">
            <div class="pt-row">
              <div class="pt-datebox"><div class="d">{{ f.day(a.startsAt) }}</div><div class="m">{{ f.month(a.startsAt) }}</div></div>
              <div><div class="pt-strong" style="font-size:17px">{{ f.time(a.startsAt) }} – {{ f.time(a.endsAt) }}</div><div class="pt-muted">{{ f.longDate(a.startsAt) }}</div></div>
            </div>
            <cf-portal-chip [status]="a.status" />
          </div>
          <dl class="pt-kv">
            <dt>{{ 'portal.appointments.doctor' | translate }}</dt><dd>{{ f.doctor(a.doctor) }}</dd>
            @if (a.type) { <dt>{{ 'portal.appointments.type' | translate }}</dt><dd>{{ a.type }}</dd> }
            @if (a.reason) { <dt>{{ 'portal.appointments.reason' | translate }}</dt><dd>{{ a.reason }}</dd> }
          </dl>
          @if (isOpen(a)) {
            <div class="pt-actions">
              @if (canConfirm(a)) { <button type="button" class="pt-btn primary" (click)="confirm(a)" [disabled]="busy()">{{ 'portal.appointments.confirm' | translate }}</button> }
              <button type="button" class="pt-btn danger" (click)="cancel(a)" [disabled]="busy() || !canCancelOnline(a)">{{ 'portal.appointments.cancel' | translate }}</button>
            </div>
            <p class="pt-hint" style="margin:10px 0 0">{{ (canCancelOnline(a) ? 'portal.appointments.cancelHint' : 'portal.home.tooLate') | translate }}</p>
          }
        </div>
        <a class="pt-btn block" style="margin-top:12px" routerLink="/portal/app/book">{{ 'portal.appointments.bookAnother' | translate }}</a>
      }
    </div>
  `,
})
export class PortalAppointmentDetailPage {
  readonly id = input.required<string>();
  readonly f = useFormat();
  private readonly api = inject(PortalApi);
  private readonly toast = inject(ToastService);
  private readonly confirmDialog = inject(ConfirmService);
  private readonly router = inject(Router);
  readonly appt = signal<PortalAppointment | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly isOpen = isOpen;
  readonly canConfirm = canConfirm;
  readonly canCancelOnline = canCancelOnline;

  constructor() { effect(() => this.load(this.id())); }

  load(id: string) {
    this.loading.set(true);
    this.api.appointment(id).subscribe({
      next: (a) => { this.appt.set(a); this.loading.set(false); },
      error: () => { this.appt.set(null); this.loading.set(false); },
    });
  }
  confirm(a: PortalAppointment) {
    this.busy.set(true);
    this.api.confirmAppointment(a.id).subscribe({
      next: (res) => { this.busy.set(false); this.toast.success(this.f.lang.t('portal.home.confirmed')); res?.id ? this.appt.set(res) : this.load(a.id); },
      error: (err: unknown) => { this.busy.set(false); this.toast.fromError(err, this.f.lang.t('portal.errors.generic')); },
    });
  }
  async cancel(a: PortalAppointment) {
    const ok = await this.confirmDialog.ask({
      title: this.f.lang.t('portal.home.cancelTitle'), message: this.f.lang.t('portal.home.cancelMessage'),
      confirmText: this.f.lang.t('portal.home.cancelConfirm'), danger: true,
    });
    if (!ok) return;
    this.busy.set(true);
    this.api.cancelAppointment(a.id).subscribe({
      next: () => { this.busy.set(false); this.toast.success(this.f.lang.t('portal.home.cancelled')); void this.router.navigate(['/portal/app/appointments']); },
      error: (err: unknown) => {
        this.busy.set(false);
        if ((err as { status?: number })?.status === 409) this.toast.warn(this.f.lang.t('portal.home.tooLate'));
        else this.toast.fromError(err, this.f.lang.t('portal.errors.generic'));
      },
    });
  }
}
