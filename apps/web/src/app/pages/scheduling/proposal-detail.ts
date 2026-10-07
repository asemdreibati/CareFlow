import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { SchedulingApi } from '../../core/api/scheduling.api';
import { DoctorsApi } from '../../core/api/doctors.api';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { ConfirmService } from '../../shared/confirm.service';
import { Doctor, ProposalItem, RescheduleProposal } from '../../core/models';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';

@Component({
  selector: 'cf-proposal-detail',
  imports: [RouterLink, TranslatePipe, PageHeaderComponent, StatusChipComponent],
  template: `
    <div class="page">
      @if (proposal(); as p) {
        <cf-page-header [title]="'proposals.detailTitle' | translate" [subtitle]="p.cause">
          <cf-chip [status]="p.status" group="status" />
          <a class="btn" routerLink="/scheduling/proposals">{{ 'proposals.all' | translate }}</a>
          @if (p.status === 'PENDING') {
            <button type="button" class="btn danger-outline" (click)="dismiss()" [disabled]="busy()">{{ 'proposals.dismiss' | translate }}</button>
            <button type="button" class="btn" (click)="apply(selectedIds())" [disabled]="busy() || !selectedIds().length">{{ 'proposals.applySelected' | translate: { n: selectedIds().length } }}</button>
            <button type="button" class="btn primary" (click)="apply()" [disabled]="busy() || !pendingItems().length">{{ (busy() ? 'proposals.applying' : 'proposals.applyAll') | translate }}</button>
          }
        </cf-page-header>

        <div class="grid grid-4 mb-2">
          <div class="card stat"><span class="label">{{ 'appointments.plural' | translate }}</span><span class="value">{{ p.items.length }}</span><span class="hint">{{ 'proposals.inThisProposal' | translate }}</span></div>
          <div class="card stat"><span class="label">{{ 'proposals.doctorChanges' | translate }}</span><span class="value">{{ doctorChanges() }}</span><span class="hint">{{ 'proposals.movedToOther' | translate }}</span></div>
          <div class="card stat"><span class="label">{{ 'proposals.displacement' | translate }}</span><span class="value">{{ p.totalDisplacementMinutes }}<span class="muted" style="font-size: 14px"> {{ 'common.units.min' | translate }}</span></span><span class="hint">{{ 'proposals.avgDisplacement' | translate: { min: lang.formatMinutes(avgDisplacement()) } }}</span></div>
          <div class="card stat"><span class="label">{{ 'proposals.unresolved' | translate }}</span><span class="value" [class.danger-text]="p.unresolvedAppointmentIds.length">{{ p.unresolvedAppointmentIds.length }}</span><span class="hint">{{ 'proposals.noSlotFound' | translate }}</span></div>
        </div>

        @if (p.unresolvedAppointmentIds.length) {
          <div class="inline-alert error">
            <strong>{{ 'proposals.couldNotPlace' | translate: { n: p.unresolvedAppointmentIds.length } }}</strong> {{ 'proposals.couldNotPlaceHint' | translate }}
            <div class="row gap-1 wrap mt-1">
              @for (u of unresolved(); track u.id) {
                <a class="btn xs" [routerLink]="['/appointments', u.id]">{{ u.label }}</a>
              }
            </div>
          </div>
        }

        <div class="card">
          <div class="card-header"><h3>{{ 'proposals.proposedMoves' | translate }}</h3>
            @if (p.status === 'PENDING' && pendingItems().length) {
              <label class="checkbox small"><input type="checkbox" [checked]="allSelected()" (change)="toggleAll()" /> {{ 'common.selectAll' | translate }}</label>
            }
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr>@if (p.status === 'PENDING') { <th style="width: 32px"></th> }<th>{{ 'common.patient' | translate }}</th><th>{{ 'common.from' | translate }}</th><th></th><th>{{ 'common.to' | translate }}</th><th>{{ 'common.doctor' | translate }}</th><th class="num">{{ 'proposals.displacement' | translate }}</th><th>{{ 'proposals.result' | translate }}</th></tr></thead>
              <tbody>
                @for (it of p.items; track it.appointmentId) {
                  <tr [class.applied]="it.applied">
                    @if (p.status === 'PENDING') { <td><input type="checkbox" [checked]="selected().has(it.appointmentId)" (change)="toggle(it.appointmentId)" [disabled]="it.applied || !it.to" /></td> }
                    <td><a [routerLink]="['/appointments', it.appointmentId]">{{ it.patientName || ('appointments.title' | translate) }}</a></td>
                    <td class="nowrap">{{ lang.formatDateTime(it.from) }}</td>
                    <td class="muted"><span class="mirror">→</span></td>
                    <td class="nowrap">@if (it.to) { <strong>{{ lang.formatDateTime(it.to) }}</strong>@if (sameDay(it)) { <span class="subtle"> {{ 'proposals.sameDay' | translate }}</span> } } @else { <span class="danger-text">{{ 'proposals.noSlotFound' | translate }}</span> }</td>
                    <td>
                      @if (!it.to) { <span class="muted">—</span> }
                      @else if (it.toDoctorId && it.fromDoctorId !== it.toDoctorId) { <span class="chip purple" [title]="doctorName(it.fromDoctorId) + ' → ' + doctorName(it.toDoctorId, it.toDoctorName)"><span class="mirror">→</span> {{ doctorName(it.toDoctorId, it.toDoctorName) }}</span> }
                      @else { <span class="muted small">{{ doctorName(it.fromDoctorId) }}</span> }
                    </td>
                    <td class="num" [class.danger-text]="it.displacementMinutes > 1440">{{ it.to ? displacement(it.displacementMinutes) : '—' }}</td>
                    <td>
                      @if (it.error) { <span class="chip red" [title]="it.error">{{ 'enums.status.FAILED' | translate }}</span> <span class="subtle">{{ it.error }}</span> }
                      @else if (it.applied) { <span class="chip green">{{ 'enums.status.APPLIED' | translate }}</span> }
                      @else if (!it.to) { <span class="chip red">{{ 'proposals.unresolvedLower' | translate }}</span> }
                      @else if (p.status === 'DISMISSED') { <span class="chip gray">{{ 'enums.status.DISMISSED' | translate }}</span> }
                      @else { <span class="chip blue">{{ 'enums.status.PENDING' | translate }}</span> }
                    </td>
                  </tr>
                } @empty { <tr><td colspan="8" class="empty">{{ 'proposals.noMoves' | translate }}</td></tr> }
              </tbody>
            </table>
          </div>
          @if (p.appliedAt) { <div class="card-footer muted small">{{ 'proposals.appliedAt' | translate: { date: lang.formatDateTime(p.appliedAt) } }}</div> }
        </div>
      } @else if (error()) { <div class="inline-alert error">{{ error() }}</div> }
      @else { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
    </div>
  `,
  styles: [`tr.applied td { opacity: 0.7; }`],
})
export class ProposalDetailPage {
  private readonly api = inject(SchedulingApi);
  private readonly doctorsApi = inject(DoctorsApi);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  readonly lang = inject(LanguageService);
  readonly id = input.required<string>();
  readonly proposal = signal<RescheduleProposal | null>(null);
  readonly doctors = signal<Doctor[]>([]);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly selected = signal(new Set<string>());
  readonly pendingItems = computed(() => (this.proposal()?.items ?? []).filter((i) => !i.applied && !!i.to));
  readonly selectedIds = computed(() => [...this.selected()]);
  readonly allSelected = computed(() => this.pendingItems().length > 0 && this.pendingItems().every((i) => this.selected().has(i.appointmentId)));
  readonly doctorChanges = computed(() => (this.proposal()?.items ?? []).filter((i) => !!i.to && !!i.toDoctorId && i.fromDoctorId !== i.toDoctorId).length);
  readonly avgDisplacement = computed(() => { const p = this.proposal(); const n = (p?.items ?? []).filter((i) => !!i.to).length; return p && n ? Math.round(p.totalDisplacementMinutes / n) : 0; });
  readonly unresolved = computed(() => {
    const p = this.proposal(); if (!p) return [];
    const fallback = this.lang.t('appointments.title');
    return p.unresolvedAppointmentIds.map((id) => {
      const it = p.items.find((x) => x.appointmentId === id);
      const a = p.unresolvedAppointments?.find((x) => x.id === id);
      if (it) return { id, label: `${it.patientName || fallback} · ${this.lang.formatDayMonthTime(it.from)}` };
      return { id, label: a ? `${a.patient?.firstName ?? ''} ${a.patient?.lastName ?? ''} · ${this.lang.formatDayMonthTime(a.startsAt)}`.trim() : `${fallback} ${id.slice(0, 8)}…` };
    });
  });

  ngOnInit() {
    this.doctorsApi.list().subscribe({ next: (d) => this.doctors.set(d), error: () => undefined });
    this.load();
  }
  load() {
    this.api.proposal(this.id()).subscribe({
      next: (p) => { this.proposal.set({ ...p, items: p.items ?? [], unresolvedAppointmentIds: p.unresolvedAppointmentIds ?? [] }); this.selected.set(new Set()); },
      error: (err) => this.error.set(this.lang.errorMessage(err, this.lang.t('proposals.loadFailed'))),
    });
  }
  doctorName(id: string | null, fallback?: string | null) {
    const d = id ? this.doctors().find((x) => x.id === id) : null;
    return d ? `${d.title ?? ''} ${d.firstName} ${d.lastName}`.trim() : fallback || '…';
  }
  sameDay(it: ProposalItem) { return !!it.to && this.lang.formatDate(it.from) === this.lang.formatDate(it.to); }
  displacement(min: number) {
    const u = (k: string) => this.lang.t(`common.units.${k}`);
    return min >= 1440 ? `${(min / 1440).toFixed(1)} ${u('d')}` : min >= 60 ? `${Math.floor(min / 60)}${u('h')} ${String(min % 60).padStart(2, '0')}${u('m')}` : this.lang.formatMinutes(min);
  }
  toggle(id: string) { this.selected.update((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }
  toggleAll() { this.selected.set(this.allSelected() ? new Set() : new Set(this.pendingItems().map((i) => i.appointmentId))); }

  async apply(ids?: string[]) {
    const n = ids?.length ?? this.pendingItems().length;
    if (!(await this.confirm.ask({ title: this.lang.t('proposals.applyTitle'), message: this.lang.t('proposals.applyConfirm', { n }), confirmText: this.lang.t('proposals.apply') }))) return;
    this.busy.set(true);
    this.api.applyProposal(this.id(), ids).subscribe({
      next: (p) => {
        this.busy.set(false);
        const failed = (p?.items ?? []).filter((i) => i.error).length;
        if (failed) this.toast.warn(this.lang.t('proposals.appliedWithFailures', { n: failed })); else this.toast.success(this.lang.t('proposals.rescheduled'));
        this.load();
      },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
  async dismiss() {
    if (!(await this.confirm.ask({ title: this.lang.t('proposals.dismissTitle'), message: this.lang.t('proposals.dismissConfirm'), confirmText: this.lang.t('proposals.dismiss'), danger: true }))) return;
    this.busy.set(true);
    this.api.dismissProposal(this.id()).subscribe({
      next: () => { this.busy.set(false); this.toast.info(this.lang.t('proposals.dismissed')); this.load(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
}
