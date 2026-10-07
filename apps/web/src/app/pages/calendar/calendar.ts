import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { addDays, isSameDay, startOfDay } from 'date-fns';
import { TranslatePipe } from '@ngx-translate/core';
import { AppointmentsApi } from '../../core/api/appointments.api';
import { DoctorsApi } from '../../core/api/doctors.api';
import { PatientsApi } from '../../core/api/patients.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { Appointment, Doctor, PatientRef } from '../../core/models';
import { dayRange, weekRange } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { HasPermissionDirective } from '../../core/permission.directive';
import { BookingDialogComponent } from './booking-dialog';
import { FindSlotPanelComponent, SlotPick } from './find-slot-panel';

export const CAL_START = 7;
export const CAL_END = 21;
export const HOUR_PX = 56;

export interface CalEvent { a: Appointment; top: number; height: number; col: number; cols: number; color: string; }

/** Places appointments on a day column; overlapping events share the width. */
export function layoutDay(appts: Appointment[]): CalEvent[] {
  const sorted = [...appts].sort((x, y) => x.startsAt.localeCompare(y.startsAt));
  const evs: CalEvent[] = sorted.map((a) => {
    const s = new Date(a.startsAt); const e = new Date(a.endsAt);
    const startMin = s.getHours() * 60 + s.getMinutes() - CAL_START * 60;
    const dur = Math.max(15, (e.getTime() - s.getTime()) / 60000);
    return { a, top: (startMin / 60) * HOUR_PX, height: Math.max(20, (dur / 60) * HOUR_PX - 2), col: 0, cols: 1, color: a.doctor?.color || '#64748b' };
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
  readonly anchor = signal(startOfDay(new Date()));
  readonly doctors = signal<Doctor[]>([]);
  readonly doctorId = signal('');
  readonly appointments = signal<Appointment[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly dialog = signal<{ date: Date | null; patient: PatientRef | null; doctorId?: string; duration?: number; resourceIds?: string[] } | null>(null);
  readonly finder = signal(false);
  readonly lockDoctor = !!this.auth.doctorId() && !this.auth.hasPermission('appointments:read_all');

  readonly days = computed(() => {
    if (this.view() === 'day') return [this.anchor()];
    const { start } = weekRange(this.anchor());
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  });
  readonly title = computed(() => {
    const d = this.days();
    return this.view() === 'day' ? this.lang.formatLongDate(d[0]) : `${this.lang.formatDayMonth(d[0])} – ${this.lang.formatDate(d[6])}`;
  });
  readonly byDay = computed(() => {
    const list = this.appointments().filter((a) => a.status !== 'CANCELLED');
    return this.days().map((d) => layoutDay(list.filter((a) => isSameDay(new Date(a.startsAt), d))));
  });
  readonly nowTop = computed(() => { const n = new Date(); return ((n.getHours() * 60 + n.getMinutes() - CAL_START * 60) / 60) * HOUR_PX; });

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

  isToday(d: Date) { return isSameDay(d, new Date()); }
  dayLabel(d: Date) { return this.lang.formatDate(d, { weekday: 'short', day: '2-digit' }); }
  hourLabel(h: number) { return this.lang.formatTime(new Date(2000, 0, 1, h, 0, 0)); }
  timeLabel(a: Appointment) { return this.lang.formatTimeRange(a.startsAt, a.endsAt); }

  setView(v: 'week' | 'day') { this.view.set(v); this.load(); }
  today() { this.anchor.set(startOfDay(new Date())); this.load(); }
  shift(n: number) { this.anchor.update((d) => addDays(d, this.view() === 'day' ? n : n * 7)); this.load(); }
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
  onColumnClick(day: Date, e: MouseEvent) {
    if (!this.auth.hasPermission('appointments:write')) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const minutes = Math.floor(((e.clientY - rect.top) / HOUR_PX) * 60 / 15) * 15;
    const d = new Date(day); d.setHours(CAL_START, minutes, 0, 0);
    this.openDialog(d, null);
  }
  openEvent(a: Appointment, e: Event) { e.stopPropagation(); void this.router.navigate(['/appointments', a.id]); }
  openDialog(date: Date | null, patient: PatientRef | null) { this.dialog.set({ date, patient }); }
  /** A candidate from the Find-a-slot panel → booking dialog prefilled with doctor, time, duration and resources. */
  onSlotPicked(p: SlotPick) {
    this.dialog.set({ date: new Date(p.candidate.startsAt), patient: p.patient, doctorId: p.candidate.doctor.id, duration: p.durationMinutes, resourceIds: p.resourceIds });
  }
  onBooked() { this.dialog.set(null); this.load(); }
}
