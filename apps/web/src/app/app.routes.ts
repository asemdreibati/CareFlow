import { Routes } from '@angular/router';
import { authGuard, guestGuard, permissionGuard } from './core/guards';

export const routes: Routes = [
  { path: 'login', canActivate: [guestGuard], loadComponent: () => import('./pages/auth/login').then((m) => m.LoginPage) },
  { path: 'register', canActivate: [guestGuard], loadComponent: () => import('./pages/auth/register').then((m) => m.RegisterPage) },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/shell').then((m) => m.ShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.DashboardPage) },
      {
        path: 'patients',
        canActivate: [permissionGuard('patients:read')],
        children: [
          { path: '', loadComponent: () => import('./pages/patients/patients-list').then((m) => m.PatientsListPage) },
          { path: 'new', canActivate: [permissionGuard('patients:write')], loadComponent: () => import('./pages/patients/patient-form').then((m) => m.PatientFormPage) },
          { path: ':id/edit', canActivate: [permissionGuard('patients:write')], loadComponent: () => import('./pages/patients/patient-form').then((m) => m.PatientFormPage) },
          { path: ':id', loadComponent: () => import('./pages/patients/patient-detail').then((m) => m.PatientDetailPage) },
        ],
      },
      {
        path: 'doctors',
        canActivate: [permissionGuard('doctors:read')],
        children: [
          { path: '', loadComponent: () => import('./pages/doctors/doctors-list').then((m) => m.DoctorsListPage) },
          { path: 'new', canActivate: [permissionGuard('doctors:write')], loadComponent: () => import('./pages/doctors/doctor-form').then((m) => m.DoctorFormPage) },
          { path: ':id/edit', canActivate: [permissionGuard('doctors:write')], loadComponent: () => import('./pages/doctors/doctor-form').then((m) => m.DoctorFormPage) },
          { path: ':id', loadComponent: () => import('./pages/doctors/doctor-detail').then((m) => m.DoctorDetailPage) },
        ],
      },
      { path: 'calendar', canActivate: [permissionGuard('appointments:read')], loadComponent: () => import('./pages/calendar/calendar').then((m) => m.CalendarPage) },
      { path: 'appointments/:id', canActivate: [permissionGuard('appointments:read')], loadComponent: () => import('./pages/appointments/appointment-detail').then((m) => m.AppointmentDetailPage) },
      { path: 'series/:id', canActivate: [permissionGuard('appointments:read')], loadComponent: () => import('./pages/series/series-detail').then((m) => m.SeriesDetailPage) },
      { path: 'waitlist', canActivate: [permissionGuard('appointments:read')], loadComponent: () => import('./pages/waitlist/waitlist').then((m) => m.WaitlistPage) },
      { path: 'resources', canActivate: [permissionGuard('doctors:read')], loadComponent: () => import('./pages/resources/resources').then((m) => m.ResourcesPage) },
      {
        path: 'scheduling',
        canActivate: [permissionGuard('scheduling:manage')],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'proposals' },
          { path: 'proposals', loadComponent: () => import('./pages/scheduling/proposals').then((m) => m.ProposalsPage) },
          { path: 'proposals/:id', loadComponent: () => import('./pages/scheduling/proposal-detail').then((m) => m.ProposalDetailPage) },
        ],
      },
      { path: 'encounters/:id', canActivate: [permissionGuard('records:read')], loadComponent: () => import('./pages/encounters/encounter-editor').then((m) => m.EncounterEditorPage) },
      {
        path: 'billing',
        canActivate: [permissionGuard('billing:read')],
        children: [
          { path: '', loadComponent: () => import('./pages/billing/billing').then((m) => m.BillingPage) },
          { path: 'invoices/:id', loadComponent: () => import('./pages/billing/invoice-detail').then((m) => m.InvoiceDetailPage) },
        ],
      },
      { path: 'members', canActivate: [permissionGuard('members:read')], loadComponent: () => import('./pages/members/members').then((m) => m.MembersPage) },
      { path: 'audit', canActivate: [permissionGuard('audit:read')], loadComponent: () => import('./pages/audit/audit').then((m) => m.AuditPage) },
      { path: 'settings', loadComponent: () => import('./pages/settings/settings').then((m) => m.SettingsPage) },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];
