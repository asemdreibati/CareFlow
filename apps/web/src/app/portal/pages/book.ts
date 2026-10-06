import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { newIdempotencyKey } from '../../core/api/booking-headers';
import { ToastService } from '../../core/toast.service';
import { PortalApi } from '../portal-api.service';
import { useFormat } from '../portal-ui';
import { PortalClinicInfo, PortalDoctor, PortalSlot } from '../portal.models';

const DAYS_AHEAD = 14;

/** Start of the next N local days (today first). */
export function nextDays(count = DAYS_AHEAD, from: Date = new Date()): Date[] {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  return Array.from({ length: count }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Book flow: doctor or specialty → day (next 14) → slot grid (`GET /portal/slots`) → reason → confirm
 * (`POST /portal/appointments` with an `Idempotency-Key`; 409 → friendly message + slots refresh).
 */
@Component({
  selector: 'cf-portal-book',
  imports: [FormsModule, RouterLink, TranslatePipe],
  template: `
    <div class="pt-fade">
      <h1 class="pt-title">{{ 'portal.book.title' | translate }}</h1>

      @if (clinicError()) { <div class="pt-alert error pt-row between">{{ clinicError() }} <button type="button" class="pt-btn sm" (click)="loadClinic()">{{ 'portal.common.retry' | translate }}</button></div> }

      <div class="pt-section">{{ 'portal.book.who' | translate }}</div>
      <div class="pt-segment" role="tablist">
        <button type="button" [class.active]="mode() === 'doctor'" (click)="setMode('doctor')">{{ 'portal.book.byDoctor' | translate }}</button>
        <button type="button" [class.active]="mode() === 'specialty'" (click)="setMode('specialty')">{{ 'portal.book.bySpecialty' | translate }}</button>
      </div>
      @if (mode() === 'doctor') {
        <select class="pt-input" [ngModel]="doctorId()" (ngModelChange)="doctorId.set($event)" aria-label="doctor">
          <option value="">{{ 'portal.book.chooseDoctor' | translate }}</option>
          @for (d of doctors(); track d.id) { <option [value]="d.id">{{ f.doctor(d) }} · {{ d.specialty }}</option> }
        </select>
      } @else {
        <select class="pt-input" [ngModel]="specialty()" (ngModelChange)="specialty.set($event)" aria-label="specialty">
          <option value="">{{ 'portal.book.chooseSpecialty' | translate }}</option>
          @for (s of specialties(); track s) { <option [value]="s">{{ s }}</option> }
        </select>
      }
      @if (clinic() && !doctors().length) { <div class="pt-hint" style="margin-top:6px">{{ 'portal.book.noDoctors' | translate }}</div> }

      <div class="pt-section">{{ 'portal.book.day' | translate }}</div>
      <div class="pt-scroll">
        @for (d of days; track dayKey(d); let i = $index) {
          <button type="button" class="pt-day" [class.active]="dayKey(d) === dayKey(day())" (click)="day.set(d)">
            <div class="w">{{ i === 0 ? ('portal.common.today' | translate) : f.lang.formatDate(d, { weekday: 'short' }) }}</div>
            <div class="n">{{ f.day(d) }}</div>
            <div class="w">{{ f.month(d) }}</div>
          </button>
        }
      </div>

      <div class="pt-section">{{ 'portal.book.slots' | translate }}</div>
      @if (!hasTarget()) { <div class="pt-card pt-muted">{{ 'portal.book.selectFirst' | translate }}</div> }
      @else if (slotsLoading()) { <div class="pt-card pt-loading"><span class="spinner"></span>{{ 'portal.book.loadingSlots' | translate }}</div> }
      @else if (!slots().length) {
        <div class="pt-card">
          <div class="pt-empty" style="padding:16px 8px">{{ 'portal.book.noSlots' | translate }}</div>
          <a class="pt-btn block" routerLink="/portal/app/waitlist">{{ 'portal.book.joinWaitlist' | translate }}</a>
        </div>
      } @else {
        <div class="pt-slots">
          @for (s of slots(); track s.startsAt + s.doctor.id) {
            <button type="button" class="pt-slot" [class.active]="isSelected(s)" (click)="selected.set(s)" [title]="f.doctor(s.doctor)">{{ f.time(s.startsAt) }}</button>
          }
        </div>
      }

      @if (selected(); as s) {
        <div class="pt-card accent pt-fade" style="margin-top:16px">
          <div class="pt-section" style="margin-top:0">{{ 'portal.book.summary' | translate }}</div>
          <div class="pt-strong" style="font-size:16px">{{ f.dateTime(s.startsAt) }}</div>
          <div class="pt-muted">{{ 'portal.book.with' | translate: { doctor: f.doctor(s.doctor) } }} · {{ s.doctor.specialty }}</div>
          <div class="pt-field" style="margin-top:12px">
            <label for="reason">{{ 'portal.book.reason' | translate }}</label>
            <textarea id="reason" class="pt-input" [(ngModel)]="reason" maxlength="500" [placeholder]="'portal.book.reasonPlaceholder' | translate"></textarea>
          </div>
          <button type="button" class="pt-btn primary block" (click)="book()" [disabled]="booking()">{{ (booking() ? 'portal.book.booking' : 'portal.book.confirm') | translate }}</button>
        </div>
      }
    </div>
  `,
  styles: [`.pt-scroll { display: flex; gap: 8px; overflow-x: auto; padding: 2px 0 8px; scrollbar-width: none; } .pt-scroll::-webkit-scrollbar { display: none; } .pt-day { flex: 0 0 auto; width: 58px; padding: 8px 0; border-radius: 12px; border: 1px solid var(--cf-border); background: var(--cf-surface); text-align: center; font: inherit; cursor: pointer; line-height: 1.2; } .pt-day .w { font-size: 11px; color: var(--cf-text-3); font-weight: 600; } .pt-day .n { font-size: 18px; font-weight: 700; } .pt-day.active { background: var(--cf-primary); border-color: var(--cf-primary); color: #fff; } .pt-day.active .w { color: rgba(255, 255, 255, 0.8); } .pt-slots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; } .pt-slot { min-height: 42px; border-radius: 10px; border: 1px solid var(--cf-border-strong); background: var(--cf-surface); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; font-variant-numeric: tabular-nums; } .pt-slot.active { background: var(--cf-primary); border-color: var(--cf-primary); color: #fff; } .pt-slot:disabled { opacity: 0.4; cursor: not-allowed; }`],
})
export class PortalBookPage {
  readonly f = useFormat();
  private readonly api = inject(PortalApi);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  readonly days = nextDays();
  readonly dayKey = dayKey;
  readonly clinic = signal<PortalClinicInfo | null>(null);
  readonly clinicError = signal<string | null>(null);
  readonly mode = signal<'doctor' | 'specialty'>('doctor');
  readonly doctorId = signal('');
  readonly specialty = signal('');
  readonly day = signal<Date>(this.days[0]);
  readonly slots = signal<PortalSlot[]>([]);
  readonly slotsLoading = signal(false);
  readonly selected = signal<PortalSlot | null>(null);
  readonly booking = signal(false);
  reason = '';
  private idempotencyKey = newIdempotencyKey();
  private slotsRequest = 0;

  readonly doctors = computed<PortalDoctor[]>(() => this.clinic()?.doctors ?? []);
  readonly specialties = computed(() => Array.from(new Set(this.doctors().map((d) => d.specialty).filter(Boolean))).sort());
  readonly hasTarget = computed(() => (this.mode() === 'doctor' ? !!this.doctorId() : !!this.specialty()));

  constructor() {
    this.loadClinic();
    // Re-query slots whenever the target (doctor/specialty) or the day changes.
    effect(() => {
      const target = this.mode() === 'doctor' ? { doctorId: this.doctorId() } : { specialty: this.specialty() };
      const day = this.day();
      untracked(() => this.loadSlots(target, day));
    });
  }

  loadClinic() {
    this.clinicError.set(null);
    this.api.clinic().subscribe({
      next: (c) => this.clinic.set({ ...c, doctors: c?.doctors ?? [] }),
      error: (err: unknown) => this.clinicError.set((err as { status?: number })?.status === 0 ? this.f.lang.t('portal.errors.network') : this.f.lang.t('portal.errors.notAvailable')),
    });
  }
  setMode(m: 'doctor' | 'specialty') { this.mode.set(m); this.selected.set(null); }
  isSelected(s: PortalSlot) { const sel = this.selected(); return !!sel && sel.startsAt === s.startsAt && sel.doctor.id === s.doctor.id; }

  loadSlots(target: { doctorId?: string; specialty?: string }, day: Date) {
    this.selected.set(null);
    if (!target.doctorId && !target.specialty) { this.slots.set([]); return; }
    const req = ++this.slotsRequest;
    const from = new Date(Math.max(day.getTime(), Date.now()));
    const to = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    if (to.getTime() <= from.getTime()) { this.slots.set([]); return; }
    this.slotsLoading.set(true);
    this.api.slots({ ...target, from: from.toISOString(), to: to.toISOString() }).subscribe({
      next: (list) => {
        if (req !== this.slotsRequest) return;
        this.slots.set([...list].filter((s) => new Date(s.startsAt).getTime() >= Date.now()).sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
        this.slotsLoading.set(false);
      },
      error: (err: unknown) => {
        if (req !== this.slotsRequest) return;
        this.slots.set([]);
        this.slotsLoading.set(false);
        this.toast.fromError(err, this.f.lang.t('portal.errors.generic'));
      },
    });
  }

  book() {
    const s = this.selected();
    if (!s || this.booking()) return;
    this.booking.set(true);
    const reason = this.reason.trim();
    this.api.book({ doctorId: s.doctor.id, startsAt: s.startsAt, ...(reason ? { reason } : {}) }, this.idempotencyKey).subscribe({
      next: (appt) => {
        this.idempotencyKey = newIdempotencyKey();
        this.toast.success(this.f.lang.t('portal.book.booked'));
        void this.router.navigate(appt?.id ? ['/portal/app/appointments', appt.id] : ['/portal/app/appointments']);
      },
      error: (err: unknown) => {
        this.booking.set(false);
        if ((err as { status?: number })?.status === 409) {
          this.idempotencyKey = newIdempotencyKey();
          this.toast.warn(this.f.lang.t('portal.book.conflict'));
          const target = this.mode() === 'doctor' ? { doctorId: this.doctorId() } : { specialty: this.specialty() };
          this.loadSlots(target, this.day());
        } else {
          this.toast.fromError(err, this.f.lang.t('portal.errors.generic'));
        }
      },
    });
  }
}
