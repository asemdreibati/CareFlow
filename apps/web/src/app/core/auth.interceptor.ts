import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, catchError, finalize, shareReplay, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { AuthResponse } from './models';

const NO_AUTH = ['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/refresh', '/api/v1/health'];

/** Shared in-flight refresh so concurrent 401s trigger a single refresh call. */
let refreshInFlight: Observable<AuthResponse> | null = null;

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (!req.url.startsWith('/api/')) return next(req);
  const isPublic = NO_AUTH.some((u) => req.url.startsWith(u));

  const withToken = (r: HttpRequest<unknown>) => {
    const token = auth.token();
    return token && !isPublic ? r.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : r;
  };

  return next(withToken(req)).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse) || err.status !== 401 || isPublic || req.url.startsWith('/api/v1/auth/logout')) {
        return throwError(() => err);
      }
      if (!auth.tokens()?.refreshToken) {
        auth.clear();
        void router.navigate(['/login']);
        return throwError(() => err);
      }
      if (!refreshInFlight) {
        refreshInFlight = auth.refresh().pipe(
          shareReplay(1),
          finalize(() => (refreshInFlight = null)),
        );
      }
      return refreshInFlight.pipe(
        switchMap(() => next(withToken(req))),
        catchError((refreshErr: unknown) => {
          auth.clear();
          void router.navigate(['/login']);
          return throwError(() => refreshErr);
        }),
      );
    }),
  );
};
