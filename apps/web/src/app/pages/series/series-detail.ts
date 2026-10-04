import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SeriesApi } from '../../core/api/series.api';
import { AuthService } from '../../core/auth.service';
import { ToastService, errorMessage } from '../../core/toast.service';
import { ConfirmService } from '../../shared/confirm.service';
import { Appointment, AppointmentSeries } from '../../core/models';
import { WEEKDAYS_SHORT, fmtDate, fmtDateTime, fmtTime } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { RiskBadgeComponent } from '../../shared/risk-badge';

export function describeRule(s: AppointmentSeries): string {
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month' }[s.frequency];
  const every = s.interval > 1 ? `Every ${s.interval} ${unit}s` : `Every ${unit}`;
  const on = s.frequency === 'WEEKLY' && s.byWeekday?.length ? ` on ${s.byWeekday.map((d) => WEEKDAYS_SHORT[d]).join(', ')}` : s.frequency === 'MONTHLY' && s.byMonthDay ? ` on day ${s.byMonthDay}` : '';
  const end = s.count ? `, ${s.count} times` : s.until ? `, until ${fmtDate(s.until)}` : '';
  return `${every}${on} at ${s.startTime} · ${s.durationMinutes} min${end}`;
}

@Component({
  selector: 'cf-series-detail',
  imports: [RouterLink, PageHeaderComponent, StatusChipComponent, RiskBadgeComponent],
  template: `
    <div class="page" style="max-width: 1000px">
      @if (series(); as s) {
        <cf-page-header title="Recurring series" [subtitle]="rule()">
          <cf-chip [status]="s.status" />
          @if (canWrite && s.status === 'ACTIVE' && futureCount() > 0) { <button type="button" class="btn danger-outline" (click)="cancelFuture()" [disabled]="busy()">Cancel future occurrences</button> }
          <a class="btn" routerLink="/calendar">Calendar</a>
        </cf-page-header>

        <div class="grid" style="grid-template-columns: 2fr 1fr">
          <div class="card">
            <div class="card-header"><h3>Occurrences <span class="muted small">{{ occurrences().length }} total · {{ futureCount() }} upcoming</span></h3></div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>#</th><th>When</th><th>Doctor</th><th>Status</th><th>Risk</th><th></th></tr></thead>
                <tbody>
                  @for (a of occurrences(); track a.id) {
                    <tr>
                      <td class="mono">{{ (a.occurrenceIndex ?? $index) + 1 }}@if (a.isException) { <span class="chip amber" style="margin-left: 6px" title="Edited or moved away from the rule">exception</span> }</td>
                      <td class="nowrap">{{ fmtDateTime(a.startsAt) }} – {{ fmtTime(a.endsAt) }}</td>
                      <td><span class="row gap-1"><span class="pill-color" [style.background]="a.doctor?.color || '#94a3b8'"></span>{{ a.doctor?.firstName }} {{ a.doctor?.lastName }}</span></td>
                      <td><cf-chip [status]="a.status" /></td>
                      <td><cf-risk-badge [risk]="a.noShowRisk" /></td>
                      <td class="actions"><a class="btn xs" [routerLink]="['/appointments', a.id]">Open</a></td>
                    </tr>
                  } @empty { <tr><td colspan="6" class="empty">No occurrences.</td></tr> }
                </tbody>
              </table>
            </div>
          </div>
          <div class="col">
            <div class="card">
              <div class="card-header"><h3>Rule</h3></div>
              <div class="card-body">
                <dl class="kv" style="grid-template-columns: 90px 1fr">
                  <dt>Patient</dt><dd><a [routerLink]="['/patients', s.patientId]">{{ s.patient?.firstName || 'Patient' }} {{ s.patient?.lastName || '' }}</a></dd>
                  <dt>Doctor</dt><dd><a [routerLink]="['/doctors', s.doctorId]">{{ s.doctor?.firstName || 'Doctor' }} {{ s.doctor?.lastName || '' }}</a></dd>
                  <dt>Repeats</dt><dd>{{ rule() }}</dd>
                  <dt>Starts</dt><dd>{{ fmtDate(s.startsOn) }}</dd>
                  <dt>Type</dt><dd>{{ s.type || '—' }}</dd>
                  <dt>Reason</dt><dd>{{ s.reason || '—' }}</dd>
                  <dt>Created</dt><dd class="muted">{{ fmtDate(s.createdAt) }}</dd>
                </dl>
              </div>
            </div>
          </div>
        </div>
      } @else if (error()) { <div class="inline-alert error">{{ error() }}</div> }
      @else { <div class="loading"><span class="spinner"></span> Loading…</div> }
    </div>
  `,
})
export class SeriesDetailPage {
  private readonly api = inject(SeriesApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  readonly id = input.required<string>();
  readonly fmtDate = fmtDate;
  readonly fmtDateTime = fmtDateTime;
  readonly fmtTime = fmtTime;
  readonly canWrite = this.auth.hasPermission('appointments:write');
  readonly series = signal<AppointmentSeries | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly occurrences = computed<Appointment[]>(() => {
    const s = this.series(); const list = s?.occurrences ?? s?.appointments ?? [];
    return [...list].sort((a, b) => (a.occurrenceIndex ?? 0) - (b.occurrenceIndex ?? 0) || a.startsAt.localeCompare(b.startsAt));
  });
  readonly futureCount = computed(() => this.occurrences().filter((a) => new Date(a.startsAt).getTime() > Date.now() && !['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(a.status)).length);
  readonly rule = computed(() => (this.series() ? describeRule(this.series()!) : ''));

  ngOnInit() { this.load(); }
  load() {
    this.api.get(this.id()).subscribe({ next: (s) => this.series.set(s), error: (err) => this.error.set(errorMessage(err, 'Could not load series.')) });
  }
  async cancelFuture() {
    if (!(await this.confirm.ask({ title: 'Cancel future occurrences', message: `Cancel the ${this.futureCount()} upcoming appointment(s) of this series? Past and completed visits are kept.`, confirmText: 'Cancel future', danger: true }))) return;
    this.busy.set(true);
    this.api.cancel(this.id()).subscribe({
      next: () => { this.busy.set(false); this.toast.success('Future occurrences cancelled'); this.load(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
}
