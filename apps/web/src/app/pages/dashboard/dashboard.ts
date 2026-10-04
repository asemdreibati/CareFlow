import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ClinicApi } from '../../core/api/clinic.api';
import { AppointmentsApi } from '../../core/api/appointments.api';
import { SchedulingApi } from '../../core/api/scheduling.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { Appointment, AppointmentStatus, ClinicStats } from '../../core/models';
import { dayRange, fmtTime, isoDate } from '../../core/date-utils';
import { money } from '../../core/money';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { HasPermissionDirective } from '../../core/permission.directive';
import { RiskBadgeComponent } from '../../shared/risk-badge';
import { fmtDate } from '../../core/date-utils';

@Component({
  selector: 'cf-dashboard',
  imports: [RouterLink, PageHeaderComponent, StatusChipComponent, HasPermissionDirective, RiskBadgeComponent],
  template: `
    <div class="page">
      <cf-page-header title="Dashboard" [subtitle]="greeting()">
        <a *hasPermission="'appointments:write'" class="btn primary" routerLink="/calendar" [queryParams]="{ new: 1 }">+ New appointment</a>
      </cf-page-header>

      @if (stats(); as s) {
        <div class="grid grid-4 mb-2">
          <div class="card stat"><span class="label">Today's appointments</span><span class="value">{{ s.todayAppointments }}</span><span class="hint">{{ s.upcoming }} upcoming in the next 7 days</span></div>
          <div class="card stat"><span class="label">Patients</span><span class="value">{{ s.patients }}</span><span class="hint">{{ s.doctors }} active doctors</span></div>
          <div class="card stat"><span class="label">Outstanding balance</span><span class="value">{{ money(s.outstanding) }}</span><span class="hint">{{ s.unpaidInvoices }} unpaid invoices</span></div>
          <div class="card stat"><span class="label">Upcoming (7 days)</span><span class="value">{{ s.upcoming }}</span><span class="hint">Scheduled & confirmed</span></div>
        </div>
      } @else if (statsError()) {
        <div class="inline-alert info">{{ statsError() }}</div>
      }

      @if (canSchedule) {
        <div class="card mb-2 at-risk">
          <div class="card-header">
            <h2>At risk today <span class="muted small">— predicted no-shows (≥ 50%)</span></h2>
            <div class="row gap-1"><a class="btn sm" routerLink="/waitlist">Waitlist</a><a class="btn sm" routerLink="/settings" [queryParams]="{ tab: 'noshow' }">Model</a></div>
          </div>
          @if (riskError()) { <div class="empty">{{ riskError() }}</div> }
          @else if (!atRisk().length) { <div class="empty">No appointment today is predicted as a likely no-show.</div> }
          @else {
            <div class="risk-list">
              @for (a of atRisk(); track a.id) {
                <a class="risk-item" [routerLink]="['/appointments', a.id]">
                  <cf-risk-badge [risk]="a.noShowRisk" />
                  <span class="mono nowrap">{{ fmtTime(a.startsAt) }}</span>
                  <span class="flex-1 truncate"><strong>{{ a.patient?.firstName }} {{ a.patient?.lastName }}</strong> <span class="muted">· {{ a.doctor?.firstName }} {{ a.doctor?.lastName }}</span></span>
                  @if (a.patient?.phone) { <span class="muted small nowrap">{{ a.patient?.phone }}</span> }
                  <cf-chip [status]="a.status" />
                </a>
              }
            </div>
          }
        </div>
      }

      <div class="card">
        <div class="card-header">
          <h2>Today's appointments <span class="muted small">— {{ today }}</span>@if (isDoctorOnly()) { <span class="chip teal">My schedule</span> }</h2>
          <a class="btn sm" routerLink="/calendar">Open calendar</a>
        </div>
        @if (loading()) { <div class="loading"><span class="spinner"></span> Loading…</div> }
        @else if (apptError()) { <div class="empty">{{ apptError() }}</div> }
        @else {
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Time</th><th>Patient</th><th>Doctor</th><th>Type</th><th>Status</th><th>Risk</th><th></th></tr></thead>
              <tbody>
                @for (a of appointments(); track a.id) {
                  <tr>
                    <td class="nowrap mono">{{ fmtTime(a.startsAt) }}–{{ fmtTime(a.endsAt) }}</td>
                    <td><a [routerLink]="['/patients', a.patientId]">{{ a.patient?.firstName }} {{ a.patient?.lastName }}</a><div class="subtle">{{ a.patient?.mrn }}</div></td>
                    <td><span class="row gap-1"><span class="pill-color" [style.background]="a.doctor?.color || '#94a3b8'"></span>{{ a.doctor?.title }} {{ a.doctor?.firstName }} {{ a.doctor?.lastName }}</span></td>
                    <td><span class="muted">{{ a.type || '—' }}</span></td>
                    <td><cf-chip [status]="a.status" /></td>
                    <td><cf-risk-badge [risk]="a.noShowRisk" /></td>
                    <td class="actions">
                      <ng-container *hasPermission="'appointments:write'">
                        @for (next of quickActions(a.status); track next) {
                          <button type="button" class="btn xs" [disabled]="busy() === a.id" (click)="setStatus(a, next)">{{ labels[next] }}</button>
                        }
                      </ng-container>
                      <a class="btn xs ghost" [routerLink]="['/appointments', a.id]">Open</a>
                    </td>
                  </tr>
                } @empty { <tr><td colspan="7" class="empty">No appointments today.</td></tr> }
              </tbody>
            </table>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .at-risk { border-color: #fde68a; }
    .risk-list { display: flex; flex-direction: column; }
    .risk-item { display: flex; align-items: center; gap: 12px; padding: 10px 20px; border-bottom: 1px solid var(--cf-border); color: inherit; }
    .risk-item:last-child { border-bottom: none; }
    .risk-item:hover { background: var(--cf-surface-2); text-decoration: none; }
  `],
})
export class DashboardPage {
  private readonly clinicApi = inject(ClinicApi);
  private readonly apptApi = inject(AppointmentsApi);
  private readonly scheduling = inject(SchedulingApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly money = (v: number) => money(v, this.auth.clinic()?.currency);
  readonly fmtTime = fmtTime;
  readonly today = fmtDate(new Date(), 'EEEE, dd MMM yyyy');
  readonly stats = signal<ClinicStats | null>(null);
  readonly statsError = signal<string | null>(null);
  readonly appointments = signal<Appointment[]>([]);
  readonly loading = signal(true);
  readonly apptError = signal<string | null>(null);
  readonly busy = signal<string | null>(null);
  readonly atRisk = signal<Appointment[]>([]);
  readonly riskError = signal<string | null>(null);
  readonly canSchedule = this.auth.hasPermission('scheduling:manage');
  readonly labels: Record<string, string> = { CONFIRMED: 'Confirm', CHECKED_IN: 'Check in', IN_PROGRESS: 'Start', COMPLETED: 'Complete' };
  readonly isDoctorOnly = computed(() => !!this.auth.doctorId() && !this.auth.hasPermission('appointments:read_all'));
  readonly greeting = computed(() => `Welcome back, ${this.auth.user()?.firstName ?? ''}`);

  constructor() {
    this.clinicApi.stats().subscribe({ next: (s) => this.stats.set(s), error: () => this.statsError.set('Clinic stats are unavailable.') });
    this.loadToday();
    if (this.canSchedule) {
      this.scheduling.atRisk(isoDate(new Date())).subscribe({
        next: (list) => this.atRisk.set([...list].sort((a, b) => (b.noShowRisk ?? 0) - (a.noShowRisk ?? 0))),
        error: () => this.riskError.set('No-show predictions are not available yet.'),
      });
    }
  }

  loadToday() {
    const { from, to } = dayRange(new Date());
    const doctorId = this.isDoctorOnly() ? this.auth.doctorId()! : undefined;
    this.apptApi.list({ from, to, doctorId, pageSize: 100 }).subscribe({
      next: (r) => {
        this.appointments.set([...r.items].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
        this.loading.set(false);
      },
      error: () => { this.loading.set(false); this.apptError.set('Appointments are not available yet.'); },
    });
  }

  /** Only the "forward" transitions as quick actions; cancel/no-show live on the detail page. */
  quickActions(status: AppointmentStatus): AppointmentStatus[] {
    const map: Partial<Record<AppointmentStatus, AppointmentStatus[]>> = {
      SCHEDULED: ['CONFIRMED', 'CHECKED_IN'], CONFIRMED: ['CHECKED_IN'], CHECKED_IN: ['IN_PROGRESS'], IN_PROGRESS: ['COMPLETED'],
    };
    return map[status] ?? [];
  }

  setStatus(a: Appointment, status: AppointmentStatus) {
    this.busy.set(a.id);
    this.apptApi.setStatus(a.id, status).subscribe({
      next: (updated) => {
        this.appointments.update((list) => list.map((x) => (x.id === a.id ? { ...x, ...updated, status: updated.status ?? status } : x)));
        this.busy.set(null);
      },
      error: (err) => { this.busy.set(null); this.toast.fromError(err); },
    });
  }
}
