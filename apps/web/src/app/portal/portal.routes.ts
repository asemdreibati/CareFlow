import { Routes } from '@angular/router';
import { portalAuthGuard, portalConsentGuard, portalGuestGuard } from './portal.guards';

/**
 * Patient portal route tree (mounted at `/portal`):
 *   /portal/login, /portal/:clinicSlug/login   phone → OTP → verify
 *   /portal/app/consent                        first-login PRIVACY v1 gate
 *   /portal/app/{home,appointments,book,invoices,waitlist,profile}   authenticated shell
 */
export const PORTAL_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./portal-root').then((m) => m.PortalRoot),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'login' },
      { path: 'login', canActivate: [portalGuestGuard], loadComponent: () => import('./pages/login').then((m) => m.PortalLoginPage) },
      {
        path: 'app',
        canActivate: [portalAuthGuard],
        children: [
          { path: 'consent', loadComponent: () => import('./pages/consent-gate').then((m) => m.PortalConsentGatePage) },
          {
            path: '',
            canActivateChild: [portalConsentGuard],
            loadComponent: () => import('./shell/portal-shell').then((m) => m.PortalShell),
            children: [
              { path: '', pathMatch: 'full', redirectTo: 'home' },
              { path: 'home', loadComponent: () => import('./pages/home').then((m) => m.PortalHomePage) },
              { path: 'appointments', loadComponent: () => import('./pages/appointments').then((m) => m.PortalAppointmentsPage) },
              { path: 'appointments/:id', loadComponent: () => import('./pages/appointment-detail').then((m) => m.PortalAppointmentDetailPage) },
              { path: 'book', loadComponent: () => import('./pages/book').then((m) => m.PortalBookPage) },
              { path: 'invoices', loadComponent: () => import('./pages/invoices').then((m) => m.PortalInvoicesPage) },
              { path: 'invoices/:id', loadComponent: () => import('./pages/invoice-detail').then((m) => m.PortalInvoiceDetailPage) },
              { path: 'waitlist', loadComponent: () => import('./pages/waitlist').then((m) => m.PortalWaitlistPage) },
              { path: 'profile', loadComponent: () => import('./pages/profile').then((m) => m.PortalProfilePage) },
            ],
          },
        ],
      },
      { path: ':clinicSlug', pathMatch: 'full', redirectTo: ':clinicSlug/login' },
      { path: ':clinicSlug/login', canActivate: [portalGuestGuard], loadComponent: () => import('./pages/login').then((m) => m.PortalLoginPage) },
      { path: '**', redirectTo: 'login' },
    ],
  },
];
