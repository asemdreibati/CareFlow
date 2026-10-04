import { Component, inject, input, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { PatientsApi } from '../../core/api/patients.api';
import { clean } from '../../core/api/http-utils';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { Gender, Patient, PatientDto } from '../../core/models';
import { PageHeaderComponent } from '../../shared/page-header';
import { FieldErrorComponent } from '../../shared/field-error';

const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

@Component({
  selector: 'cf-patient-form',
  imports: [ReactiveFormsModule, RouterLink, PageHeaderComponent, FieldErrorComponent],
  template: `
    <div class="page" style="max-width: 920px">
      <cf-page-header [title]="id() ? 'Edit patient' : 'New patient'" [subtitle]="patient()?.mrn">
        <a class="btn" [routerLink]="id() ? ['/patients', id()] : ['/patients']">Cancel</a>
      </cf-page-header>
      @if (loading()) { <div class="loading"><span class="spinner"></span> Loading…</div> }
      @else {
        <form [formGroup]="form" (ngSubmit)="submit()">
          <div class="card mb-2">
            <div class="card-header"><h3>Demographics</h3></div>
            <div class="card-body form-grid">
              <div class="field"><label class="req">First name</label><input class="input" formControlName="firstName" /><cf-field-error [control]="form.controls.firstName" /></div>
              <div class="field"><label class="req">Last name</label><input class="input" formControlName="lastName" /><cf-field-error [control]="form.controls.lastName" /></div>
              <div class="field"><label>Date of birth</label><input class="input" type="date" formControlName="dateOfBirth" /></div>
              <div class="field"><label>Gender</label>
                <select class="input" formControlName="gender"><option value="">—</option>@for (g of genders; track g) { <option [value]="g">{{ g }}</option> }</select>
              </div>
              <div class="field"><label>Phone</label><input class="input" formControlName="phone" /></div>
              <div class="field"><label>Email</label><input class="input" type="email" formControlName="email" /><cf-field-error [control]="form.controls.email" /></div>
              <div class="field span-2"><label>Address</label><input class="input" formControlName="address" /></div>
              @if (canSensitive) {
                <div class="field"><label>National ID <span class="subtle">(encrypted at rest)</span></label><input class="input" formControlName="nationalId" [placeholder]="patient()?.nationalIdMasked || ''" /></div>
              }
              <div class="field"><label>Blood type</label>
                <select class="input" formControlName="bloodType"><option value="">—</option>@for (b of bloodTypes; track b) { <option [value]="b">{{ b }}</option> }</select>
              </div>
            </div>
          </div>
          <div class="card mb-2">
            <div class="card-header"><h3>Emergency contact</h3></div>
            <div class="card-body form-grid" formGroupName="emergencyContact">
              <div class="field"><label>Name</label><input class="input" formControlName="name" /></div>
              <div class="field"><label>Phone</label><input class="input" formControlName="phone" /></div>
              <div class="field"><label>Relation</label><input class="input" formControlName="relation" placeholder="Spouse, parent…" /></div>
            </div>
          </div>
          <div class="card mb-2">
            <div class="card-header"><h3>Notes</h3></div>
            <div class="card-body">
              <div class="field"><textarea class="input" formControlName="notes" rows="4" placeholder="Administrative notes (not part of the medical record)"></textarea></div>
              @if (id()) { <label class="checkbox"><input type="checkbox" formControlName="isActive" /> Active patient</label> }
            </div>
          </div>
          <div class="form-actions">
            <a class="btn" [routerLink]="id() ? ['/patients', id()] : ['/patients']">Cancel</a>
            <button class="btn primary" type="submit" [disabled]="saving()">{{ saving() ? 'Saving…' : (id() ? 'Save changes' : 'Create patient') }}</button>
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
          notes: p.notes ?? '', isActive: p.isActive,
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
    const req = id ? this.api.update(id, { ...dto, isActive: v.isActive }) : this.api.create(dto);
    req.subscribe({
      next: (p) => { this.toast.success(id ? 'Patient updated' : 'Patient created'); void this.router.navigate(['/patients', p.id]); },
      error: (err) => { this.saving.set(false); this.toast.fromError(err); },
    });
  }
}
