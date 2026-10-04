import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { SchedulingApi } from '../../core/api/scheduling.api';
import { DoctorsApi } from '../../core/api/doctors.api';
import { ToastService, errorMessage } from '../../core/toast.service';
import { Doctor, ProposalStatus, RescheduleProposal } from '../../core/models';
import { fmtDateTime } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { ProposalDialogComponent } from './proposal-dialog';

@Component({
  selector: 'cf-proposals',
  imports: [FormsModule, RouterLink, PageHeaderComponent, StatusChipComponent, ProposalDialogComponent],
  template: `
    <div class="page">
      <cf-page-header title="Reschedule proposals" subtitle="Move displaced appointments into free slots when a doctor takes time off">
        <select class="input sm" style="width: 170px" [ngModel]="status()" (ngModelChange)="status.set($event); load()">
          <option value="">All statuses</option>
          @for (s of statuses; track s) { <option [value]="s">{{ s.replace('_', ' ').toLowerCase() }}</option> }
        </select>
        <button type="button" class="btn primary" (click)="openNew('')">+ New proposal</button>
      </cf-page-header>

      <div class="card">
        @if (loading()) { <div class="loading"><span class="spinner"></span> Loading…</div> }
        @else if (error()) { <div class="empty">{{ error() }}</div> }
        @else {
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Created</th><th>Cause</th><th>Items</th><th>Unresolved</th><th class="num">Displacement</th><th>Status</th><th></th></tr></thead>
              <tbody>
                @for (p of proposals(); track p.id) {
                  <tr class="clickable" (click)="open(p)">
                    <td class="nowrap">{{ fmt(p.createdAt) }}</td>
                    <td class="truncate" style="max-width: 320px">{{ p.cause }}</td>
                    <td>{{ p.items.length }}</td>
                    <td>@if (p.unresolvedAppointmentIds.length) { <span class="chip red">{{ p.unresolvedAppointmentIds.length }}</span> } @else { <span class="muted">0</span> }</td>
                    <td class="num">{{ p.totalDisplacementMinutes }} min</td>
                    <td><cf-chip [status]="p.status" /></td>
                    <td class="actions"><a class="btn xs" [routerLink]="['/scheduling/proposals', p.id]" (click)="$event.stopPropagation()">Open</a></td>
                  </tr>
                } @empty { <tr><td colspan="7" class="empty">No proposals yet. Create one from a doctor's time off.</td></tr> }
              </tbody>
            </table>
          </div>
        }
      </div>
    </div>
    @if (dialog()) { <cf-proposal-dialog [doctors]="doctors()" [initialDoctorId]="newDoctorId()" (closed)="dialog.set(false)" (created)="onCreated($event)" /> }
  `,
})
export class ProposalsPage {
  private readonly api = inject(SchedulingApi);
  private readonly doctorsApi = inject(DoctorsApi);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly fmt = fmtDateTime;
  readonly statuses: ProposalStatus[] = ['PENDING', 'APPLIED', 'PARTIALLY_APPLIED', 'DISMISSED'];
  readonly doctors = signal<Doctor[]>([]);
  readonly status = signal<'' | ProposalStatus>('');
  readonly proposals = signal<RescheduleProposal[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly dialog = signal(false);
  readonly newDoctorId = signal('');

  constructor() {
    this.doctorsApi.list().subscribe({ next: (d) => this.doctors.set(d), error: () => undefined });
    this.load();
    const q = this.route.snapshot.queryParamMap;
    if (q.get('new')) { this.openNew(q.get('doctorId') ?? ''); void this.router.navigate([], { queryParams: {}, replaceUrl: true }); }
  }
  load() {
    this.loading.set(true); this.error.set(null);
    this.api.proposals(this.status() || undefined).subscribe({
      next: (p) => {
        this.proposals.set(p.map((x) => ({ ...x, items: x.items ?? [], unresolvedAppointmentIds: x.unresolvedAppointmentIds ?? [] })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        this.loading.set(false);
      },
      error: (err) => { this.loading.set(false); this.proposals.set([]); this.error.set(errorMessage(err, 'Proposals are not available yet.')); },
    });
  }
  openNew(doctorId: string) { this.newDoctorId.set(doctorId); this.dialog.set(true); }
  open(p: RescheduleProposal) { void this.router.navigate(['/scheduling/proposals', p.id]); }
  onCreated(p: RescheduleProposal) { this.dialog.set(false); if (p?.id) this.open(p); else this.load(); }
}
