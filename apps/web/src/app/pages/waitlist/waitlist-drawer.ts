import { Component, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { WaitlistApi } from '../../core/api/waitlist.api';
import { AuthService } from '../../core/auth.service';
import { ToastService, errorMessage } from '../../core/toast.service';
import { ConfirmService } from '../../shared/confirm.service';
import { SlotCandidate, WaitlistEntry } from '../../core/models';
import { fmtDate, fmtDateTime, fmtTime } from '../../core/date-utils';
import { describeWindows, parseWindows } from '../../core/scheduling/preferred-windows';
import { StatusChipComponent } from '../../shared/status-chip';
import { CountdownComponent } from '../../shared/countdown';

/** Right-side drawer with the entry details, "Matches" list (book buttons) and offer actions. */
@Component({
  selector: 'cf-waitlist-drawer',
  imports: [RouterLink, StatusChipComponent, CountdownComponent],
  template: `
    <div class="scrim" (click)="closed.emit()"></div>
    <aside class="drawer" role="dialog" aria-modal="true">
      <div class="dr-head">
        <div>
          <h2>{{ e().patient?.firstName }} {{ e().patient?.lastName }}</h2>
          <div class="muted small">{{ e().patient?.mrn }}@if (e().patient?.phone) { · {{ e().patient?.phone }} }</div>
        </div>
        <div class="row gap-1"><cf-chip [status]="e().priority" /><cf-chip [status]="e().status" /><button type="button" class="btn ghost icon sm" (click)="closed.emit()" aria-label="Close">✕</button></div>
      </div>
      <div class="dr-body">
        <dl class="kv" style="grid-template-columns: 120px 1fr">
          <dt>Looking for</dt><dd>@if (e().doctor; as d) { <span class="row gap-1"><span class="pill-color" [style.background]="d.color || '#94a3b8'"></span>{{ d.title }} {{ d.firstName }} {{ d.lastName }}</span> } @else { Any {{ e().specialty || 'doctor' }} }</dd>
          <dt>Duration</dt><dd>{{ e().durationMinutes }} min · {{ e().type || 'CONSULTATION' }}</dd>
          <dt>Between</dt><dd>{{ fmtDate(e().earliestAt) }} → {{ e().latestAt ? fmtDate(e().latestAt) : 'no limit' }}</dd>
          <dt>Windows</dt><dd>{{ windows() }}</dd>
          @if (e().notes) { <dt>Notes</dt><dd style="white-space: pre-line">{{ e().notes }}</dd> }
          <dt>Offers</dt><dd>{{ e().offerCount }} so far · added {{ fmtDate(e().createdAt) }}</dd>
        </dl>

        @if (e().status === 'OFFERED') {
          <div class="offer card mt-2">
            <div class="card-header"><h3>Slot offered</h3><cf-countdown [until]="e().offerExpiresAt" prefix="expires in " /></div>
            <div class="card-body">
              @if (e().offeredAppointment; as a) {
                <div><strong>{{ fmtDateTime(a.startsAt) }}</strong> – {{ fmtTime(a.endsAt) }}@if (a.doctor) { · {{ a.doctor.firstName }} {{ a.doctor.lastName }} }</div>
              } @else if (e().offeredAppointmentId) {
                <a [routerLink]="['/appointments', e().offeredAppointmentId]">Open held appointment</a>
              }
              <p class="muted small mt-1">The slot is held until the countdown ends. Accept when the patient confirms; decline to release it to the next candidate.</p>
              @if (canWrite) {
                <div class="btn-group">
                  <button type="button" class="btn success" (click)="accept()" [disabled]="busy()">Accept</button>
                  <button type="button" class="btn danger-outline" (click)="decline()" [disabled]="busy()">Decline</button>
                  @if (e().offeredAppointmentId) { <a class="btn" [routerLink]="['/appointments', e().offeredAppointmentId]">Open appointment</a> }
                </div>
              }
            </div>
          </div>
        }
        @if (e().status === 'BOOKED' && e().offeredAppointmentId) {
          <div class="inline-alert success mt-2">Booked · <a [routerLink]="['/appointments', e().offeredAppointmentId]">open appointment</a></div>
        }

        @if (e().status === 'WAITING' || e().status === 'OFFERED') {
          <div class="card mt-2">
            <div class="card-header"><h3>Matches <span class="muted small">slots that satisfy this entry now</span></h3><button type="button" class="btn xs" (click)="loadMatches()" [disabled]="matchesLoading()">Refresh</button></div>
            @if (matchesLoading()) { <div class="loading"><span class="spinner"></span> Searching…</div> }
            @else if (matchesError()) { <div class="empty">{{ matchesError() }}</div> }
            @else {
              @for (m of matches(); track m.doctor.id + m.startsAt; let i = $index) {
                <div class="match" [style.border-left-color]="m.doctor.color || '#94a3b8'">
                  <div class="flex-1">
                    <div><strong>{{ fmtDate(m.startsAt, 'EEE dd MMM') }} · {{ fmtTime(m.startsAt) }}–{{ fmtTime(m.endsAt) }}</strong></div>
                    <div class="small muted row gap-1"><span class="pill-color" [style.background]="m.doctor.color || '#94a3b8'"></span>{{ m.doctor.title }} {{ m.doctor.firstName }} {{ m.doctor.lastName }}</div>
                    @if (m.reasons?.length) { <div class="row gap-1 wrap mt-1">@for (r of m.reasons; track r) { <span class="chip teal">{{ r }}</span> }</div> }
                  </div>
                  @if (canWrite) { <button type="button" class="btn sm primary" (click)="book(m)" [disabled]="busy()">Book</button> }
                </div>
              } @empty { <div class="empty">No matching free slot right now.</div> }
            }
          </div>
        }
      </div>
      @if (canWrite && (e().status === 'WAITING' || e().status === 'OFFERED')) {
        <div class="dr-foot"><button type="button" class="btn danger-outline" (click)="cancel()" [disabled]="busy()">Cancel entry</button></div>
      }
    </aside>
  `,
  styles: [`
    :host { display: contents; }
    .scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.35); z-index: 90; }
    .drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(520px, 100vw); background: var(--cf-surface); box-shadow: var(--cf-shadow-lg); z-index: 95; display: flex; flex-direction: column; animation: slide 0.18s ease-out; }
    .dr-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--cf-border); }
    .dr-head h2 { font-size: 17px; }
    .dr-body { padding: 20px; overflow-y: auto; flex: 1; }
    .dr-foot { padding: 12px 20px; border-top: 1px solid var(--cf-border); display: flex; justify-content: flex-end; }
    .match { display: flex; gap: 12px; align-items: center; padding: 10px 14px; border-left: 4px solid; border-bottom: 1px solid var(--cf-border); }
    .match:last-child { border-bottom: none; }
    .offer { border-color: #fde68a; }
    @keyframes slide { from { transform: translateX(16px); opacity: 0; } to { transform: none; opacity: 1; } }
  `],
})
export class WaitlistDrawerComponent {
  private readonly api = inject(WaitlistApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  readonly e = input.required<WaitlistEntry>({ alias: 'entry' });
  readonly closed = output<void>();
  readonly changed = output<void>();
  readonly fmtDate = fmtDate;
  readonly fmtDateTime = fmtDateTime;
  readonly fmtTime = fmtTime;
  readonly canWrite = this.auth.hasPermission('appointments:write');
  readonly matches = signal<SlotCandidate[]>([]);
  readonly matchesLoading = signal(false);
  readonly matchesError = signal<string | null>(null);
  readonly busy = signal(false);
  readonly windows = computed(() => describeWindows(parseWindows(this.e().preferredWindows)));

  ngOnInit() { if (this.e().status === 'WAITING' || this.e().status === 'OFFERED') this.loadMatches(); }
  @HostListener('document:keydown.escape') onEsc() { this.closed.emit(); }

  loadMatches() {
    this.matchesLoading.set(true); this.matchesError.set(null);
    this.api.matches(this.e().id).subscribe({
      next: (m) => { this.matches.set(m); this.matchesLoading.set(false); },
      error: (err) => { this.matchesLoading.set(false); this.matches.set([]); this.matchesError.set(errorMessage(err, 'Matches unavailable.')); },
    });
  }
  book(m: SlotCandidate) {
    this.busy.set(true);
    this.api.book(this.e().id, { startsAt: m.startsAt, doctorId: m.doctor.id }).subscribe({
      next: () => { this.busy.set(false); this.toast.success('Appointment booked from the waitlist'); this.changed.emit(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); if (err?.status === 409) this.loadMatches(); },
    });
  }
  accept() {
    this.busy.set(true);
    this.api.accept(this.e().id).subscribe({
      next: () => { this.busy.set(false); this.toast.success('Offer accepted — appointment confirmed'); this.changed.emit(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
  async decline() {
    if (!(await this.confirm.ask({ title: 'Decline offer', message: 'Release the held slot and put the patient back on the waitlist?', confirmText: 'Decline', danger: true }))) return;
    this.busy.set(true);
    this.api.decline(this.e().id).subscribe({
      next: () => { this.busy.set(false); this.toast.info('Offer declined — entry back to waiting'); this.changed.emit(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
  async cancel() {
    if (!(await this.confirm.ask({ title: 'Cancel waitlist entry', message: 'Remove this patient from the waitlist?', confirmText: 'Cancel entry', danger: true }))) return;
    this.busy.set(true);
    this.api.cancel(this.e().id).subscribe({
      next: () => { this.busy.set(false); this.toast.success('Entry cancelled'); this.changed.emit(); this.closed.emit(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
}
