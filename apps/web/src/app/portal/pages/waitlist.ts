import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { PreferredWindow } from '../../core/models';
import { addWindow, normalizeWindows, removeWindow, updateWindow, validateWindows } from '../../core/scheduling/preferred-windows';
import { timeOptions } from '../../core/date-utils';
import { ToastService } from '../../core/toast.service';
import { PortalApi } from '../portal-api.service';
import { PortalChip, useFormat } from '../portal-ui';
import { PortalClinicInfo, PortalWaitlistEntry } from '../portal.models';
import { WaitlistOfferCard } from './waitlist-offer';

/** Waitlist: join form (doctor or specialty + simple preferred-windows editor) and my entries with offers. */
@Component({
  selector: 'cf-portal-waitlist',
  imports: [FormsModule, TranslatePipe, PortalChip, WaitlistOfferCard],
  template: `
    <div class="pt-fade">
      <h1 class="pt-title">{{ 'portal.waitlist.title' | translate }}</h1>
      <p class="pt-muted">{{ 'portal.waitlist.intro' | translate }}</p>

      @for (o of offers(); track o.id) { <cf-portal-offer [entry]="o" (changed)="load()" /> }

      <div class="pt-section">{{ 'portal.waitlist.join' | translate }}</div>
      <form class="pt-card" (ngSubmit)="join()" novalidate>
        <div class="pt-segment" role="tablist">
          <button type="button" [class.active]="mode() === 'doctor'" (click)="mode.set('doctor')">{{ 'portal.book.byDoctor' | translate }}</button>
          <button type="button" [class.active]="mode() === 'specialty'" (click)="mode.set('specialty')">{{ 'portal.book.bySpecialty' | translate }}</button>
        </div>
        @if (mode() === 'doctor') {
          <select class="pt-input" [(ngModel)]="doctorId" name="doctorId" aria-label="doctor">
            <option value="">{{ 'portal.book.chooseDoctor' | translate }}</option>
            @for (d of clinic()?.doctors ?? []; track d.id) { <option [value]="d.id">{{ f.doctor(d) }} · {{ d.specialty }}</option> }
          </select>
        } @else {
          <select class="pt-input" [(ngModel)]="specialty" name="specialty" aria-label="specialty">
            <option value="">{{ 'portal.book.chooseSpecialty' | translate }}</option>
            @for (s of specialties(); track s) { <option [value]="s">{{ s }}</option> }
          </select>
        }

        <div class="pt-section">{{ 'portal.waitlist.preferredWindows' | translate }}</div>
        @for (w of windows(); track $index; let i = $index) {
          <div class="win">
            <select class="pt-input" [ngModel]="w.weekday" (ngModelChange)="patch(i, { weekday: +$event })" [name]="'wd' + i" aria-label="weekday">
              @for (d of dayOrder; track d) { <option [ngValue]="d">{{ ('portal.weekdays.' + d) | translate }}</option> }
            </select>
            <select class="pt-input" [ngModel]="w.startTime" (ngModelChange)="patch(i, { startTime: $event })" [name]="'from' + i" [attr.aria-label]="'portal.waitlist.from' | translate">
              @for (t of times; track t) { <option [value]="t">{{ t }}</option> }
            </select>
            <select class="pt-input" [ngModel]="w.endTime" (ngModelChange)="patch(i, { endTime: $event })" [name]="'to' + i" [attr.aria-label]="'portal.waitlist.to' | translate">
              @for (t of times; track t) { <option [value]="t">{{ t }}</option> }
            </select>
            <button type="button" class="pt-btn icon" (click)="remove(i)" [attr.aria-label]="'portal.waitlist.remove' | translate">✕</button>
          </div>
        } @empty { <div class="pt-hint" style="margin-bottom:8px">{{ 'portal.waitlist.anyTime' | translate }}</div> }
        @if (problem()) { <div class="pt-error" style="margin-bottom:8px">{{ 'portal.waitlist.windowsInvalid' | translate }}</div> }
        <button type="button" class="pt-btn ghost sm" (click)="add()">+ {{ 'portal.waitlist.addWindow' | translate }}</button>
        <button type="submit" class="pt-btn primary block" style="margin-top:12px" [disabled]="submitting() || !hasTarget() || !!problem()">{{ (submitting() ? 'portal.waitlist.submitting' : 'portal.waitlist.submit') | translate }}</button>
      </form>

      <div class="pt-section">{{ 'portal.waitlist.mine' | translate }}</div>
      @if (loading()) { <div class="pt-loading"><span class="spinner"></span>{{ 'portal.common.loading' | translate }}</div> }
      @else if (!entries().length) { <div class="pt-empty" style="padding:20px">{{ 'portal.waitlist.empty' | translate }}</div> }
      @else {
        <div class="pt-list">
          @for (e of entries(); track e.id) {
            <div class="pt-item">
              <div class="body">
                <div class="primary">{{ e.doctor ? f.doctor(e.doctor) : (e.specialty || ('portal.waitlist.anyDoctor' | translate)) }}</div>
                <div class="secondary">{{ f.date(e.createdAt) }}@if (e.preferredWindows && e.preferredWindows.length) { · {{ describe(e.preferredWindows) }} }</div>
                <div style="margin-top:6px"><cf-portal-chip [status]="e.status" /></div>
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`.win { display: grid; grid-template-columns: 1.2fr 1fr 1fr auto; gap: 6px; margin-bottom: 8px; align-items: center; } .win .pt-input { padding-inline: 8px; font-size: 14px; }`],
})
export class PortalWaitlistPage {
  readonly f = useFormat();
  private readonly api = inject(PortalApi);
  private readonly toast = inject(ToastService);
  readonly clinic = signal<PortalClinicInfo | null>(null);
  readonly entries = signal<PortalWaitlistEntry[]>([]);
  readonly loading = signal(true);
  readonly submitting = signal(false);
  readonly mode = signal<'doctor' | 'specialty'>('doctor');
  readonly windows = signal<PreferredWindow[]>([]);
  doctorId = '';
  specialty = '';
  readonly dayOrder = [0, 1, 2, 3, 4, 5, 6];
  readonly times = timeOptions(30, 7, 22);
  readonly specialties = computed(() => Array.from(new Set((this.clinic()?.doctors ?? []).map((d) => d.specialty).filter(Boolean))).sort());
  readonly offers = computed(() => this.entries().filter((e) => e.status === 'OFFERED'));
  readonly problem = computed(() => validateWindows(this.windows()));

  constructor() {
    this.api.clinic().subscribe({ next: (c) => this.clinic.set({ ...c, doctors: c?.doctors ?? [] }), error: () => this.clinic.set({ name: '', doctors: [] }) });
    this.load();
  }

  hasTarget() { return this.mode() === 'doctor' ? !!this.doctorId : !!this.specialty; }
  add() { this.windows.update((w) => addWindow(w)); }
  remove(i: number) { this.windows.update((w) => removeWindow(w, i)); }
  patch(i: number, p: Partial<PreferredWindow>) { this.windows.update((w) => updateWindow(w, i, p)); }
  describe(rows: PreferredWindow[]) {
    return rows.map((r) => `${this.f.lang.t('portal.weekdays.' + r.weekday)} ${r.startTime}–${r.endTime}`).join(', ');
  }

  load() {
    this.loading.set(true);
    this.api.waitlist().subscribe({
      next: (list) => { this.entries.set([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))); this.loading.set(false); },
      error: () => { this.entries.set([]); this.loading.set(false); },
    });
  }

  join() {
    if (!this.hasTarget() || this.problem()) return;
    this.submitting.set(true);
    const windows = normalizeWindows(this.windows());
    const target = this.mode() === 'doctor' ? { doctorId: this.doctorId } : { specialty: this.specialty };
    this.api.joinWaitlist({ ...target, priority: 'ROUTINE', ...(windows.length ? { preferredWindows: windows } : {}) }).subscribe({
      next: () => { this.submitting.set(false); this.toast.success(this.f.lang.t('portal.waitlist.joined')); this.windows.set([]); this.load(); },
      error: (err: unknown) => { this.submitting.set(false); this.toast.fromError(err, this.f.lang.t('portal.errors.generic')); },
    });
  }
}
