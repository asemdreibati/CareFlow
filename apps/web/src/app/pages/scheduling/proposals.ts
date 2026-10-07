import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { SchedulingApi } from '../../core/api/scheduling.api';
import { DoctorsApi } from '../../core/api/doctors.api';
import { LanguageService } from '../../core/i18n/language.service';
import { Doctor, ProposalStatus, RescheduleProposal } from '../../core/models';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { ProposalDialogComponent } from './proposal-dialog';

@Component({
  selector: 'cf-proposals',
  imports: [FormsModule, RouterLink, TranslatePipe, PageHeaderComponent, StatusChipComponent, ProposalDialogComponent],
  template: `
    <div class="page">
      <cf-page-header [title]="'proposals.title' | translate" [subtitle]="'proposals.subtitle' | translate">
        <select class="input sm" style="width: 170px" [ngModel]="status()" (ngModelChange)="status.set($event); load()" [attr.aria-label]="'common.status' | translate">
          <option value="">{{ 'common.allStatuses' | translate }}</option>
          @for (s of statuses; track s) { <option [value]="s">{{ lang.enumLabel(s, 'status') }}</option> }
        </select>
        <button type="button" class="btn primary" (click)="openNew('')">+ {{ 'proposals.new' | translate }}</button>
      </cf-page-header>

      <div class="card">
        @if (loading()) { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
        @else if (error()) { <div class="empty">{{ error() }}</div> }
        @else {
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>{{ 'common.created' | translate }}</th><th>{{ 'proposals.cause' | translate }}</th><th>{{ 'proposals.items' | translate }}</th><th>{{ 'proposals.unresolved' | translate }}</th><th class="num">{{ 'proposals.displacement' | translate }}</th><th>{{ 'common.status' | translate }}</th><th></th></tr></thead>
              <tbody>
                @for (p of proposals(); track p.id) {
                  <tr class="clickable" (click)="open(p)">
                    <td class="nowrap">{{ lang.formatDateTime(p.createdAt) }}</td>
                    <td class="truncate" style="max-width: 320px">{{ p.cause }}</td>
                    <td>{{ p.items.length }}</td>
                    <td>@if (p.unresolvedAppointmentIds.length) { <span class="chip red">{{ p.unresolvedAppointmentIds.length }}</span> } @else { <span class="muted">0</span> }</td>
                    <td class="num">{{ lang.formatMinutes(p.totalDisplacementMinutes) }}</td>
                    <td><cf-chip [status]="p.status" group="status" /></td>
                    <td class="actions"><a class="btn xs" [routerLink]="['/scheduling/proposals', p.id]" (click)="$event.stopPropagation()">{{ 'common.open' | translate }}</a></td>
                  </tr>
                } @empty { <tr><td colspan="7" class="empty">{{ 'proposals.none' | translate }}</td></tr> }
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
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly lang = inject(LanguageService);
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
      error: (err) => { this.loading.set(false); this.proposals.set([]); this.error.set(this.lang.errorMessage(err, this.lang.t('proposals.unavailable'))); },
    });
  }
  openNew(doctorId: string) { this.newDoctorId.set(doctorId); this.dialog.set(true); }
  open(p: RescheduleProposal) { void this.router.navigate(['/scheduling/proposals', p.id]); }
  onCreated(p: RescheduleProposal) { this.dialog.set(false); if (p?.id) this.open(p); else this.load(); }
}
