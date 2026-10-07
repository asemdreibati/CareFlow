import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ResourcesApi } from '../../core/api/resources.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { Resource, ResourceBooking } from '../../core/models';
import { dayRange, isoDate, renderSlots, SlotView } from '../../core/date-utils';
import { addDaysToKey } from '../../core/timezone';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { HasPermissionDirective } from '../../core/permission.directive';
import { ResourceDialogComponent } from './resource-dialog';
import { ResourceSelectComponent } from '../../shared/resource-select';

@Component({
  selector: 'cf-resources',
  imports: [FormsModule, RouterLink, TranslatePipe, PageHeaderComponent, StatusChipComponent, HasPermissionDirective, ResourceDialogComponent, ResourceSelectComponent],
  template: `
    <div class="page">
      <cf-page-header [title]="'resources.title' | translate" [subtitle]="'resources.subtitle' | translate">
        <label class="checkbox small"><input type="checkbox" [ngModel]="includeInactive()" (ngModelChange)="includeInactive.set($event); load()" /> {{ 'common.showInactive' | translate }}</label>
        <button *hasPermission="'resources:write'" type="button" class="btn primary" (click)="editing.set(null); dialog.set(true)">+ {{ 'resources.new' | translate }}</button>
      </cf-page-header>

      <div class="grid layout">
        <div class="col">
          <div class="card">
            <div class="card-header"><h3>{{ 'resources.catalogue' | translate }}</h3>@if (loading()) { <span class="spinner"></span> }</div>
            @if (error()) { <div class="empty">{{ error() }}</div> }
            @else {
              <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>{{ 'common.name' | translate }}</th><th>{{ 'common.type' | translate }}</th><th>{{ 'common.notes' | translate }}</th><th>{{ 'common.status' | translate }}</th><th></th></tr></thead>
                  <tbody>
                    @for (r of resources(); track r.id) {
                      <tr class="clickable" [class.sel]="selected()?.id === r.id" (click)="select(r)">
                        <td><span class="row gap-1"><span class="pill-color" [style.background]="r.color || '#6b7280'"></span><strong>{{ r.name }}</strong></span></td>
                        <td><cf-chip [status]="r.type" group="resourceType" /></td>
                        <td class="muted truncate" style="max-width: 260px">{{ r.notes || '—' }}</td>
                        <td><cf-chip [status]="r.isActive" /></td>
                        <td class="actions">
                          <button *hasPermission="'resources:write'" type="button" class="btn xs" (click)="edit(r, $event)">{{ 'common.edit' | translate }}</button>
                          <button type="button" class="btn xs ghost" (click)="select(r)">{{ 'resources.dayView' | translate }}</button>
                        </td>
                      </tr>
                    } @empty { <tr><td colspan="5" class="empty">{{ 'resources.none' | translate }}@if (canWrite) { {{ 'resources.noneHint' | translate }} }</td></tr> }
                  </tbody>
                </table>
              </div>
            }
          </div>

          @if (selected(); as r) {
            <div class="card">
              <div class="card-header">
                <h3><span class="pill-color" [style.background]="r.color || '#6b7280'"></span> {{ r.name }} — {{ 'resources.dayView' | translate }}</h3>
                <div class="row gap-1">
                  <button type="button" class="btn sm" (click)="shiftDay(-1)" [attr.aria-label]="'common.previous' | translate">‹</button>
                  <input class="input sm" type="date" style="width: 150px" [ngModel]="day()" (ngModelChange)="day.set($event); loadBookings()" />
                  <button type="button" class="btn sm" (click)="shiftDay(1)" [attr.aria-label]="'common.next' | translate">›</button>
                </div>
              </div>
              @if (bookingsLoading()) { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
              @else if (bookingsError()) { <div class="empty">{{ bookingsError() }}</div> }
              @else {
                <div class="table-wrap">
                  <table class="table">
                    <thead><tr><th>{{ 'common.time' | translate }}</th><th>{{ 'common.patient' | translate }}</th><th>{{ 'common.doctor' | translate }}</th><th>{{ 'common.status' | translate }}</th><th></th></tr></thead>
                    <tbody>
                      @for (b of bookings(); track b.id) {
                        <tr [class.inactive]="!b.active">
                          <td class="nowrap mono">{{ lang.formatTimeRange(b.startsAt, b.endsAt) }}</td>
                          <td>@if (b.appointment?.patient; as p) { <a [routerLink]="['/patients', p.id]">{{ p.firstName }} {{ p.lastName }}</a> } @else { <span class="muted">—</span> }</td>
                          <td>@if (b.appointment?.doctor; as d) { <span class="row gap-1"><span class="pill-color" [style.background]="d.color || '#94a3b8'"></span>{{ d.firstName }} {{ d.lastName }}</span> } @else { <span class="muted">—</span> }</td>
                          <td>@if (b.appointment?.status) { <cf-chip [status]="b.appointment!.status" group="status" /> } @else { <cf-chip [status]="b.active ? 'ACTIVE' : 'CANCELLED'" group="status" /> }</td>
                          <td class="actions"><a class="btn xs ghost" [routerLink]="['/appointments', b.appointmentId]">{{ 'common.open' | translate }}</a></td>
                        </tr>
                      } @empty { <tr><td colspan="5" class="empty">{{ 'resources.noBookings' | translate: { date: lang.formatDate(day()) } }}</td></tr> }
                    </tbody>
                  </table>
                </div>
              }
            </div>
          }
        </div>

        <div class="col">
          <div class="card">
            <div class="card-header"><h3>{{ 'resources.availabilityCheck' | translate }}</h3></div>
            <div class="card-body">
              <p class="muted small">{{ 'resources.availabilityHint' | translate }}</p>
              <div class="field"><label>{{ 'nav.resources' | translate }}</label><cf-resource-select [selected]="checkIds()" (selectedChange)="checkIds.set($event)" /></div>
              <div class="row gap-1">
                <div class="field flex-1"><label>{{ 'common.date' | translate }}</label><input class="input sm" type="date" [ngModel]="checkDate()" (ngModelChange)="checkDate.set($event)" /></div>
                <div class="field"><label>{{ 'common.duration' | translate }}</label>
                  <select class="input sm" [ngModel]="checkDuration()" (ngModelChange)="checkDuration.set(+$event)">
                    @for (m of [15, 20, 30, 45, 60, 90]; track m) { <option [ngValue]="m">{{ lang.formatMinutes(m) }}</option> }
                  </select>
                </div>
              </div>
              <button type="button" class="btn block" (click)="check()" [disabled]="!checkIds().length || !checkDate() || checking()">{{ (checking() ? 'resources.checking' : 'resources.findCommon') | translate }}</button>
              @if (checkError()) { <div class="inline-alert info mt-2">{{ checkError() }}</div> }
              @else if (checked() && !freeSlots().length) { <div class="muted small mt-2">{{ 'resources.noCommonSlot' | translate }}</div> }
              @else if (freeSlots().length) {
                <div class="slots mt-2">@for (s of freeSlots(); track s.startsAt) { <span class="chip green">{{ s.label }}</span> }</div>
                <a *hasPermission="'appointments:write'" class="btn sm primary mt-2" routerLink="/calendar" [queryParams]="{ find: 1 }">{{ 'resources.bookViaFinder' | translate }}</a>
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
  readonly lang = inject(LanguageService);
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
      error: (err) => { this.loading.set(false); this.resources.set([]); this.error.set(this.lang.errorMessage(err, this.lang.t('resources.unavailableShort'))); },
    });
  }
  edit(r: Resource, e: Event) { e.stopPropagation(); this.editing.set(r); this.dialog.set(true); }
  onSaved() { this.dialog.set(false); this.load(); }
  select(r: Resource) { this.selected.set(r); this.loadBookings(); }
  shiftDay(n: number) { this.day.set(addDaysToKey(this.day(), n)); this.loadBookings(); }
  loadBookings() {
    const r = this.selected(); if (!r) return;
    this.bookingsLoading.set(true); this.bookingsError.set(null);
    const { from, to } = dayRange(this.day());
    this.api.bookings(r.id, { from, to }).subscribe({
      next: (b) => { this.bookings.set([...b].sort((x, y) => x.startsAt.localeCompare(y.startsAt))); this.bookingsLoading.set(false); },
      error: (err) => { this.bookingsLoading.set(false); this.bookings.set([]); this.bookingsError.set(this.lang.errorMessage(err, this.lang.t('resources.bookingsUnavailable'))); },
    });
  }
  check() {
    this.checking.set(true); this.checkError.set(null); this.checked.set(false);
    this.api.availability({ resourceIds: this.checkIds(), date: this.checkDate(), durationMinutes: this.checkDuration() }).subscribe({
      next: (r) => { this.freeSlots.set(renderSlots(r?.slots ?? []).filter((s) => !s.disabled)); this.checking.set(false); this.checked.set(true); },
      error: (err) => { this.checking.set(false); this.freeSlots.set([]); this.checkError.set(this.lang.errorMessage(err, this.lang.t('resources.checkUnavailable'))); this.toast.fromError(err); },
    });
  }
}
