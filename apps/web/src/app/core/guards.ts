import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { LanguageService } from './i18n/language.service';

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isAuthenticated()) return true;
  return router.createUrlTree(['/login'], { queryParams: { redirect: state.url } });
};

export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isAuthenticated() ? router.createUrlTree(['/dashboard']) : true;
};

/** Requires every listed permission. */
export function permissionGuard(...perms: string[]): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    const toast = inject(ToastService);
    const lang = inject(LanguageService);
    if (auth.hasPermission(...perms)) return true;
    toast.error(lang.t('errors.noPagePermission'));
    return router.createUrlTree(['/dashboard']);
  };
}
