import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { DoctorsApi } from '../../core/api/doctors.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { ConfirmService } from '../../shared/confirm.service';
import { AvailabilitySlot, Doctor } from '../../core/models';
import { fromLocalInput, timeOptions } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { HasPermissionDirective } from '../../core/permission.directive';

@Component({
  selector: 'cf-doctor-detail',
  imports: [FormsModule, RouterLink, TranslatePipe, PageHeaderComponent, StatusChipComponent, HasPermissionDirective],
  templateUrl: './doctor-detail.html',
  styles: [`
    .day { display: grid; grid-template-columns: 110px 1fr; gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--cf-border); align-items: start; }
    .day:last-child { border-bottom: none; }
    .day .name { font-weight: 600; padding-top: 6px; }
    .slot { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
    .slot select, .slot input { width: auto; }
  `],
})
export class DoctorDetailPage {
  private readonly api = inject(DoctorsApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  readonly lang = inject(LanguageService);
  readonly id = input.required<string>();
  readonly weekdays = computed(() => this.lang.weekdayNames('long'));
  readonly times = timeOptions(15, 6, 23);
  readonly dayOrder = [1, 2, 3, 4, 5, 6, 0];
  readonly doctor = signal<Doctor | null>(null);
  readonly slots = signal<AvailabilitySlot[]>([]);
  readonly dirty = signal(false);
  readonly saving = signal(false);
  readonly canWrite = this.auth.hasPermission('doctors:write');
  timeOff = { startsAt: '', endsAt: '', reason: '' };
  readonly addingTimeOff = signal(false);

  ngOnInit() { this.load(); }
  load() {
    this.api.get(this.id()).subscribe({
      next: (d) => { this.doctor.set(d); this.slots.set((d.availability ?? []).map((s) => ({ weekday: s.weekday, startTime: s.startTime, endTime: s.endTime, slotMinutes: s.slotMinutes ?? 30 }))); this.dirty.set(false); },
      error: (err) => this.toast.fromError(err),
    });
  }
  slotsFor(day: number) { return this.slots().filter((s) => s.weekday === day); }
  addSlot(day: number) {
    this.slots.update((s) => [...s, { weekday: day, startTime: '09:00', endTime: '13:00', slotMinutes: 30 }]);
    this.dirty.set(true);
  }
  removeSlot(slot: AvailabilitySlot) { this.slots.update((s) => s.filter((x) => x !== slot)); this.dirty.set(true); }
  touch() { this.dirty.set(true); }
  copyToWeekdays(day: number) {
    const src = this.slotsFor(day).map((s) => ({ ...s }));
    this.slots.update((all) => [
      ...all.filter((s) => s.weekday === day || s.weekday === 5 || s.weekday === 6),
      ...[0, 1, 2, 3, 4].filter((d) => d !== day).flatMap((d) => src.map((s) => ({ ...s, weekday: d }))),
    ]);
    this.dirty.set(true);
  }
  saveAvailability() {
    const bad = this.slots().find((s) => s.startTime >= s.endTime);
    if (bad) { this.toast.error(this.lang.t('errors.windows.endAfterStart', { day: this.weekdays()[bad.weekday] })); return; }
    this.saving.set(true);
    this.api.setAvailability(this.id(), this.slots().map((s) => ({ weekday: s.weekday, startTime: s.startTime, endTime: s.endTime, slotMinutes: Number(s.slotMinutes) || 30 }))).subscribe({
      next: () => { this.saving.set(false); this.toast.success(this.lang.t('doctors.availabilitySaved')); this.load(); },
      error: (err) => { this.saving.set(false); this.toast.fromError(err); },
    });
  }
  addTimeOff() {
    // datetime-local values are clinic wall-clock times.
    const startsAt = fromLocalInput(this.timeOff.startsAt); const endsAt = fromLocalInput(this.timeOff.endsAt);
    if (!startsAt || !endsAt) return;
    this.addingTimeOff.set(true);
    this.api.addTimeOff(this.id(), {
      startsAt, endsAt, reason: this.timeOff.reason || undefined,
    }).subscribe({
      next: () => { this.addingTimeOff.set(false); this.timeOff = { startsAt: '', endsAt: '', reason: '' }; this.toast.success(this.lang.t('doctors.timeOffAdded')); this.load(); },
      error: (err) => { this.addingTimeOff.set(false); this.toast.fromError(err); },
    });
  }
  async removeTimeOff(id: string) {
    if (!(await this.confirm.ask({ title: this.lang.t('doctors.removeTimeOff'), message: this.lang.t('doctors.removeTimeOffConfirm'), danger: true, confirmText: this.lang.t('common.remove') }))) return;
    this.api.removeTimeOff(this.id(), id).subscribe({ next: () => this.load(), error: (err) => this.toast.fromError(err) });
  }
  async deactivate() {
    const d = this.doctor();
    if (!d || !(await this.confirm.ask({ title: this.lang.t('doctors.deactivate'), message: this.lang.t('doctors.deactivateConfirm', { name: `${d.firstName} ${d.lastName}` }), danger: true, confirmText: this.lang.t('doctors.deactivate') }))) return;
    this.api.deactivate(d.id).subscribe({ next: () => { this.toast.success(this.lang.t('doctors.deactivated')); this.load(); }, error: (err) => this.toast.fromError(err) });
  }
}
