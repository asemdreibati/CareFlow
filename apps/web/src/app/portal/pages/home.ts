import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { offerCountdown } from '../../core/scheduling/offer-countdown';
import { ConfirmService } from '../../shared/confirm.service';
import { ToastService } from '../../core/toast.service';
import { PortalApi } from '../portal-api.service';
import { PortalAuthService } from '../portal-auth.service';
import { PortalChip, canCancelOnline, canConfirm, outstandingBalance, useFormat } from '../portal-ui';
import { PortalAppointment, PortalInvoice, PortalWaitlistEntry } from '../portal.models';
import { WaitlistOfferCard } from './waitlist-offer';

@Component({
  selector: 'cf-portal-home',
  imports: [RouterLink, TranslatePipe, PortalChip, WaitlistOfferCard],
  template: `
    <div class="pt-fade">
      <h1 class="pt-title">{{ 'portal.home.greeting' | translate: { name: auth.patientName() || '' } }}</h1>

      @for (o of offers(); track o.id) { <cf-portal-offer [entry]="o" (changed)="load()" /> }

      <div class="pt-section">{{ 'portal.home.nextAppointment' | translate }}</div>
      @if (loading()) { <div class="pt-card pt-loading"><span class="spinner"></span>{{ 'portal.common.loading' | translate }}</div> }
      @else if (next(); as a) {
        <div class="pt-card accent">
          <div class="pt-row between">
            <div class="pt-row">
              <div class="pt-datebox"><div class="d">{{ f.day(a.startsAt) }}</div><div class="m">{{ f.month(a.startsAt) }}</div></div>
              <div>
                <div class="pt-strong" style="font-size:16px">{{ f.time(a.startsAt) }} · {{ f.date(a.startsAt) }}</div>
                <div class="pt-muted">{{ f.doctor(a.doctor) }}</div>
              </div>
            </div>
            <cf-portal-chip [status]="a.status" />
          </div>
          @if (a.reason) { <p class="pt-muted pt-small" style="margin:10px 0 0">{{ a.reason }}</p> }
          <div class="pt-actions">
            @if (canConfirm(a)) { <button type="button" class="pt-btn primary" (click)="confirm(a)" [disabled]="busy()">{{ 'portal.home.confirm' | translate }}</button> }
            <button type="button" class="pt-btn danger" (click)="cancel(a)" [disabled]="busy()">{{ 'portal.home.cancel' | translate }}</button>
            <a class="pt-btn" [routerLink]="['/portal/app/appointments', a.id]">{{ 'portal.appointments.detail' | translate }}</a>
          </div>
        </div>
      } @else {
        <div class="pt-card">
          <div class="pt-empty" style="padding:20px 8px"><div class="big">🗓️</div>{{ 'portal.home.noUpcoming' | translate }}</div>
          <a class="pt-btn primary block" routerLink="/portal/app/book">{{ 'portal.home.bookNow' | translate }}</a>
        </div>
      }

      <div class="pt-section">{{ 'portal.home.balance' | translate }}</div>
      <div class="pt-card">
        @if (balance() > 0) {
          <div class="pt-row between">
            <div class="pt-amount danger-text">{{ f.money(balance(), auth.currency()) }}</div>
            <a class="pt-btn sm" routerLink="/portal/app/invoices">{{ 'portal.home.viewInvoices' | translate }}</a>
          </div>
        } @else {
          <div class="pt-row between"><span class="pt-muted">{{ 'portal.home.balanceClear' | translate }}</span><a class="pt-btn sm ghost" routerLink="/portal/app/invoices">{{ 'portal.home.viewAll' | translate }}</a></div>
        }
      </div>

      <div class="pt-section">{{ 'portal.home.quickActions' | translate }}</div>
      <div class="pt-list">
        <a class="pt-item" routerLink="/portal/app/book"><div class="body"><div class="primary">{{ 'portal.home.bookNow' | translate }}</div></div><svg class="pt-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></a>
        <a class="pt-item" routerLink="/portal/app/waitlist"><div class="body"><div class="primary">{{ 'portal.nav.waitlist' | translate }}</div><div class="secondary">{{ 'portal.waitlist.intro' | translate }}</div></div><svg class="pt-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></a>
      </div>
    </div>
  `,
})
export class PortalHomePage {
  readonly auth = inject(PortalAuthService);
  readonly f = useFormat();
  private readonly api = inject(PortalApi);
  private readonly toast = inject(ToastService);
  private readonly confirmDialog = inject(ConfirmService);

  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly upcoming = signal<PortalAppointment[]>([]);
  readonly invoices = signal<PortalInvoice[]>([]);
  readonly waitlist = signal<PortalWaitlistEntry[]>([]);
  readonly next = computed(() => this.upcoming().find((a) => a.status === 'SCHEDULED' || a.status === 'CONFIRMED') ?? this.upcoming()[0] ?? null);
  readonly balance = computed(() => outstandingBalance(this.invoices()));
  readonly offers = computed(() => this.waitlist().filter((w) => w.status === 'OFFERED' && !offerCountdown(w.offerExpiresAt).expired));
  readonly canConfirm = canConfirm;

  constructor() { this.load(); }

  load() {
    this.loading.set(true);
    forkJoin({
      appts: this.api.appointments('upcoming').pipe(catchError(() => of([] as PortalAppointment[]))),
      invoices: this.api.invoices().pipe(catchError(() => of([] as PortalInvoice[]))),
      waitlist: this.api.waitlist().pipe(catchError(() => of([] as PortalWaitlistEntry[]))),
    }).subscribe(({ appts, invoices, waitlist }) => {
      this.upcoming.set([...appts].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
      this.invoices.set(invoices);
      this.waitlist.set(waitlist);
      this.loading.set(false);
    });
  }

  confirm(a: PortalAppointment) {
    this.busy.set(true);
    this.api.confirmAppointment(a.id).subscribe({
      next: () => { this.busy.set(false); this.toast.success(this.f.lang.t('portal.home.confirmed')); this.load(); },
      error: (err: unknown) => { this.busy.set(false); this.toast.fromError(err, this.f.lang.t('portal.errors.generic')); },
    });
  }

  async cancel(a: PortalAppointment) {
    if (!canCancelOnline(a)) { this.toast.warn(this.f.lang.t('portal.home.tooLate')); return; }
    const ok = await this.confirmDialog.ask({
      title: this.f.lang.t('portal.home.cancelTitle'), message: this.f.lang.t('portal.home.cancelMessage'),
      confirmText: this.f.lang.t('portal.home.cancelConfirm'), danger: true,
    });
    if (!ok) return;
    this.busy.set(true);
    this.api.cancelAppointment(a.id).subscribe({
      next: () => { this.busy.set(false); this.toast.success(this.f.lang.t('portal.home.cancelled')); this.load(); },
      error: (err: unknown) => {
        this.busy.set(false);
        const status = (err as { status?: number })?.status;
        if (status === 409) this.toast.warn(this.f.lang.t('portal.home.tooLate'));
        else this.toast.fromError(err, this.f.lang.t('portal.errors.generic'));
      },
    });
  }
}
