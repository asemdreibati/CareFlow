import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SchedulingApi } from '../../core/api/scheduling.api';
import { DoctorsApi } from '../../core/api/doctors.api';
import { ToastService, errorMessage } from '../../core/toast.service';
import { ConfirmService } from '../../shared/confirm.service';
import { Doctor, ProposalItem, RescheduleProposal } from '../../core/models';
import { fmtDate, fmtDateTime, fmtTime } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';

@Component({
  selector: 'cf-proposal-detail',
  imports: [RouterLink, PageHeaderComponent, StatusChipComponent],
  template: `
    <div class="page">
      @if (proposal(); as p) {
        <cf-page-header title="Reschedule proposal" [subtitle]="p.cause">
          <cf-chip [status]="p.status" />
          <a class="btn" routerLink="/scheduling/proposals">All proposals</a>
          @if (p.status === 'PENDING') {
            <button type="button" class="btn danger-outline" (click)="dismiss()" [disabled]="busy()">Dismiss</button>
            <button type="button" class="btn" (click)="apply(selectedIds())" [disabled]="busy() || !selectedIds().length">Apply selected ({{ selectedIds().length }})</button>
            <button type="button" class="btn primary" (click)="apply()" [disabled]="busy() || !pendingItems().length">{{ busy() ? 'Applying…' : 'Apply all' }}</button>
          }
        </cf-page-header>

        <div class="grid grid-4 mb-2">
          <div class="card stat"><span class="label">Appointments</span><span class="value">{{ p.items.length }}</span><span class="hint">in this proposal</span></div>
          <div class="card stat"><span class="label">Doctor changes</span><span class="value">{{ doctorChanges() }}</span><span class="hint">moved to another doctor</span></div>
          <div class="card stat"><span class="label">Displacement</span><span class="value">{{ p.totalDisplacementMinutes }}<span class="muted" style="font-size: 14px"> min</span></span><span class="hint">total · avg {{ avgDisplacement() }} min</span></div>
          <div class="card stat"><span class="label">Unresolved</span><span class="value" [class.danger-text]="p.unresolvedAppointmentIds.length">{{ p.unresolvedAppointmentIds.length }}</span><span class="hint">no free slot found</span></div>
        </div>

        @if (p.unresolvedAppointmentIds.length) {
          <div class="inline-alert error">
            <strong>{{ p.unresolvedAppointmentIds.length }} appointment{{ p.unresolvedAppointmentIds.length === 1 ? '' : 's' }} could not be placed</strong> within the search window. They stay on the doctor's calendar during the time off — reschedule them manually or add them to the waitlist.
            <div class="row gap-1 wrap mt-1">
              @for (u of unresolved(); track u.id) {
                <a class="btn xs" [routerLink]="['/appointments', u.id]">{{ u.label }}</a>
              }
            </div>
          </div>
        }

        <div class="card">
          <div class="card-header"><h3>Proposed moves</h3>
            @if (p.status === 'PENDING' && pendingItems().length) {
              <label class="checkbox small"><input type="checkbox" [checked]="allSelected()" (change)="toggleAll()" /> Select all</label>
            }
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr>@if (p.status === 'PENDING') { <th style="width: 32px"></th> }<th>Patient</th><th>From</th><th></th><th>To</th><th>Doctor</th><th class="num">Displacement</th><th>Result</th></tr></thead>
              <tbody>
                @for (it of p.items; track it.appointmentId) {
                  <tr [class.applied]="it.applied">
                    @if (p.status === 'PENDING') { <td><input type="checkbox" [checked]="selected().has(it.appointmentId)" (change)="toggle(it.appointmentId)" [disabled]="it.applied || !it.to" /></td> }
                    <td><a [routerLink]="['/appointments', it.appointmentId]">{{ it.patientName || 'Appointment' }}</a></td>
                    <td class="nowrap">{{ fmtDateTime(it.from) }}</td>
                    <td class="muted">→</td>
                    <td class="nowrap">@if (it.to) { <strong>{{ fmtDateTime(it.to) }}</strong>@if (sameDay(it)) { <span class="subtle"> same day</span> } } @else { <span class="danger-text">no slot found</span> }</td>
                    <td>
                      @if (!it.to) { <span class="muted">—</span> }
                      @else if (it.toDoctorId && it.fromDoctorId !== it.toDoctorId) { <span class="chip purple" [title]="doctorName(it.fromDoctorId) + ' → ' + doctorName(it.toDoctorId, it.toDoctorName)">→ {{ doctorName(it.toDoctorId, it.toDoctorName) }}</span> }
                      @else { <span class="muted small">{{ doctorName(it.fromDoctorId) }}</span> }
                    </td>
                    <td class="num" [class.danger-text]="it.displacementMinutes > 1440">{{ it.to ? displacement(it.displacementMinutes) : '—' }}</td>
                    <td>
                      @if (it.error) { <span class="chip red" [title]="it.error">failed</span> <span class="subtle">{{ it.error }}</span> }
                      @else if (it.applied) { <span class="chip green">applied</span> }
                      @else if (!it.to) { <span class="chip red">unresolved</span> }
                      @else if (p.status === 'DISMISSED') { <span class="chip gray">dismissed</span> }
                      @else { <span class="chip blue">pending</span> }
                    </td>
                  </tr>
                } @empty { <tr><td colspan="8" class="empty">No appointments needed to move.</td></tr> }
              </tbody>
            </table>
          </div>
          @if (p.appliedAt) { <div class="card-footer muted small">Applied {{ fmtDateTime(p.appliedAt) }}</div> }
        </div>
      } @else if (error()) { <div class="inline-alert error">{{ error() }}</div> }
      @else { <div class="loading"><span class="spinner"></span> Loading…</div> }
    </div>
  `,
  styles: [`tr.applied td { opacity: 0.7; }`],
})
export class ProposalDetailPage {
  private readonly api = inject(SchedulingApi);
  private readonly doctorsApi = inject(DoctorsApi);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  readonly id = input.required<string>();
  readonly fmtDateTime = fmtDateTime;
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
    return p.unresolvedAppointmentIds.map((id) => {
      const it = p.items.find((x) => x.appointmentId === id);
      const a = p.unresolvedAppointments?.find((x) => x.id === id);
      if (it) return { id, label: `${it.patientName || 'Appointment'} · ${fmtDate(it.from, 'dd MMM HH:mm')}` };
      return { id, label: a ? `${a.patient?.firstName ?? ''} ${a.patient?.lastName ?? ''} · ${fmtDate(a.startsAt, 'dd MMM HH:mm')}`.trim() : `Appointment ${id.slice(0, 8)}…` };
    });
  });

  ngOnInit() {
    this.doctorsApi.list().subscribe({ next: (d) => this.doctors.set(d), error: () => undefined });
    this.load();
  }
  load() {
    this.api.proposal(this.id()).subscribe({
      next: (p) => { this.proposal.set({ ...p, items: p.items ?? [], unresolvedAppointmentIds: p.unresolvedAppointmentIds ?? [] }); this.selected.set(new Set()); },
      error: (err) => this.error.set(errorMessage(err, 'Could not load proposal.')),
    });
  }
  doctorName(id: string | null, fallback?: string | null) {
    const d = id ? this.doctors().find((x) => x.id === id) : null;
    return d ? `${d.title ?? ''} ${d.firstName} ${d.lastName}`.trim() : fallback || '…';
  }
  sameDay(it: ProposalItem) { return !!it.to && fmtDate(it.from) === fmtDate(it.to); }
  displacement(min: number) { return min >= 1440 ? `${(min / 1440).toFixed(1)} d` : min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min} min`; }
  toggle(id: string) { this.selected.update((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }
  toggleAll() { this.selected.set(this.allSelected() ? new Set() : new Set(this.pendingItems().map((i) => i.appointmentId))); }

  async apply(ids?: string[]) {
    const n = ids?.length ?? this.pendingItems().length;
    if (!(await this.confirm.ask({ title: 'Apply proposal', message: `Move ${n} appointment${n === 1 ? '' : 's'} to the proposed slots? Patients and doctors will be notified.`, confirmText: 'Apply' }))) return;
    this.busy.set(true);
    this.api.applyProposal(this.id(), ids).subscribe({
      next: (p) => {
        this.busy.set(false);
        const failed = (p?.items ?? []).filter((i) => i.error).length;
        if (failed) this.toast.warn(`Applied with ${failed} failure(s) — see the Result column.`); else this.toast.success('Appointments rescheduled');
        this.load();
      },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
  async dismiss() {
    if (!(await this.confirm.ask({ title: 'Dismiss proposal', message: 'Dismiss this proposal? No appointments will be moved.', confirmText: 'Dismiss', danger: true }))) return;
    this.busy.set(true);
    this.api.dismissProposal(this.id()).subscribe({
      next: () => { this.busy.set(false); this.toast.info('Proposal dismissed'); this.load(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
}
