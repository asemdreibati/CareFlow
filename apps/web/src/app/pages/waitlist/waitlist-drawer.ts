import { Component, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { WaitlistApi } from '../../core/api/waitlist.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { ConfirmService } from '../../shared/confirm.service';
import { SlotCandidate, WaitlistEntry } from '../../core/models';
import { describeWindows, parseWindows } from '../../core/scheduling/preferred-windows';
import { StatusChipComponent } from '../../shared/status-chip';
import { CountdownComponent } from '../../shared/countdown';

/** Side drawer (inline-end) with the entry details, "Matches" list (book buttons) and offer actions. */
@Component({
  selector: 'cf-waitlist-drawer',
  imports: [RouterLink, TranslatePipe, StatusChipComponent, CountdownComponent],
  template: `
    <div class="scrim" (click)="closed.emit()"></div>
    <aside class="drawer" role="dialog" aria-modal="true">
      <div class="dr-head">
        <div>
          <h2>{{ e().patient?.firstName }} {{ e().patient?.lastName }}</h2>
          <div class="muted small">{{ e().patient?.mrn }}@if (e().patient?.phone) { · <span dir="ltr">{{ e().patient?.phone }}</span> }</div>
        </div>
        <div class="row gap-1"><cf-chip [status]="e().priority" group="priority" /><cf-chip [status]="e().status" group="status" /><button type="button" class="btn ghost icon sm" (click)="closed.emit()" [attr.aria-label]="'common.close' | translate">✕</button></div>
      </div>
      <div class="dr-body">
        <dl class="kv" style="grid-template-columns: 120px 1fr">
          <dt>{{ 'waitlist.lookingFor' | translate }}</dt><dd>@if (e().doctor; as d) { <span class="row gap-1"><span class="pill-color" [style.background]="d.color || '#94a3b8'"></span>{{ d.title }} {{ d.firstName }} {{ d.lastName }}</span> } @else { {{ 'waitlist.anyOf' | translate: { specialty: e().specialty || ('common.doctor' | translate) } }} }</dd>
          <dt>{{ 'common.duration' | translate }}</dt><dd><bdi>{{ lang.formatMinutes(e().durationMinutes) }}</bdi> · {{ lang.enumLabel(e().type || 'CONSULTATION', 'type') }}</dd>
          <dt>{{ 'waitlist.between' | translate }}</dt><dd>{{ lang.formatDate(e().earliestAt) }} <span class="mirror">→</span> {{ e().latestAt ? lang.formatDate(e().latestAt) : ('waitlist.noLimit' | translate) }}</dd>
          <dt>{{ 'windows.short' | translate }}</dt><dd>{{ windows() }}</dd>
          @if (e().notes) { <dt>{{ 'common.notes' | translate }}</dt><dd style="white-space: pre-line">{{ e().notes }}</dd> }
          <dt>{{ 'waitlist.offers' | translate }}</dt><dd>{{ 'waitlist.offersSoFar' | translate: { n: e().offerCount, date: lang.formatDate(e().createdAt) } }}</dd>
        </dl>

        @if (e().status === 'OFFERED') {
          <div class="offer card mt-2">
            <div class="card-header"><h3>{{ 'waitlist.slotOffered' | translate }}</h3><cf-countdown [until]="e().offerExpiresAt" [prefix]="('waitlist.expiresIn' | translate) + ' '" /></div>
            <div class="card-body">
              @if (e().offeredAppointment; as a) {
                <div><strong>{{ lang.formatDateTime(a.startsAt) }}</strong> – {{ lang.formatTime(a.endsAt) }}@if (a.doctor) { · <bdi>{{ a.doctor.firstName }} {{ a.doctor.lastName }}</bdi> }</div>
              } @else if (e().offeredAppointmentId) {
                <a [routerLink]="['/appointments', e().offeredAppointmentId]">{{ 'waitlist.openHeld' | translate }}</a>
              }
              <p class="muted small mt-1">{{ 'waitlist.offerHint' | translate }}</p>
              @if (canWrite) {
                <div class="btn-group">
                  <button type="button" class="btn success" (click)="accept()" [disabled]="busy()">{{ 'waitlist.accept' | translate }}</button>
                  <button type="button" class="btn danger-outline" (click)="decline()" [disabled]="busy()">{{ 'waitlist.decline' | translate }}</button>
                  @if (e().offeredAppointmentId) { <a class="btn" [routerLink]="['/appointments', e().offeredAppointmentId]">{{ 'appointments.open' | translate }}</a> }
                </div>
              }
            </div>
          </div>
        }
        @if (e().status === 'BOOKED' && e().offeredAppointmentId) {
          <div class="inline-alert success mt-2">{{ 'enums.status.BOOKED' | translate }} · <a [routerLink]="['/appointments', e().offeredAppointmentId]">{{ 'appointments.open' | translate }}</a></div>
        }

        @if (e().status === 'WAITING' || e().status === 'OFFERED') {
          <div class="card mt-2">
            <div class="card-header"><h3>{{ 'waitlist.matches' | translate }} <span class="muted small">{{ 'waitlist.matchesHint' | translate }}</span></h3><button type="button" class="btn xs" (click)="loadMatches()" [disabled]="matchesLoading()">{{ 'common.refresh' | translate }}</button></div>
            @if (matchesLoading()) { <div class="loading"><span class="spinner"></span> {{ 'common.searching' | translate }}</div> }
            @else if (matchesError()) { <div class="empty">{{ matchesError() }}</div> }
            @else {
              @for (m of matches(); track m.doctor.id + m.startsAt; let i = $index) {
                <div class="match" [style.border-inline-start-color]="m.doctor.color || '#94a3b8'">
                  <div class="flex-1">
                    <div><strong>{{ lang.formatWeekdayDate(m.startsAt) }} · {{ lang.formatTimeRange(m.startsAt, m.endsAt) }}</strong></div>
                    <div class="small muted row gap-1"><span class="pill-color" [style.background]="m.doctor.color || '#94a3b8'"></span>{{ m.doctor.title }} {{ m.doctor.firstName }} {{ m.doctor.lastName }}</div>
                    @if (m.reasons?.length) { <div class="row gap-1 wrap mt-1">@for (r of m.reasons; track r) { <span class="chip teal">{{ r }}</span> }</div> }
                  </div>
                  @if (canWrite) { <button type="button" class="btn sm primary" (click)="book(m)" [disabled]="busy()">{{ 'booking.bookShort' | translate }}</button> }
                </div>
              } @empty { <div class="empty">{{ 'waitlist.noMatches' | translate }}</div> }
            }
          </div>
        }
      </div>
      @if (canWrite && (e().status === 'WAITING' || e().status === 'OFFERED')) {
        <div class="dr-foot"><button type="button" class="btn danger-outline" (click)="cancel()" [disabled]="busy()">{{ 'waitlist.cancelEntry' | translate }}</button></div>
      }
    </aside>
  `,
  styles: [`
    :host { display: contents; }
    .scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.35); z-index: 90; }
    .drawer { position: fixed; top: 0; inset-inline-end: 0; bottom: 0; width: min(520px, 100vw); background: var(--cf-surface); box-shadow: var(--cf-shadow-lg); z-index: 95; display: flex; flex-direction: column; animation: slide 0.18s ease-out; }
    :host-context([dir='rtl']) .drawer { animation-name: slide-rtl; }
    .dr-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--cf-border); }
    .dr-head h2 { font-size: 17px; }
    .dr-body { padding: 20px; overflow-y: auto; flex: 1; }
    .dr-foot { padding: 12px 20px; border-top: 1px solid var(--cf-border); display: flex; justify-content: flex-end; }
    .match { display: flex; gap: 12px; align-items: center; padding: 10px 14px; border-inline-start: 4px solid; border-bottom: 1px solid var(--cf-border); }
    .match:last-child { border-bottom: none; }
    .offer { border-color: #fde68a; }
    @keyframes slide { from { transform: translateX(16px); opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes slide-rtl { from { transform: translateX(-16px); opacity: 0; } to { transform: none; opacity: 1; } }
  `],
})
export class WaitlistDrawerComponent {
  private readonly api = inject(WaitlistApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  readonly lang = inject(LanguageService);
  readonly e = input.required<WaitlistEntry>({ alias: 'entry' });
  readonly closed = output<void>();
  readonly changed = output<void>();
  readonly canWrite = this.auth.hasPermission('appointments:write');
  readonly matches = signal<SlotCandidate[]>([]);
  readonly matchesLoading = signal(false);
  readonly matchesError = signal<string | null>(null);
  readonly busy = signal(false);
  readonly windows = computed(() => {
    const rows = parseWindows(this.e().preferredWindows);
    return rows.length ? describeWindows(rows, this.lang.weekdayNames('short')) : this.lang.t('windows.anyTime');
  });

  ngOnInit() { if (this.e().status === 'WAITING' || this.e().status === 'OFFERED') this.loadMatches(); }
  @HostListener('document:keydown.escape') onEsc() { this.closed.emit(); }

  loadMatches() {
    this.matchesLoading.set(true); this.matchesError.set(null);
    this.api.matches(this.e().id).subscribe({
      next: (m) => { this.matches.set(m); this.matchesLoading.set(false); },
      error: (err) => { this.matchesLoading.set(false); this.matches.set([]); this.matchesError.set(this.lang.errorMessage(err, this.lang.t('waitlist.matchesUnavailable'))); },
    });
  }
  book(m: SlotCandidate) {
    this.busy.set(true);
    this.api.book(this.e().id, { startsAt: m.startsAt, doctorId: m.doctor.id }).subscribe({
      next: () => { this.busy.set(false); this.toast.success(this.lang.t('waitlist.bookedFromWaitlist')); this.changed.emit(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); if (err?.status === 409) this.loadMatches(); },
    });
  }
  accept() {
    this.busy.set(true);
    this.api.accept(this.e().id).subscribe({
      next: () => { this.busy.set(false); this.toast.success(this.lang.t('waitlist.offerAccepted')); this.changed.emit(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
  async decline() {
    if (!(await this.confirm.ask({ title: this.lang.t('waitlist.declineTitle'), message: this.lang.t('waitlist.declineConfirm'), confirmText: this.lang.t('waitlist.decline'), danger: true }))) return;
    this.busy.set(true);
    this.api.decline(this.e().id).subscribe({
      next: () => { this.busy.set(false); this.toast.info(this.lang.t('waitlist.offerDeclined')); this.changed.emit(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
  async cancel() {
    if (!(await this.confirm.ask({ title: this.lang.t('waitlist.cancelTitle'), message: this.lang.t('waitlist.cancelConfirm'), confirmText: this.lang.t('waitlist.cancelEntry'), danger: true }))) return;
    this.busy.set(true);
    this.api.cancel(this.e().id).subscribe({
      next: () => { this.busy.set(false); this.toast.success(this.lang.t('waitlist.entryCancelled')); this.changed.emit(); this.closed.emit(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
}
