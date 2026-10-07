import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AppointmentsApi } from '../../core/api/appointments.api';
import { DoctorsApi } from '../../core/api/doctors.api';
import { PatientsApi } from '../../core/api/patients.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { Appointment, Doctor, PatientRef } from '../../core/models';
import { dayRange, isoDate, weekRange } from '../../core/date-utils';
import { DayKey, activeTimeZone, addDaysToKey, minutesOfDay, parseDayKey, startOfDayInZone, zonedTimeToUtc } from '../../core/timezone';
import { PageHeaderComponent } from '../../shared/page-header';
import { HasPermissionDirective } from '../../core/permission.directive';
import { BookingDialogComponent } from './booking-dialog';
import { FindSlotPanelComponent, SlotPick } from './find-slot-panel';

export const CAL_START = 7;
export const CAL_END = 21;
export const HOUR_PX = 56;

export const GRID_PX = (CAL_END - CAL_START) * HOUR_PX;
const MIN_EVENT_PX = 20;

/** `clipped`: the event starts before CAL_START or runs past CAL_END and is pinned to the grid edge. */
export interface CalEvent { a: Appointment; top: number; height: number; col: number; cols: number; color: string; clipped: boolean; }

/**
 * Places one clinic-day's appointments on a column (positions from clinic-local wall-clock time in `tz`);
 * overlapping events share the width. Events outside the 07:00–21:00 grid are pinned to its edge instead of
 * being positioned off-canvas.
 */
export function layoutDay(appts: Appointment[], tz: string | undefined = activeTimeZone()): CalEvent[] {
  const sorted = [...appts].sort((x, y) => x.startsAt.localeCompare(y.startsAt));
  const evs: CalEvent[] = sorted.map((a) => {
    const s = new Date(a.startsAt); const e = new Date(a.endsAt);
    const startMin = minutesOfDay(s, tz) - CAL_START * 60;
    const dur = Math.max(15, (e.getTime() - s.getTime()) / 60000);
    let top = (startMin / 60) * HOUR_PX;
    let height = Math.max(MIN_EVENT_PX, (dur / 60) * HOUR_PX - 2);
    let clipped = false;
    if (top < 0) { height = Math.max(MIN_EVENT_PX, top + height); top = 0; clipped = true; }
    if (top > GRID_PX - MIN_EVENT_PX) { top = GRID_PX - MIN_EVENT_PX; height = MIN_EVENT_PX; clipped = true; }
    if (top + height > GRID_PX) { height = Math.max(MIN_EVENT_PX, GRID_PX - top); clipped = true; }
    return { a, top, height, col: 0, cols: 1, color: a.doctor?.color || '#64748b', clipped };
  });
  // Greedy column assignment for overlap clusters.
  let cluster: CalEvent[] = []; let clusterEnd = -1;
  const flush = () => { const n = Math.max(1, ...cluster.map((c) => c.col + 1)); cluster.forEach((c) => (c.cols = n)); cluster = []; };
  for (const ev of evs) {
    const start = ev.top; const end = ev.top + ev.height;
    if (cluster.length && start >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.top + c.height > start).map((c) => c.col));
    let col = 0; while (used.has(col)) col++;
    ev.col = col; cluster.push(ev); clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return evs;
}

@Component({
  selector: 'cf-calendar',
  imports: [TranslatePipe, PageHeaderComponent, HasPermissionDirective, BookingDialogComponent, FindSlotPanelComponent],
  templateUrl: './calendar.html',
  styleUrl: './calendar.scss',
})
export class CalendarPage {
  private readonly api = inject(AppointmentsApi);
  private readonly doctorsApi = inject(DoctorsApi);
  private readonly patientsApi = inject(PatientsApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly hourPx = HOUR_PX;
  readonly hours = Array.from({ length: CAL_END - CAL_START }, (_, i) => CAL_START + i);
  readonly view = signal<'week' | 'day'>('week');
  /** Clinic-local date the view is anchored on. */
  readonly anchor = signal<DayKey>(isoDate(new Date()));
  readonly doctors = signal<Doctor[]>([]);
  readonly doctorId = signal('');
  readonly appointments = signal<Appointment[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly dialog = signal<{ date: Date | null; patient: PatientRef | null; doctorId?: string; duration?: number; resourceIds?: string[] } | null>(null);
  readonly finder = signal(false);
  readonly lockDoctor = !!this.auth.doctorId() && !this.auth.hasPermission('appointments:read_all');

  /** Clinic-local dates (YYYY-MM-DD) shown as columns. */
  readonly days = computed<DayKey[]>(() => {
    if (this.view() === 'day') return [this.anchor()];
    const { startKey } = weekRange(this.anchor());
    return Array.from({ length: 7 }, (_, i) => addDaysToKey(startKey, i));
  });
  readonly title = computed(() => {
    const d = this.days().map((k) => this.at(k));
    return this.view() === 'day' ? this.lang.formatLongDate(d[0]) : `${this.lang.formatDayMonth(d[0])} – ${this.lang.formatDate(d[6])}`;
  });
  readonly byDay = computed(() => {
    const list = this.appointments().filter((a) => a.status !== 'CANCELLED');
    const tz = activeTimeZone();
    return this.days().map((d) => layoutDay(list.filter((a) => isoDate(new Date(a.startsAt), tz) === d), tz));
  });
  readonly nowTop = computed(() => ((minutesOfDay(new Date(), activeTimeZone()) - CAL_START * 60) / 60) * HOUR_PX);

  constructor() {
    if (this.lockDoctor) this.doctorId.set(this.auth.doctorId()!);
    this.doctorsApi.list().subscribe({ next: (d) => this.doctors.set(d), error: () => undefined });
    this.load();
    const q = this.route.snapshot.queryParamMap;
    if (q.get('find')) { this.finder.set(true); void this.router.navigate([], { queryParams: {}, replaceUrl: true }); }
    if (q.get('new')) {
      const pid = q.get('patientId');
      if (pid) this.patientsApi.get(pid).subscribe({ next: (p) => this.openDialog(null, p), error: () => this.openDialog(null, null) });
      else this.openDialog(null, null);
      void this.router.navigate([], { queryParams: {}, replaceUrl: true });
    }
  }

  /** Clinic-local midnight of a day key (for formatting). */
  at(d: DayKey): Date { return startOfDayInZone(d); }
  isToday(d: DayKey) { return d === isoDate(new Date()); }
  dayLabel(d: DayKey) { return this.lang.formatDate(this.at(d), { weekday: 'short', day: '2-digit' }); }
  /** Grid rows are clinic wall-clock hours. */
  hourLabel(h: number) { return `${String(h).padStart(2, '0')}:00`; }
  timeLabel(a: Appointment) { return this.lang.formatTimeRange(a.startsAt, a.endsAt); }

  setView(v: 'week' | 'day') { this.view.set(v); this.load(); }
  today() { this.anchor.set(isoDate(new Date())); this.load(); }
  shift(n: number) { this.anchor.update((d) => addDaysToKey(d, this.view() === 'day' ? n : n * 7)); this.load(); }
  onDoctor(e: Event) { this.doctorId.set((e.target as HTMLSelectElement).value); this.load(); }

  load() {
    const r = this.view() === 'day' ? dayRange(this.anchor()) : weekRange(this.anchor());
    this.loading.set(true);
    this.error.set(null);
    this.api.calendar({ from: r.from, to: r.to, doctorId: this.doctorId() || undefined }).subscribe({
      next: (list) => { this.appointments.set(list ?? []); this.loading.set(false); },
      error: (err) => { this.loading.set(false); this.appointments.set([]); this.error.set(this.lang.errorMessage(err, this.lang.t('calendar.unavailable'))); },
    });
  }

  /** Click on an empty area of a day column → booking dialog pre-filled with that time (rounded to 15 min). */
  onColumnClick(day: DayKey, e: MouseEvent) {
    if (!this.auth.hasPermission('appointments:write')) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const minutes = Math.floor(((e.clientY - rect.top) / HOUR_PX) * 60 / 15) * 15;
    const { year, month, day: dd } = parseDayKey(day);
    this.openDialog(zonedTimeToUtc(year, month, dd, CAL_START, minutes), null);
  }
  openEvent(a: Appointment, e: Event) { e.stopPropagation(); void this.router.navigate(['/appointments', a.id]); }
  openDialog(date: Date | null, patient: PatientRef | null) { this.dialog.set({ date, patient }); }
  /** A candidate from the Find-a-slot panel → booking dialog prefilled with doctor, time, duration and resources. */
  onSlotPicked(p: SlotPick) {
    this.dialog.set({ date: new Date(p.candidate.startsAt), patient: p.patient, doctorId: p.candidate.doctor.id, duration: p.durationMinutes, resourceIds: p.resourceIds });
  }
  onBooked() { this.dialog.set(null); this.load(); }
}
