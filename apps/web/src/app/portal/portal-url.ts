/**
 * Pure rules for the portal HTTP layer.
 *
 * Design note: the portal token is attached by `PortalApi` itself (explicit `Authorization` header on
 * every portal request) instead of a second `HttpInterceptorFn`. Registering another interceptor would
 * require editing `app.config.ts` (owned by the staff-app agent), and providing a second `HttpClient`
 * from the portal route tree would break sharing (translate loader, interceptors). The staff
 * interceptor skips `/api/v1/portal/` URLs so it never attaches the staff token or triggers staff
 * refresh/logout for portal calls — these helpers are the single source of truth for both rules.
 */
export const PORTAL_API_BASE = '/api/v1/portal';
export const PORTAL_TOKEN_KEY = 'cf.portal.token';

/** True for any request the patient portal makes (`/api/v1/portal/...`). */
export function isPortalUrl(url: string): boolean {
  return url.includes('/api/v1/portal/');
}

/** Portal endpoints that must never carry a token (OTP request/verify). */
export function isPortalPublicUrl(url: string): boolean {
  return /\/api\/v1\/portal\/auth\/(request-otp|verify)(\?|$)/.test(url);
}

/** Header map for a portal request: bearer token (when known and the URL is not public) + extras. */
export function portalHeaders(url: string, token: string | null | undefined, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const h: Record<string, string> = {};
  if (token && isPortalUrl(url) && !isPortalPublicUrl(url)) h['Authorization'] = `Bearer ${token}`;
  for (const [k, v] of Object.entries(extra)) if (v) h[k] = v;
  return h;
}

/** Builds the portal login URL for a clinic (slug optional → generic login). */
export function portalLoginPath(clinicSlug: string | null | undefined): string[] {
  return clinicSlug ? ['/portal', clinicSlug, 'login'] : ['/portal', 'login'];
}
