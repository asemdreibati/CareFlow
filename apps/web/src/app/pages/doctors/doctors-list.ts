import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { DoctorsApi } from '../../core/api/doctors.api';
import { ToastService } from '../../core/toast.service';
import { Doctor } from '../../core/models';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { HasPermissionDirective } from '../../core/permission.directive';

@Component({
  selector: 'cf-doctors-list',
  imports: [RouterLink, TranslatePipe, PageHeaderComponent, StatusChipComponent, HasPermissionDirective],
  template: `
    <div class="page">
      <cf-page-header [title]="'doctors.title' | translate" [subtitle]="'doctors.count' | translate: { n: items().length }">
        <label class="checkbox"><input type="checkbox" [checked]="includeInactive()" (change)="toggle()" /> {{ 'common.includeInactive' | translate }}</label>
        <a *hasPermission="'doctors:write'" class="btn primary" routerLink="/doctors/new">+ {{ 'doctors.new' | translate }}</a>
      </cf-page-header>
      <div class="card">
        @if (loading()) { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
        @else {
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>{{ 'common.doctor' | translate }}</th><th>{{ 'doctors.specialty' | translate }}</th><th>{{ 'doctors.license' | translate }}</th><th>{{ 'doctors.contact' | translate }}</th><th>{{ 'doctors.login' | translate }}</th><th>{{ 'common.status' | translate }}</th></tr></thead>
              <tbody>
                @for (d of items(); track d.id) {
                  <tr class="clickable" (click)="open(d)">
                    <td><span class="row gap-1"><span class="pill-color" [style.background]="d.color || '#94a3b8'"></span><span class="strong">{{ d.title }} {{ d.firstName }} {{ d.lastName }}</span></span></td>
                    <td>{{ d.specialty }}</td>
                    <td class="mono muted">{{ d.licenseNumber || '—' }}</td>
                    <td class="muted" dir="ltr">{{ d.phone || d.email || '—' }}</td>
                    <td>{{ d.userId ? ('doctors.linked' | translate) : '—' }}</td>
                    <td><cf-chip [status]="d.isActive" /></td>
                  </tr>
                } @empty { <tr><td colspan="6" class="empty">{{ 'doctors.none' | translate }}</td></tr> }
              </tbody>
            </table>
          </div>
        }
      </div>
    </div>
  `,
})
export class DoctorsListPage {
  private readonly api = inject(DoctorsApi);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  readonly items = signal<Doctor[]>([]);
  readonly loading = signal(true);
  readonly includeInactive = signal(false);
  constructor() { this.load(); }
  toggle() { this.includeInactive.update((v) => !v); this.load(); }
  open(d: Doctor) { void this.router.navigate(['/doctors', d.id]); }
  load() {
    this.loading.set(true);
    this.api.list(this.includeInactive()).subscribe({
      next: (list) => { this.items.set(list); this.loading.set(false); },
      error: (err) => { this.loading.set(false); this.toast.fromError(err); },
    });
  }
}
