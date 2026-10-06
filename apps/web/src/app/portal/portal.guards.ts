import { inject } from '@angular/core';
import { CanActivateChildFn, CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { PortalApi } from './portal-api.service';
import { PortalAuthService } from './portal-auth.service';
import { portalLoginPath } from './portal-url';
import { REQUIRED_CONSENT, hasConsent } from './portal.models';

/** Requires a patient token; otherwise sends the patient to the remembered clinic's login. */
export const portalAuthGuard: CanActivateFn = (_route, state) => {
  const auth = inject(PortalAuthService);
  const router = inject(Router);
  if (auth.isAuthenticated()) return true;
  return router.createUrlTree(portalLoginPath(auth.clinicSlug()), { queryParams: { redirect: state.url } });
};

/** Logged-in patients skip the login page. */
export const portalGuestGuard: CanActivateFn = () => {
  const auth = inject(PortalAuthService);
  const router = inject(Router);
  return auth.isAuthenticated() ? router.createUrlTree(['/portal', 'app']) : true;
};

/**
 * Consent gate: PRIVACY v1 must be accepted before the app shell opens. Loads `/portal/me` once;
 * when the endpoint is unavailable the gate lets the patient through (graceful degradation).
 */
export const portalConsentGuard: CanActivateChildFn = () => {
  const auth = inject(PortalAuthService);
  const api = inject(PortalApi);
  const router = inject(Router);
  const gate = router.createUrlTree(['/portal', 'app', 'consent']);
  const cached = auth.profile();
  if (cached) return hasConsent(cached.consents, REQUIRED_CONSENT) ? true : gate;
  return api.me().pipe(
    map((me) => (hasConsent(me?.consents, REQUIRED_CONSENT) ? true : gate)),
    catchError(() => of(true)),
  );
};
