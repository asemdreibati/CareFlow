import { Component, inject, input, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { PatientsApi } from '../../core/api/patients.api';
import { clean, clearedToNull } from '../../core/api/http-utils';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { Gender, Patient, PatientDto, PatientUpdateDto } from '../../core/models';
import { PageHeaderComponent } from '../../shared/page-header';
import { FieldErrorComponent } from '../../shared/field-error';

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
type PatientFormValue = ReturnType<PatientFormPage['form']['getRawValue']>;

@Component({
  selector: 'cf-patient-form',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe, PageHeaderComponent, FieldErrorComponent],
  template: `
    <div class="page" style="max-width: 920px">
      <cf-page-header [title]="(id() ? 'patients.edit' : 'patients.new') | translate" [subtitle]="patient()?.mrn">
        <a class="btn" [routerLink]="id() ? ['/patients', id()] : ['/patients']">{{ 'common.cancel' | translate }}</a>
      </cf-page-header>
      @if (loading()) { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
      @else {
        <form [formGroup]="form" (ngSubmit)="submit()">
          <div class="card mb-2">
            <div class="card-header"><h3>{{ 'patients.demographics' | translate }}</h3></div>
            <div class="card-body form-grid">
              <div class="field"><label class="req">{{ 'common.firstName' | translate }}</label><input class="input" formControlName="firstName" /><cf-field-error [control]="form.controls.firstName" /></div>
              <div class="field"><label class="req">{{ 'common.lastName' | translate }}</label><input class="input" formControlName="lastName" /><cf-field-error [control]="form.controls.lastName" /></div>
              <div class="field"><label>{{ 'patients.dob' | translate }}</label><input class="input" type="date" formControlName="dateOfBirth" /></div>
              <div class="field"><label>{{ 'patients.gender' | translate }}</label>
                <select class="input" formControlName="gender"><option value="">—</option>@for (g of genders; track g) { <option [value]="g">{{ lang.enumLabel(g, 'gender') }}</option> }</select>
              </div>
              <div class="field"><label>{{ 'common.phone' | translate }}</label><input class="input" formControlName="phone" dir="ltr" /></div>
              <div class="field"><label>{{ 'common.email' | translate }}</label><input class="input" type="email" formControlName="email" dir="ltr" /><cf-field-error [control]="form.controls.email" /></div>
              <div class="field span-2"><label>{{ 'common.address' | translate }}</label><input class="input" formControlName="address" /></div>
              @if (canSensitive) {
                <div class="field"><label>{{ 'patients.nationalId' | translate }} <span class="subtle">({{ 'patients.encrypted' | translate }})</span></label><input class="input" formControlName="nationalId" [placeholder]="patient()?.nationalIdMasked || ''" dir="ltr" /></div>
              }
              <div class="field"><label>{{ 'patients.bloodType' | translate }}</label>
                <select class="input" formControlName="bloodType"><option value="">—</option>@for (b of bloodTypes; track b) { <option [value]="b">{{ b }}</option> }</select>
              </div>
            </div>
          </div>
          <div class="card mb-2">
            <div class="card-header"><h3>{{ 'patients.emergencyContact' | translate }}</h3></div>
            <div class="card-body form-grid" formGroupName="emergencyContact">
              <div class="field"><label>{{ 'common.name' | translate }}</label><input class="input" formControlName="name" /></div>
              <div class="field"><label>{{ 'common.phone' | translate }}</label><input class="input" formControlName="phone" dir="ltr" /></div>
              <div class="field"><label>{{ 'patients.relation' | translate }}</label><input class="input" formControlName="relation" [placeholder]="'patients.relationPlaceholder' | translate" /></div>
            </div>
          </div>
          <div class="card mb-2">
            <div class="card-header"><h3>{{ 'patients.portal.title' | translate }}</h3></div>
            <div class="card-body form-grid">
              <div class="field">
                <label class="checkbox"><input type="checkbox" formControlName="portalEnabled" /> {{ 'patients.portal.enable' | translate }}</label>
                <div class="subtle small">{{ 'patients.portal.enableHint' | translate }}</div>
              </div>
              <div class="field"><label>{{ 'patients.portal.language' | translate }}</label>
                <select class="input" formControlName="locale">
                  <option value="">—</option>
                  <option value="ar">{{ 'patients.portal.arabic' | translate }}</option>
                  <option value="en">{{ 'patients.portal.english' | translate }}</option>
                </select>
              </div>
            </div>
          </div>
          <div class="card mb-2">
            <div class="card-header"><h3>{{ 'common.notes' | translate }}</h3></div>
            <div class="card-body">
              <div class="field"><textarea class="input" formControlName="notes" rows="4" [placeholder]="'patients.notesPlaceholder' | translate"></textarea></div>
              @if (id()) { <label class="checkbox"><input type="checkbox" formControlName="isActive" /> {{ 'patients.active' | translate }}</label> }
            </div>
          </div>
          <div class="form-actions">
            <a class="btn" [routerLink]="id() ? ['/patients', id()] : ['/patients']">{{ 'common.cancel' | translate }}</a>
            <button class="btn primary" type="submit" [disabled]="saving()">{{ (saving() ? 'common.saving' : id() ? 'common.saveChanges' : 'patients.create') | translate }}</button>
          </div>
        </form>
      }
    </div>
  `,
})
export class PatientFormPage {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(PatientsApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);
  readonly id = input<string>();
  readonly genders: Gender[] = ['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'];
  readonly bloodTypes = BLOOD_TYPES;
  readonly canSensitive = this.auth.hasPermission('patients:sensitive');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly patient = signal<Patient | null>(null);
  readonly form = this.fb.nonNullable.group({
    firstName: ['', Validators.required],
    lastName: ['', Validators.required],
    dateOfBirth: [''],
    gender: [''],
    phone: [''],
    email: ['', Validators.email],
    address: [''],
    nationalId: [''],
    bloodType: [''],
    emergencyContact: this.fb.nonNullable.group({ name: [''], phone: [''], relation: [''] }),
    notes: [''],
    isActive: [true],
    portalEnabled: [false],
    locale: ['' as '' | 'ar' | 'en'],
  });

  ngOnInit() {
    const id = this.id();
    if (!id) return;
    this.loading.set(true);
    this.api.get(id).subscribe({
      next: (p) => {
        this.patient.set(p);
        this.form.patchValue({
          firstName: p.firstName, lastName: p.lastName, dateOfBirth: p.dateOfBirth?.slice(0, 10) ?? '', gender: p.gender ?? '',
          phone: p.phone ?? '', email: p.email ?? '', address: p.address ?? '', nationalId: '', bloodType: p.bloodType ?? '',
          emergencyContact: { name: p.emergencyContact?.name ?? '', phone: p.emergencyContact?.phone ?? '', relation: p.emergencyContact?.relation ?? '' },
          notes: p.notes ?? '', isActive: p.isActive, portalEnabled: !!p.portalEnabled, locale: p.locale === 'ar' || p.locale === 'en' ? p.locale : '',
        });
        this.loading.set(false);
      },
      error: (err) => { this.loading.set(false); this.toast.fromError(err); },
    });
  }

  submit() {
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }
    const v = this.form.getRawValue();
    const ec = clean(v.emergencyContact);
    const dto = clean({
      firstName: v.firstName, lastName: v.lastName, dateOfBirth: v.dateOfBirth, gender: v.gender as Gender, phone: v.phone, email: v.email,
      address: v.address, nationalId: this.canSensitive ? v.nationalId : undefined, bloodType: v.bloodType, notes: v.notes,
      emergencyContact: Object.keys(ec).length ? ec : undefined,
    }) as PatientDto;
    this.saving.set(true);
    const id = this.id();
    const portal = { portalEnabled: v.portalEnabled, ...(v.locale ? { locale: v.locale } : {}) };
    if (id) {
      this.api.update(id, { ...dto, ...this.cleared(v), ...portal, isActive: v.isActive }).subscribe({
        next: (p) => this.done(p, 'patients.updated'),
        error: (err) => { this.saving.set(false); this.toast.fromError(err); },
      });
      return;
    }
    // CreatePatientDto has no portal fields (the API rejects unknown keys): apply them with a follow-up PATCH.
    const needsPortalPatch = v.portalEnabled || !!v.locale;
    this.api.create(dto).subscribe({
      next: (created) => {
        if (!needsPortalPatch) { this.done(created, 'patients.created'); return; }
        this.api.update(created.id, portal).subscribe({
          next: (p) => this.done(p, 'patients.created'),
          error: (err) => { this.toast.fromError(err, this.lang.t('patients.portal.saveFailed')); this.done(created, 'patients.created'); },
        });
      },
      error: (err) => { this.saving.set(false); this.toast.fromError(err); },
    });
  }

  /**
   * Edit only: optional fields the user emptied are sent as `null` so the API clears them. Gender is not
   * nullable (falls back to UNKNOWN); an emptied emergency contact (a JSON column) is sent as `{}`.
   */
  private cleared(v: PatientFormValue): PatientUpdateDto {
    const p = this.patient();
    if (!p) return {};
    const out: PatientUpdateDto = clearedToNull(v, p, ['dateOfBirth', 'phone', 'email', 'address', 'bloodType', 'notes', 'locale'] as const);
    if (!v.gender && p.gender && p.gender !== 'UNKNOWN') out.gender = 'UNKNOWN';
    const ecNow = Object.keys(clean(v.emergencyContact)).length;
    const ecBefore = Object.values(p.emergencyContact ?? {}).some((x) => typeof x === 'string' && x.trim());
    if (!ecNow && ecBefore) out.emergencyContact = {};
    return out;
  }

  private done(p: Patient, key: string) {
    this.toast.success(this.lang.t(key));
    void this.router.navigate(['/patients', p.id]);
  }
}
