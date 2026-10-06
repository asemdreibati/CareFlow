import { Routes } from '@angular/router';

/** Patient portal route tree (mobile-first, phone + OTP login). Filled in by the portal feature. */
export const PORTAL_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },
  { path: 'login', loadComponent: () => import('./portal-placeholder').then((m) => m.PortalPlaceholder) },
];
