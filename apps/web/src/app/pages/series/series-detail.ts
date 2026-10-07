import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { SeriesApi } from '../../core/api/series.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { ConfirmService } from '../../shared/confirm.service';
import { Appointment, AppointmentSeries } from '../../core/models';
import { WEEKDAYS_SHORT, fmtDate } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { RiskBadgeComponent } from '../../shared/risk-badge';

/** English rule summary (kept for tests/tools); the page uses `describeRuleLocalized`. */
export function describeRule(s: AppointmentSeries): string {
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month' }[s.frequency];
  const every = s.interval > 1 ? `Every ${s.interval} ${unit}s` : `Every ${unit}`;
  const on = s.frequency === 'WEEKLY' && s.byWeekday?.length ? ` on ${s.byWeekday.map((d) => WEEKDAYS_SHORT[d]).join(', ')}` : s.frequency === 'MONTHLY' && s.byMonthDay ? ` on day ${s.byMonthDay}` : '';
  const end = s.count ? `, ${s.count} times` : s.until ? `, until ${fmtDate(s.until)}` : '';
  return `${every}${on} at ${s.startTime} · ${s.durationMinutes} min${end}`;
}

/** Localised recurrence rule: "Every 2 weeks on Mon, Wed at 09:00 · 30 min, 6 times". */
export function describeRuleLocalized(s: AppointmentSeries, lang: LanguageService): string {
  const days = lang.weekdayNames('short');
  const every = s.interval > 1 ? lang.t('series.everyN', { n: s.interval, unit: lang.t(`series.units.${s.frequency}`) }) : lang.enumLabel(s.frequency, 'frequency');
  const on = s.frequency === 'WEEKLY' && s.byWeekday?.length ? ' ' + lang.t('series.onDays', { days: s.byWeekday.map((d) => days[d]).join(lang.t('common.listSeparator')) })
    : s.frequency === 'MONTHLY' && s.byMonthDay ? ' ' + lang.t('series.onDay', { day: s.byMonthDay }) : '';
  const end = s.count ? lang.t('series.occurrencesCount', { n: s.count }) : s.until ? lang.t('series.until', { date: lang.formatDate(s.until) }) : '';
  return lang.t('series.rule', { every, on, time: s.startTime, duration: lang.formatMinutes(s.durationMinutes), end: end ? `, ${end}` : '' });
}

@Component({
  selector: 'cf-series-detail',
  imports: [RouterLink, TranslatePipe, PageHeaderComponent, StatusChipComponent, RiskBadgeComponent],
  template: `
    <div class="page" style="max-width: 1000px">
      @if (series(); as s) {
        <cf-page-header [title]="'series.title' | translate" [subtitle]="rule()">
          <cf-chip [status]="s.status" group="status" />
          @if (canWrite && s.status === 'ACTIVE' && futureCount() > 0) { <button type="button" class="btn danger-outline" (click)="cancelFuture()" [disabled]="busy()">{{ 'series.cancelFuture' | translate }}</button> }
          <a class="btn" routerLink="/calendar">{{ 'nav.calendar' | translate }}</a>
        </cf-page-header>

        <div class="grid" style="grid-template-columns: 2fr 1fr">
          <div class="card">
            <div class="card-header"><h3>{{ 'series.occurrences' | translate }} <span class="muted small">{{ 'series.occurrencesSummary' | translate: { total: occurrences().length, upcoming: futureCount() } }}</span></h3></div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>#</th><th>{{ 'common.when' | translate }}</th><th>{{ 'common.doctor' | translate }}</th><th>{{ 'common.status' | translate }}</th><th>{{ 'risk.column' | translate }}</th><th></th></tr></thead>
                <tbody>
                  @for (a of occurrences(); track a.id) {
                    <tr>
                      <td class="mono">{{ (a.occurrenceIndex ?? $index) + 1 }}@if (a.isException) { <span class="chip amber" style="margin-inline-start: 6px" [title]="'series.exceptionHint' | translate">{{ 'series.exception' | translate }}</span> }</td>
                      <td class="nowrap">{{ lang.formatDateTime(a.startsAt) }} – {{ lang.formatTime(a.endsAt) }}</td>
                      <td><span class="row gap-1"><span class="pill-color" [style.background]="a.doctor?.color || '#94a3b8'"></span>{{ a.doctor?.firstName }} {{ a.doctor?.lastName }}</span></td>
                      <td><cf-chip [status]="a.status" group="status" /></td>
                      <td><cf-risk-badge [risk]="a.noShowRisk" /></td>
                      <td class="actions"><a class="btn xs" [routerLink]="['/appointments', a.id]">{{ 'common.open' | translate }}</a></td>
                    </tr>
                  } @empty { <tr><td colspan="6" class="empty">{{ 'series.noOccurrences' | translate }}</td></tr> }
                </tbody>
              </table>
            </div>
          </div>
          <div class="col">
            <div class="card">
              <div class="card-header"><h3>{{ 'series.ruleTitle' | translate }}</h3></div>
              <div class="card-body">
                <dl class="kv" style="grid-template-columns: 90px 1fr">
                  <dt>{{ 'common.patient' | translate }}</dt><dd><a [routerLink]="['/patients', s.patientId]">{{ s.patient?.firstName || ('common.patient' | translate) }} {{ s.patient?.lastName || '' }}</a></dd>
                  <dt>{{ 'common.doctor' | translate }}</dt><dd><a [routerLink]="['/doctors', s.doctorId]">{{ s.doctor?.firstName || ('common.doctor' | translate) }} {{ s.doctor?.lastName || '' }}</a></dd>
                  <dt>{{ 'series.repeats' | translate }}</dt><dd>{{ rule() }}</dd>
                  <dt>{{ 'series.starts' | translate }}</dt><dd>{{ lang.formatDate(s.startsOn) }}</dd>
                  <dt>{{ 'common.type' | translate }}</dt><dd>{{ s.type ? lang.enumLabel(s.type, 'type') : '—' }}</dd>
                  <dt>{{ 'common.reason' | translate }}</dt><dd>{{ s.reason || '—' }}</dd>
                  <dt>{{ 'common.created' | translate }}</dt><dd class="muted">{{ lang.formatDate(s.createdAt) }}</dd>
                </dl>
              </div>
            </div>
          </div>
        </div>
      } @else if (error()) { <div class="inline-alert error">{{ error() }}</div> }
      @else { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
    </div>
  `,
})
export class SeriesDetailPage {
  private readonly api = inject(SeriesApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  readonly lang = inject(LanguageService);
  readonly id = input.required<string>();
  readonly canWrite = this.auth.hasPermission('appointments:write');
  readonly series = signal<AppointmentSeries | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly occurrences = computed<Appointment[]>(() => {
    const s = this.series(); const list = s?.occurrences ?? s?.appointments ?? [];
    return [...list].sort((a, b) => (a.occurrenceIndex ?? 0) - (b.occurrenceIndex ?? 0) || a.startsAt.localeCompare(b.startsAt));
  });
  readonly futureCount = computed(() => this.occurrences().filter((a) => new Date(a.startsAt).getTime() > Date.now() && !['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(a.status)).length);
  readonly rule = computed(() => (this.series() ? describeRuleLocalized(this.series()!, this.lang) : ''));

  ngOnInit() { this.load(); }
  load() {
    this.api.get(this.id()).subscribe({ next: (s) => this.series.set(s), error: (err) => this.error.set(this.lang.errorMessage(err, this.lang.t('series.loadFailed'))) });
  }
  async cancelFuture() {
    if (!(await this.confirm.ask({ title: this.lang.t('series.cancelFuture'), message: this.lang.t('series.cancelFutureConfirm', { n: this.futureCount() }), confirmText: this.lang.t('series.cancelFuture'), danger: true }))) return;
    this.busy.set(true);
    this.api.cancel(this.id()).subscribe({
      next: () => { this.busy.set(false); this.toast.success(this.lang.t('series.futureCancelled')); this.load(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
}
