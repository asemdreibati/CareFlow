import { Component, inject, input, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { DoctorsApi } from '../../core/api/doctors.api';
import { MembersApi } from '../../core/api/members.api';
import { clean, clearedToNull } from '../../core/api/http-utils';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { Doctor, DoctorDto, Member } from '../../core/models';
import { PageHeaderComponent } from '../../shared/page-header';
import { FieldErrorComponent } from '../../shared/field-error';

const PALETTE = ['#2563eb', '#0f766e', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#ca8a04'];

@Component({
  selector: 'cf-doctor-form',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe, PageHeaderComponent, FieldErrorComponent],
  template: `
    <div class="page" style="max-width: 860px">
      <cf-page-header [title]="(id() ? 'doctors.edit' : 'doctors.new') | translate">
        <a class="btn" [routerLink]="id() ? ['/doctors', id()] : ['/doctors']">{{ 'common.cancel' | translate }}</a>
      </cf-page-header>
      @if (loading()) { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
      @else {
        <form [formGroup]="form" (ngSubmit)="submit()" class="card">
          <div class="card-body form-grid">
            <div class="field"><label>{{ 'doctors.titleField' | translate }}</label><input class="input" formControlName="title" [placeholder]="'doctors.titlePlaceholder' | translate" /></div>
            <div class="field"><label class="req">{{ 'doctors.specialty' | translate }}</label><input class="input" formControlName="specialty" /><cf-field-error [control]="form.controls.specialty" /></div>
            <div class="field"><label class="req">{{ 'common.firstName' | translate }}</label><input class="input" formControlName="firstName" /><cf-field-error [control]="form.controls.firstName" /></div>
            <div class="field"><label class="req">{{ 'common.lastName' | translate }}</label><input class="input" formControlName="lastName" /><cf-field-error [control]="form.controls.lastName" /></div>
            <div class="field"><label>{{ 'doctors.licenseNumber' | translate }}</label><input class="input" formControlName="licenseNumber" dir="ltr" /></div>
            <div class="field"><label>{{ 'doctors.calendarColor' | translate }}</label>
              <div class="row gap-1 wrap" style="height: 36px">
                @for (c of palette; track c) { <button type="button" class="swatch" [style.background]="c" [class.on]="form.controls.color.value === c" (click)="form.controls.color.setValue(c)" [attr.aria-label]="c"></button> }
                <input class="input" type="color" formControlName="color" style="width: 44px; padding: 2px" />
              </div>
            </div>
            <div class="field"><label>{{ 'common.phone' | translate }}</label><input class="input" formControlName="phone" dir="ltr" /></div>
            <div class="field"><label>{{ 'common.email' | translate }}</label><input class="input" type="email" formControlName="email" dir="ltr" /><cf-field-error [control]="form.controls.email" /></div>
            <div class="field span-2"><label>{{ 'doctors.linkedMember' | translate }}</label>
              <select class="input" formControlName="userId">
                <option value="">— {{ 'doctors.notLinked' | translate }} —</option>
                @for (m of members(); track m.id) { <option [value]="m.user.id">{{ m.user.firstName }} {{ m.user.lastName }} ({{ m.user.email }}, {{ lang.enumLabel(m.role, 'role') }})</option> }
              </select>
              <div class="subtle">{{ 'doctors.linkHint' | translate }}</div>
            </div>
            <div class="field span-2"><label>{{ 'doctors.bio' | translate }}</label><textarea class="input" formControlName="bio" rows="3"></textarea></div>
            @if (id()) { <label class="checkbox"><input type="checkbox" formControlName="isActive" /> {{ 'common.active' | translate }}</label> }
          </div>
          <div class="card-footer">
            <a class="btn" [routerLink]="id() ? ['/doctors', id()] : ['/doctors']">{{ 'common.cancel' | translate }}</a>
            <button class="btn primary" type="submit" [disabled]="saving()">{{ (saving() ? 'common.saving' : id() ? 'common.saveChanges' : 'doctors.create') | translate }}</button>
          </div>
        </form>
      }
    </div>
  `,
  styles: [`.swatch { width: 26px; height: 26px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; } .swatch.on { border-color: var(--cf-text); box-shadow: 0 0 0 2px #fff inset; }`],
})
export class DoctorFormPage {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(DoctorsApi);
  private readonly membersApi = inject(MembersApi);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);
  readonly id = input<string>();
  readonly palette = PALETTE;
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly members = signal<Member[]>([]);
  private original: Doctor | null = null;
  readonly form = this.fb.nonNullable.group({
    title: ['Dr.'], firstName: ['', Validators.required], lastName: ['', Validators.required], specialty: ['', Validators.required],
    licenseNumber: [''], phone: [''], email: ['', Validators.email], color: [PALETTE[0]], bio: [''], userId: [''], isActive: [true],
  });

  ngOnInit() {
    this.membersApi.list().subscribe({ next: (m) => this.members.set(m.filter((x) => x.isActive)), error: () => undefined });
    const id = this.id();
    if (!id) return;
    this.loading.set(true);
    this.api.get(id).subscribe({
      next: (d) => {
        this.original = d;
        this.form.patchValue({
          title: d.title ?? '', firstName: d.firstName, lastName: d.lastName, specialty: d.specialty, licenseNumber: d.licenseNumber ?? '',
          phone: d.phone ?? '', email: d.email ?? '', color: d.color ?? PALETTE[0], bio: d.bio ?? '', userId: d.userId ?? '', isActive: d.isActive,
        });
        this.loading.set(false);
      },
      error: (err) => { this.loading.set(false); this.toast.fromError(err); },
    });
  }
  submit() {
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }
    const v = this.form.getRawValue();
    const dto = clean({ ...v, isActive: undefined }) as DoctorDto;
    this.saving.set(true);
    const id = this.id();
    // Edit: emptied optional fields are sent as null so the API clears them (create keeps omitting them).
    const cleared = id ? clearedToNull(v, this.original, ['title', 'licenseNumber', 'phone', 'email', 'bio', 'userId'] as const) : {};
    (id ? this.api.update(id, { ...dto, ...cleared, isActive: v.isActive }) : this.api.create(dto)).subscribe({
      next: (d) => { this.toast.success(this.lang.t(id ? 'doctors.updated' : 'doctors.created')); void this.router.navigate(['/doctors', d.id]); },
      error: (err) => { this.saving.set(false); this.toast.fromError(err); },
    });
  }
}
