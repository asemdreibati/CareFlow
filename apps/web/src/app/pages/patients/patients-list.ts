import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { PatientsApi } from '../../core/api/patients.api';
import { ToastService } from '../../core/toast.service';
import { Patient } from '../../core/models';
import { age, fmtDate } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { PaginationComponent } from '../../shared/pagination';
import { StatusChipComponent } from '../../shared/status-chip';
import { HasPermissionDirective } from '../../core/permission.directive';

@Component({
  selector: 'cf-patients-list',
  imports: [RouterLink, PageHeaderComponent, PaginationComponent, StatusChipComponent, HasPermissionDirective],
  template: `
    <div class="page">
      <cf-page-header title="Patients" [subtitle]="total() + ' registered'">
        <a *hasPermission="'patients:write'" class="btn primary" routerLink="/patients/new">+ New patient</a>
      </cf-page-header>
      <div class="card">
        <div class="card-header">
          <input class="input" style="max-width: 360px" type="search" placeholder="Search by name, MRN, phone…" [value]="search()" (input)="onSearch($event)" />
          <label class="checkbox"><input type="checkbox" [checked]="includeInactive()" (change)="toggleInactive()" /> Include inactive</label>
        </div>
        @if (loading()) { <div class="loading"><span class="spinner"></span> Loading…</div> }
        @else {
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>MRN</th><th>Name</th><th>Age / Sex</th><th>Phone</th><th>Email</th><th>Status</th><th>Added</th></tr></thead>
              <tbody>
                @for (p of items(); track p.id) {
                  <tr class="clickable" (click)="open(p)">
                    <td class="mono">{{ p.mrn }}</td>
                    <td class="strong">{{ p.firstName }} {{ p.lastName }}</td>
                    <td>{{ age(p.dateOfBirth) }} · {{ p.gender ? p.gender[0] : '?' }}</td>
                    <td>{{ p.phone || '—' }}</td>
                    <td class="muted">{{ p.email || '—' }}</td>
                    <td><cf-chip [status]="p.isActive" /></td>
                    <td class="muted nowrap">{{ fmtDate(p.createdAt) }}</td>
                  </tr>
                } @empty { <tr><td colspan="7" class="empty">No patients match.</td></tr> }
              </tbody>
            </table>
          </div>
          <cf-pagination [page]="page()" [pageSize]="pageSize" [total]="total()" (pageChange)="goto($event)" />
        }
      </div>
    </div>
  `,
})
export class PatientsListPage {
  private readonly api = inject(PatientsApi);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  readonly age = age;
  readonly fmtDate = fmtDate;
  readonly pageSize = 25;
  readonly items = signal<Patient[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly search = signal('');
  readonly includeInactive = signal(false);
  readonly loading = signal(true);
  private readonly search$ = new Subject<string>();

  constructor() {
    this.search$.pipe(debounceTime(300), distinctUntilChanged(), takeUntilDestroyed()).subscribe((q) => { this.search.set(q); this.page.set(1); this.load(); });
    this.load();
  }
  onSearch(e: Event) { this.search$.next((e.target as HTMLInputElement).value.trim()); }
  toggleInactive() { this.includeInactive.update((v) => !v); this.page.set(1); this.load(); }
  goto(p: number) { this.page.set(p); this.load(); }
  open(p: Patient) { void this.router.navigate(['/patients', p.id]); }
  load() {
    this.loading.set(true);
    this.api.list({ search: this.search() || undefined, page: this.page(), pageSize: this.pageSize, includeInactive: this.includeInactive() || undefined }).subscribe({
      next: (r) => { this.items.set(r.items); this.total.set(r.total); this.loading.set(false); },
      error: (err) => { this.loading.set(false); this.toast.fromError(err); },
    });
  }
}
