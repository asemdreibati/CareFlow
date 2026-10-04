import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuditApi } from '../../core/api/audit.api';
import { MembersApi } from '../../core/api/members.api';
import { errorMessage } from '../../core/toast.service';
import { AuditRow, Member } from '../../core/models';
import { fmtDateTime } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { PaginationComponent } from '../../shared/pagination';

@Component({
  selector: 'cf-audit',
  imports: [FormsModule, PageHeaderComponent, PaginationComponent],
  template: `
    <div class="page">
      <cf-page-header title="Audit log" subtitle="Append-only trail of every mutating request" />
      <div class="card">
        <form class="card-header filters" (ngSubmit)="apply()">
          <input class="input sm" placeholder="Action (e.g. patients.create)" [(ngModel)]="f.action" name="action" />
          <input class="input sm" placeholder="Entity type" [(ngModel)]="f.entityType" name="entityType" />
          <input class="input sm" placeholder="Entity ID" [(ngModel)]="f.entityId" name="entityId" />
          <select class="input sm" [(ngModel)]="f.actorUserId" name="actor"><option value="">Any actor</option>@for (m of members(); track m.id) { <option [value]="m.user.id">{{ m.user.firstName }} {{ m.user.lastName }}</option> }</select>
          <input class="input sm" type="date" [(ngModel)]="f.from" name="from" />
          <input class="input sm" type="date" [(ngModel)]="f.to" name="to" />
          <button class="btn sm primary" type="submit">Filter</button>
          <button class="btn sm" type="button" (click)="reset()">Reset</button>
        </form>
        @if (loading()) { <div class="loading"><span class="spinner"></span> Loading…</div> }
        @else if (error()) { <div class="empty">{{ error() }}</div> }
        @else {
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Request</th><th class="num">Status</th><th class="num">ms</th></tr></thead>
              <tbody>
                @for (r of rows(); track r.id) {
                  <tr>
                    <td class="nowrap">{{ fmt(r.createdAt) }}</td>
                    <td class="muted">{{ r.actorEmail || (r.actorUserId ? r.actorUserId.slice(0, 8) : 'system') }}</td>
                    <td><span class="chip" [class.red]="r.statusCode >= 400" [class.gray]="r.statusCode < 400">{{ r.action }}</span></td>
                    <td class="muted small">{{ r.entityType || '—' }}@if (r.entityId) { <span class="mono"> {{ r.entityId.slice(0, 8) }}</span> }</td>
                    <td class="mono small">{{ r.method }} {{ r.path }}</td>
                    <td class="num" [class.danger-text]="r.statusCode >= 400">{{ r.statusCode }}</td>
                    <td class="num muted">{{ r.durationMs }}</td>
                  </tr>
                } @empty { <tr><td colspan="7" class="empty">No audit rows match.</td></tr> }
              </tbody>
            </table>
          </div>
          <cf-pagination [page]="page()" [pageSize]="pageSize" [total]="total()" (pageChange)="page.set($event); load()" />
        }
      </div>
    </div>
  `,
  styles: [`.filters { display: flex; flex-wrap: wrap; gap: 8px; } .filters .input { width: auto; min-width: 140px; flex: 1; }`],
})
export class AuditPage {
  private readonly api = inject(AuditApi);
  private readonly membersApi = inject(MembersApi);
  readonly fmt = fmtDateTime;
  readonly pageSize = 50;
  readonly rows = signal<AuditRow[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly members = signal<Member[]>([]);
  f = { action: '', entityType: '', entityId: '', actorUserId: '', from: '', to: '' };

  constructor() {
    this.load();
    this.membersApi.list().subscribe({ next: (m) => this.members.set(m), error: () => undefined });
  }
  apply() { this.page.set(1); this.load(); }
  reset() { this.f = { action: '', entityType: '', entityId: '', actorUserId: '', from: '', to: '' }; this.apply(); }
  load() {
    this.loading.set(true);
    this.api.list({
      action: this.f.action || undefined, entityType: this.f.entityType || undefined, entityId: this.f.entityId || undefined, actorUserId: this.f.actorUserId || undefined,
      from: this.f.from ? new Date(this.f.from).toISOString() : undefined, to: this.f.to ? new Date(this.f.to + 'T23:59:59').toISOString() : undefined,
      page: this.page(), pageSize: this.pageSize,
    }).subscribe({
      next: (r) => { this.rows.set(r.items ?? []); this.total.set(r.total ?? 0); this.loading.set(false); this.error.set(null); },
      error: (err) => { this.loading.set(false); this.error.set(errorMessage(err, 'Audit log is not available yet.')); },
    });
  }
}
