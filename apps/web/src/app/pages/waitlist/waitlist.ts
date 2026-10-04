import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { WaitlistApi } from '../../core/api/waitlist.api';
import { DoctorsApi } from '../../core/api/doctors.api';
import { AuthService } from '../../core/auth.service';
import { ToastService, errorMessage } from '../../core/toast.service';
import { Doctor, WaitlistEntry, WaitlistPriority, WaitlistStatus } from '../../core/models';
import { fmtDate } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { CountdownComponent } from '../../shared/countdown';
import { HasPermissionDirective } from '../../core/permission.directive';
import { WaitlistDialogComponent } from './waitlist-dialog';
import { WaitlistDrawerComponent } from './waitlist-drawer';

const PRIORITY_RANK: Record<WaitlistPriority, number> = { URGENT: 0, SOON: 1, ROUTINE: 2 };
const COLUMNS: { status: WaitlistStatus; label: string; hint: string }[] = [
  { status: 'WAITING', label: 'Waiting', hint: 'Backfilled automatically when a slot frees up' },
  { status: 'OFFERED', label: 'Offered', hint: 'Slot held for the patient — accept or decline' },
  { status: 'BOOKED', label: 'Booked', hint: 'Recently booked from the waitlist' },
];

@Component({
  selector: 'cf-waitlist',
  imports: [FormsModule, PageHeaderComponent, StatusChipComponent, CountdownComponent, HasPermissionDirective, WaitlistDialogComponent, WaitlistDrawerComponent],
  template: `
    <div class="page">
      <cf-page-header title="Waitlist" subtitle="Patients waiting for an earlier or any slot">
        <select class="input sm" style="width: 200px" [ngModel]="doctorId()" (ngModelChange)="doctorId.set($event); load()">
          <option value="">All doctors</option>
          @for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.title }} {{ d.firstName }} {{ d.lastName }}</option> }
        </select>
        <div class="seg">
          <button type="button" [class.on]="archive() === ''" (click)="archive.set(''); load()">Active</button>
          <button type="button" [class.on]="archive() === 'EXPIRED'" (click)="archive.set('EXPIRED'); load()">Expired</button>
          <button type="button" [class.on]="archive() === 'CANCELLED'" (click)="archive.set('CANCELLED'); load()">Cancelled</button>
        </div>
        <button type="button" class="btn sm" (click)="load()" [disabled]="loading()">Refresh</button>
        <button *hasPermission="'appointments:write'" type="button" class="btn primary" (click)="dialog.set(true)">+ Add entry</button>
      </cf-page-header>

      @if (error()) { <div class="inline-alert info">{{ error() }}</div> }

      @if (archive()) {
        <div class="card">
          <div class="card-header"><h3>{{ archive() === 'EXPIRED' ? 'Expired' : 'Cancelled' }} entries</h3>@if (loading()) { <span class="spinner"></span> }</div>
          <div class="list" style="padding: 0 20px">
            @for (e of entries(); track e.id) {
              <button type="button" class="entry list-item" (click)="open(e)">
                <cf-chip [status]="e.priority" />
                <span class="flex-1"><strong>{{ e.patient?.firstName }} {{ e.patient?.lastName }}</strong> <span class="muted small">· {{ target(e) }}</span></span>
                <span class="subtle">{{ fmtDate(e.updatedAt) }}</span>
              </button>
            } @empty { <div class="empty">Nothing here.</div> }
          </div>
        </div>
      } @else {
        <div class="board">
          @for (c of columns; track c.status) {
            <div class="column" [class.offered]="c.status === 'OFFERED'">
              <div class="col-head">
                <h3>{{ c.label }} <span class="count">{{ byStatus()[c.status].length }}</span></h3>
                <div class="subtle">{{ c.hint }}</div>
              </div>
              @if (loading() && !entries().length) { <div class="loading"><span class="spinner"></span></div> }
              @for (e of byStatus()[c.status]; track e.id) {
                <button type="button" class="entry card" (click)="open(e)">
                  <div class="row between gap-1">
                    <strong class="truncate">{{ e.patient?.firstName }} {{ e.patient?.lastName }}</strong>
                    <cf-chip [status]="e.priority" />
                  </div>
                  <div class="small muted truncate">{{ target(e) }} · {{ e.durationMinutes }} min</div>
                  <div class="row between gap-1 mt-1">
                    <span class="subtle">from {{ fmtDate(e.earliestAt) }}@if (e.latestAt) { → {{ fmtDate(e.latestAt) }} }</span>
                    @if (e.status === 'OFFERED') { <cf-countdown [until]="e.offerExpiresAt" /> }
                    @else if (e.offerCount) { <span class="subtle">{{ e.offerCount }} offer(s)</span> }
                  </div>
                </button>
              } @empty { @if (!loading()) { <div class="empty small">{{ c.status === 'WAITING' ? 'No one is waiting.' : c.status === 'OFFERED' ? 'No open offers.' : 'No recent bookings.' }}</div> } }
            </div>
          }
        </div>
      }
    </div>

    @if (dialog()) { <cf-waitlist-dialog [doctors]="doctors()" (closed)="dialog.set(false)" (saved)="onSaved($event)" /> }
    @if (selected(); as e) { <cf-waitlist-drawer [entry]="e" (closed)="selected.set(null)" (changed)="onChanged()" /> }
  `,
  styles: [`
    .seg { display: inline-flex; border: 1px solid var(--cf-border-strong); border-radius: 6px; overflow: hidden; }
    .seg button { border: none; background: #fff; padding: 0 12px; height: 30px; font: inherit; font-size: 13px; cursor: pointer; }
    .seg button.on { background: var(--cf-primary); color: #fff; }
    .board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: start; }
    .column { background: var(--cf-surface-2); border: 1px solid var(--cf-border); border-radius: var(--cf-radius); padding: 12px; display: flex; flex-direction: column; gap: 10px; min-height: 240px; }
    .column.offered { background: #fffbeb; border-color: #fde68a; }
    .col-head h3 { display: flex; align-items: center; gap: 8px; }
    .count { font-size: 11.5px; font-weight: 600; background: var(--cf-surface); border: 1px solid var(--cf-border); border-radius: 999px; padding: 0 8px; color: var(--cf-text-2); }
    .entry { text-align: left; font: inherit; cursor: pointer; }
    .entry.card { padding: 10px 12px; border-left: 3px solid var(--cf-border-strong); }
    .entry.card:hover { border-color: var(--cf-primary); }
    .entry.list-item { width: 100%; background: none; border: none; border-bottom: 1px solid var(--cf-border); }
    @media (max-width: 900px) { .board { grid-template-columns: 1fr; } }
  `],
})
export class WaitlistPage {
  private readonly api = inject(WaitlistApi);
  private readonly doctorsApi = inject(DoctorsApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly fmtDate = fmtDate;
  readonly columns = COLUMNS;
  readonly doctors = signal<Doctor[]>([]);
  readonly doctorId = signal('');
  readonly archive = signal<'' | 'EXPIRED' | 'CANCELLED'>('');
  readonly entries = signal<WaitlistEntry[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly dialog = signal(false);
  readonly selected = signal<WaitlistEntry | null>(null);
  readonly byStatus = computed(() => {
    const out: Record<WaitlistStatus, WaitlistEntry[]> = { WAITING: [], OFFERED: [], BOOKED: [], EXPIRED: [], CANCELLED: [] };
    for (const e of this.entries()) (out[e.status] ?? out.WAITING).push(e);
    for (const k of Object.keys(out) as WaitlistStatus[]) out[k].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt));
    return out;
  });

  constructor() {
    this.doctorsApi.list().subscribe({ next: (d) => this.doctors.set(d), error: () => undefined });
    this.load();
  }

  target(e: WaitlistEntry) {
    if (e.doctor) return `${e.doctor.title ?? ''} ${e.doctor.firstName} ${e.doctor.lastName}`.trim();
    if (e.doctorId) { const d = this.doctors().find((x) => x.id === e.doctorId); if (d) return `${d.title ?? ''} ${d.firstName} ${d.lastName}`.trim(); }
    return `Any ${e.specialty || 'doctor'}`;
  }

  load() {
    this.loading.set(true); this.error.set(null);
    const q = { doctorId: this.doctorId() || undefined, status: (this.archive() || undefined) as WaitlistStatus | undefined };
    this.api.list(q).subscribe({
      next: (r) => {
        const items = this.archive() ? r.items : r.items.filter((e) => e.status === 'WAITING' || e.status === 'OFFERED' || e.status === 'BOOKED');
        this.entries.set(items.map((e) => ({ ...e, doctor: e.doctor ?? (e.doctorId ? this.doctors().find((d) => d.id === e.doctorId) ?? null : null) })));
        this.loading.set(false);
        const sel = this.selected(); if (sel) this.selected.set(items.find((e) => e.id === sel.id) ?? null);
      },
      error: (err) => { this.loading.set(false); this.entries.set([]); this.error.set(errorMessage(err, 'Waitlist is not available yet.')); },
    });
  }
  open(e: WaitlistEntry) { this.selected.set(e); }
  onSaved(e: WaitlistEntry) { this.dialog.set(false); this.load(); this.selected.set(e); }
  onChanged() { this.load(); }
}
