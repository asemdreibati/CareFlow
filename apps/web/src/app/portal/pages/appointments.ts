import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { PortalApi } from '../portal-api.service';
import { PortalChip, useFormat } from '../portal-ui';
import { PortalAppointment } from '../portal.models';

@Component({
  selector: 'cf-portal-appointments',
  imports: [RouterLink, TranslatePipe, PortalChip],
  template: `
    <div class="pt-fade">
      <h1 class="pt-title">{{ 'portal.appointments.title' | translate }}</h1>
      <div class="pt-segment" role="tablist">
        <button type="button" [class.active]="tab() === 'upcoming'" (click)="show('upcoming')">{{ 'portal.appointments.upcoming' | translate }}</button>
        <button type="button" [class.active]="tab() === 'past'" (click)="show('past')">{{ 'portal.appointments.past' | translate }}</button>
      </div>
      @if (loading()) { <div class="pt-loading"><span class="spinner"></span>{{ 'portal.common.loading' | translate }}</div> }
      @else if (error()) { <div class="pt-alert error pt-row between">{{ error() }} <button type="button" class="pt-btn sm" (click)="show(tab())">{{ 'portal.common.retry' | translate }}</button></div> }
      @else if (!items().length) {
        <div class="pt-empty"><div class="big">{{ tab() === 'upcoming' ? '🗓️' : '📁' }}</div>{{ (tab() === 'upcoming' ? 'portal.appointments.empty' : 'portal.appointments.emptyPast') | translate }}</div>
        @if (tab() === 'upcoming') { <a class="pt-btn primary block" routerLink="/portal/app/book">{{ 'portal.home.bookNow' | translate }}</a> }
      } @else {
        <div class="pt-list">
          @for (a of items(); track a.id) {
            <a class="pt-item" [routerLink]="['/portal/app/appointments', a.id]">
              <div class="pt-datebox" [class.muted]="tab() === 'past'"><div class="d">{{ f.day(a.startsAt) }}</div><div class="m">{{ f.month(a.startsAt) }}</div></div>
              <div class="body">
                <div class="primary">{{ f.time(a.startsAt) }} · {{ f.lang.formatDate(a.startsAt, { weekday: 'long' }) }}</div>
                <div class="secondary">{{ f.doctor(a.doctor) }}</div>
                <div style="margin-top:6px"><cf-portal-chip [status]="a.status" /></div>
              </div>
              <svg class="pt-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
            </a>
          }
        </div>
      }
    </div>
  `,
})
export class PortalAppointmentsPage {
  readonly f = useFormat();
  private readonly api = inject(PortalApi);
  readonly tab = signal<'upcoming' | 'past'>('upcoming');
  readonly items = signal<PortalAppointment[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  constructor() { this.show('upcoming'); }

  show(tab: 'upcoming' | 'past') {
    this.tab.set(tab);
    this.loading.set(true);
    this.error.set(null);
    this.api.appointments(tab).subscribe({
      next: (list) => {
        const sorted = [...list].sort((a, b) => (tab === 'upcoming' ? a.startsAt.localeCompare(b.startsAt) : b.startsAt.localeCompare(a.startsAt)));
        this.items.set(sorted);
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.items.set([]);
        this.loading.set(false);
        this.error.set((err as { status?: number })?.status === 0 ? this.f.lang.t('portal.errors.network') : this.f.lang.t('portal.errors.notAvailable'));
      },
    });
  }
}
