import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, map, of, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

const NO_AUTH = ['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/refresh', '/api/v1/health'];

/**
 * Attaches the staff bearer token and recovers from an expired access token:
 *  1. 401 with a token that is no longer current (another request/tab already rotated it) → retry with the current token;
 *  2. otherwise one shared refresh (`AuthService.refreshShared`) → retry with the new token.
 * Only a failed *refresh* ends the session; errors of the retried request (409/400/404/500…) reach the caller untouched.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  // Patient-portal calls carry their own token (set by PortalApi); never attach the staff token or refresh/logout for them.
  if (!req.url.startsWith('/api/') || req.url.includes('/api/v1/portal/')) return next(req);
  const isPublic = NO_AUTH.some((u) => req.url.startsWith(u));

  const send = (token: string | null) => next(token && !isPublic ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req);
  const sentToken = isPublic ? null : auth.token();

  return send(sentToken).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse) || err.status !== 401 || isPublic || req.url.startsWith('/api/v1/auth/logout')) {
        return throwError(() => err);
      }
      // Another tab may have rotated the tokens before its storage event reached us.
      auth.syncFromStorage();
      const current = auth.token();
      if (current && current !== sentToken) return send(current);

      if (!auth.tokens()?.refreshToken) {
        auth.clear();
        void router.navigate(['/login']);
        return throwError(() => err);
      }
      return auth.refreshShared().pipe(
        map(() => true),
        catchError((refreshErr: unknown) => {
          // A login/clinic switch/other tab replaced the token meanwhile: use it instead of logging out.
          auth.syncFromStorage();
          const now = auth.token();
          if (now && now !== current) return of(true);
          auth.clear();
          void router.navigate(['/login']);
          return throwError(() => refreshErr);
        }),
        // Outside the refresh catchError: whatever the retried request returns propagates as-is.
        switchMap(() => send(auth.token())),
      );
    }),
  );
};
