import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { addDays, startOfDay } from 'date-fns';
import { ResourcesApi } from '../../core/api/resources.api';
import { AuthService } from '../../core/auth.service';
import { ToastService, errorMessage } from '../../core/toast.service';
import { Resource, ResourceBooking } from '../../core/models';
import { dayRange, fmtDate, fmtTime, isoDate, renderSlots, SlotView } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { HasPermissionDirective } from '../../core/permission.directive';
import { ResourceDialogComponent } from './resource-dialog';
import { ResourceSelectComponent } from '../../shared/resource-select';

@Component({
  selector: 'cf-resources',
  imports: [FormsModule, RouterLink, PageHeaderComponent, StatusChipComponent, HasPermissionDirective, ResourceDialogComponent, ResourceSelectComponent],
  template: `
    <div class="page">
      <cf-page-header title="Resources" subtitle="Rooms, equipment and other bookable resources">
        <label class="checkbox small"><input type="checkbox" [ngModel]="includeInactive()" (ngModelChange)="includeInactive.set($event); load()" /> Show inactive</label>
        <button *hasPermission="'resources:write'" type="button" class="btn primary" (click)="editing.set(null); dialog.set(true)">+ New resource</button>
      </cf-page-header>

      <div class="grid layout">
        <div class="col">
          <div class="card">
            <div class="card-header"><h3>Catalogue</h3>@if (loading()) { <span class="spinner"></span> }</div>
            @if (error()) { <div class="empty">{{ error() }}</div> }
            @else {
              <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>Name</th><th>Type</th><th>Notes</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    @for (r of resources(); track r.id) {
                      <tr class="clickable" [class.sel]="selected()?.id === r.id" (click)="select(r)">
                        <td><span class="row gap-1"><span class="pill-color" [style.background]="r.color || '#6b7280'"></span><strong>{{ r.name }}</strong></span></td>
                        <td><cf-chip [status]="r.type" /></td>
                        <td class="muted truncate" style="max-width: 260px">{{ r.notes || '—' }}</td>
                        <td><cf-chip [status]="r.isActive" /></td>
                        <td class="actions">
                          <button *hasPermission="'resources:write'" type="button" class="btn xs" (click)="edit(r, $event)">Edit</button>
                          <button type="button" class="btn xs ghost" (click)="select(r)">Day view</button>
                        </td>
                      </tr>
                    } @empty { <tr><td colspan="5" class="empty">No resources yet.@if (canWrite) { Create rooms or equipment to book them with appointments. }</td></tr> }
                  </tbody>
                </table>
              </div>
            }
          </div>

          @if (selected(); as r) {
            <div class="card">
              <div class="card-header">
                <h3><span class="pill-color" [style.background]="r.color || '#6b7280'"></span> {{ r.name }} — day view</h3>
                <div class="row gap-1">
                  <button type="button" class="btn sm" (click)="shiftDay(-1)">‹</button>
                  <input class="input sm" type="date" style="width: 150px" [ngModel]="day()" (ngModelChange)="day.set($event); loadBookings()" />
                  <button type="button" class="btn sm" (click)="shiftDay(1)">›</button>
                </div>
              </div>
              @if (bookingsLoading()) { <div class="loading"><span class="spinner"></span> Loading…</div> }
              @else if (bookingsError()) { <div class="empty">{{ bookingsError() }}</div> }
              @else {
                <div class="table-wrap">
                  <table class="table">
                    <thead><tr><th>Time</th><th>Patient</th><th>Doctor</th><th>Status</th><th></th></tr></thead>
                    <tbody>
                      @for (b of bookings(); track b.id) {
                        <tr [class.inactive]="!b.active">
                          <td class="nowrap mono">{{ fmtTime(b.startsAt) }}–{{ fmtTime(b.endsAt) }}</td>
                          <td>@if (b.appointment?.patient; as p) { <a [routerLink]="['/patients', p.id]">{{ p.firstName }} {{ p.lastName }}</a> } @else { <span class="muted">—</span> }</td>
                          <td>@if (b.appointment?.doctor; as d) { <span class="row gap-1"><span class="pill-color" [style.background]="d.color || '#94a3b8'"></span>{{ d.firstName }} {{ d.lastName }}</span> } @else { <span class="muted">—</span> }</td>
                          <td>@if (b.appointment?.status) { <cf-chip [status]="b.appointment!.status" /> } @else { <cf-chip [status]="b.active ? 'ACTIVE' : 'CANCELLED'" /> }</td>
                          <td class="actions"><a class="btn xs ghost" [routerLink]="['/appointments', b.appointmentId]">Open</a></td>
                        </tr>
                      } @empty { <tr><td colspan="5" class="empty">No bookings on {{ fmtDate(day()) }}.</td></tr> }
                    </tbody>
                  </table>
                </div>
              }
            </div>
          }
        </div>

        <div class="col">
          <div class="card">
            <div class="card-header"><h3>Availability check</h3></div>
            <div class="card-body">
              <p class="muted small">Pick resources, a date and a duration to see the slots when <em>all</em> of them are free.</p>
              <div class="field"><label>Resources</label><cf-resource-select [selected]="checkIds()" (selectedChange)="checkIds.set($event)" /></div>
              <div class="row gap-1">
                <div class="field flex-1"><label>Date</label><input class="input sm" type="date" [ngModel]="checkDate()" (ngModelChange)="checkDate.set($event)" /></div>
                <div class="field"><label>Duration</label>
                  <select class="input sm" [ngModel]="checkDuration()" (ngModelChange)="checkDuration.set(+$event)">
                    @for (m of [15, 20, 30, 45, 60, 90]; track m) { <option [ngValue]="m">{{ m }} min</option> }
                  </select>
                </div>
              </div>
              <button type="button" class="btn block" (click)="check()" [disabled]="!checkIds().length || !checkDate() || checking()">{{ checking() ? 'Checking…' : 'Find common free slots' }}</button>
              @if (checkError()) { <div class="inline-alert info mt-2">{{ checkError() }}</div> }
              @else if (checked() && !freeSlots().length) { <div class="muted small mt-2">No common free slot on that day.</div> }
              @else if (freeSlots().length) {
                <div class="slots mt-2">@for (s of freeSlots(); track s.startsAt) { <span class="chip green">{{ s.label }}</span> }</div>
                <a *hasPermission="'appointments:write'" class="btn sm primary mt-2" routerLink="/calendar" [queryParams]="{ find: 1 }">Book via Find a slot</a>
              }
            </div>
          </div>
        </div>
      </div>
    </div>

    @if (dialog()) { <cf-resource-dialog [resource]="editing()" (closed)="dialog.set(false)" (saved)="onSaved()" /> }
  `,
  styles: [`
    .layout { grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); align-items: start; }
    @media (max-width: 1000px) { .layout { grid-template-columns: 1fr; } }
    tr.sel { background: var(--cf-primary-soft) !important; }
    tr.inactive { opacity: 0.55; }
    .slots { display: flex; flex-wrap: wrap; gap: 6px; }
  `],
})
export class ResourcesPage {
  private readonly api = inject(ResourcesApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly fmtTime = fmtTime;
  readonly fmtDate = fmtDate;
  readonly canWrite = this.auth.hasPermission('resources:write');
  readonly resources = signal<Resource[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly includeInactive = signal(false);
  readonly dialog = signal(false);
  readonly editing = signal<Resource | null>(null);
  readonly selected = signal<Resource | null>(null);
  readonly day = signal(isoDate(new Date()));
  readonly bookings = signal<ResourceBooking[]>([]);
  readonly bookingsLoading = signal(false);
  readonly bookingsError = signal<string | null>(null);
  // availability widget
  readonly checkIds = signal<string[]>([]);
  readonly checkDate = signal(isoDate(new Date()));
  readonly checkDuration = signal(30);
  readonly checking = signal(false);
  readonly checked = signal(false);
  readonly checkError = signal<string | null>(null);
  readonly freeSlots = signal<SlotView[]>([]);
  readonly activeCount = computed(() => this.resources().filter((r) => r.isActive).length);

  constructor() { this.load(); }

  load() {
    this.loading.set(true); this.error.set(null);
    this.api.list(this.includeInactive()).subscribe({
      next: (r) => { this.resources.set(r); this.loading.set(false); },
      error: (err) => { this.loading.set(false); this.resources.set([]); this.error.set(errorMessage(err, 'Resources are not available yet.')); },
    });
  }
  edit(r: Resource, e: Event) { e.stopPropagation(); this.editing.set(r); this.dialog.set(true); }
  onSaved() { this.dialog.set(false); this.load(); }
  select(r: Resource) { this.selected.set(r); this.loadBookings(); }
  shiftDay(n: number) { this.day.set(isoDate(addDays(startOfDay(new Date(`${this.day()}T00:00:00`)), n))); this.loadBookings(); }
  loadBookings() {
    const r = this.selected(); if (!r) return;
    this.bookingsLoading.set(true); this.bookingsError.set(null);
    const { from, to } = dayRange(new Date(`${this.day()}T00:00:00`));
    this.api.bookings(r.id, { from, to }).subscribe({
      next: (b) => { this.bookings.set([...b].sort((x, y) => x.startsAt.localeCompare(y.startsAt))); this.bookingsLoading.set(false); },
      error: (err) => { this.bookingsLoading.set(false); this.bookings.set([]); this.bookingsError.set(errorMessage(err, 'Bookings unavailable.')); },
    });
  }
  check() {
    this.checking.set(true); this.checkError.set(null); this.checked.set(false);
    this.api.availability({ resourceIds: this.checkIds(), date: this.checkDate(), durationMinutes: this.checkDuration() }).subscribe({
      next: (r) => { this.freeSlots.set(renderSlots(r?.slots ?? []).filter((s) => !s.disabled)); this.checking.set(false); this.checked.set(true); },
      error: (err) => { this.checking.set(false); this.freeSlots.set([]); this.checkError.set(errorMessage(err, 'Availability check unavailable.')); this.toast.fromError(err); },
    });
  }
}
