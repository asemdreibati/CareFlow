import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, defer, finalize, map, shareReplay, tap } from 'rxjs';
import { AuthResponse, LoginDto, RegisterDto, Session, Tokens } from './models';
import { setClinicTimeZoneSource } from './i18n/locale-registry';

export const TOKENS_KEY = 'cf.tokens';
export const SESSION_KEY = 'cf.session';

/** A refresh finished after the session it belonged to was ended or replaced (logout, login, clinic switch). */
export class SessionChangedError extends Error {
  constructor() { super('Session changed during token refresh'); this.name = 'SessionChangedError'; }
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  readonly tokens = signal<Tokens | null>(read<Tokens>(TOKENS_KEY));
  readonly session = signal<Session | null>(read<Session>(SESSION_KEY));

  readonly token = computed(() => this.tokens()?.accessToken ?? null);
  readonly isAuthenticated = computed(() => !!this.token());
  readonly permissions = computed(() => new Set(this.session()?.permissions ?? []));
  readonly role = computed(() => this.session()?.role ?? null);
  readonly doctorId = computed(() => this.session()?.doctorId ?? null);
  readonly clinic = computed(() => this.session()?.clinic ?? null);
  readonly user = computed(() => this.session()?.user ?? null);

  /**
   * Session generation: bumped whenever the session is ended or replaced (clear, login, register,
   * clinic switch, logout in another tab). A refresh started under an older generation is discarded,
   * so a logout during an in-flight refresh can't resurrect the session.
   */
  private generation = 0;
  /** Shared in-flight refresh so concurrent 401s (and the socket) trigger a single refresh call. */
  private refreshInFlight: Observable<AuthResponse> | null = null;

  constructor() {
    setClinicTimeZoneSource('staff', () => this.session()?.clinic?.timezone);
    // Other tabs rotate/clear the shared tokens; mirror them so this tab never replays a rotated refresh token.
    if (typeof window !== 'undefined') {
      const onStorage = (e: StorageEvent) => this.onStorage(e);
      window.addEventListener('storage', onStorage);
      inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', onStorage));
    }
  }

  hasPermission(...perms: string[]): boolean {
    const set = this.permissions();
    return perms.every((p) => set.has(p));
  }
  hasAny(...perms: string[]): boolean {
    const set = this.permissions();
    return perms.some((p) => set.has(p));
  }

  login(dto: LoginDto): Observable<AuthResponse> {
    return this.http.post<AuthResponse>('/api/v1/auth/login', dto).pipe(tap((r) => this.apply(r, true)));
  }

  register(dto: RegisterDto): Observable<AuthResponse> {
    return this.http.post<AuthResponse>('/api/v1/auth/register', dto).pipe(tap((r) => this.apply(r, true)));
  }

  /**
   * Rotates the refresh token (the interceptor skips auth for this URL). The result is discarded
   * with `SessionChangedError` when the session was ended/replaced while the call was in flight.
   */
  refresh(): Observable<AuthResponse> {
    return defer(() => {
      const gen = this.generation;
      const refreshToken = this.tokens()?.refreshToken ?? '';
      return this.http.post<AuthResponse>('/api/v1/auth/refresh', { refreshToken }).pipe(
        map((r) => {
          if (gen !== this.generation) throw new SessionChangedError();
          this.apply(r, false);
          return r;
        }),
      );
    });
  }

  /** `refresh()` deduplicated: callers arriving while one is in flight share it (interceptor + socket). */
  refreshShared(): Observable<AuthResponse> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh().pipe(
        finalize(() => (this.refreshInFlight = null)),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.refreshInFlight;
  }

  /**
   * Adopts tokens another tab wrote to storage if they differ from ours (storage events can lag
   * behind a 401). Never clears: a missing entry is handled by the `storage` event itself.
   */
  syncFromStorage(): void {
    const stored = read<Tokens>(TOKENS_KEY);
    if (stored?.accessToken && stored.accessToken !== this.token()) this.tokens.set(stored);
  }

  switchClinic(clinicId: string): Observable<AuthResponse> {
    return this.http.post<AuthResponse>('/api/v1/auth/switch-clinic', { clinicId }).pipe(tap((r) => this.apply(r, true)));
  }

  me(): Observable<Session> {
    return this.http.get<Session>('/api/v1/auth/me').pipe(tap((s) => this.setSession(s)));
  }

  /** Saves the UI language on the staff account (PATCH /auth/me); the local session is updated optimistically. */
  updateLocale(locale: 'ar' | 'en'): Observable<Session> {
    const s = this.session();
    if (s && s.user.locale !== locale) this.setSession({ ...s, user: { ...s.user, locale } });
    return this.http.patch<Session>('/api/v1/auth/me', { locale }).pipe(tap((updated) => this.setSession(updated)));
  }

  changePassword(currentPassword: string, newPassword: string) {
    return this.http.post<void>('/api/v1/auth/change-password', { currentPassword, newPassword });
  }

  logout(navigate = true): void {
    const refreshToken = this.tokens()?.refreshToken;
    if (refreshToken) {
      this.http.post('/api/v1/auth/logout', { refreshToken }).subscribe({ error: () => undefined });
    }
    this.clear();
    if (navigate) void this.router.navigate(['/login']);
  }

  /** Drop local state without calling the API (e.g. refresh failure). */
  clear(): void {
    this.generation++;
    this.tokens.set(null);
    this.session.set(null);
    try {
      localStorage.removeItem(TOKENS_KEY);
      localStorage.removeItem(SESSION_KEY);
    } catch { /* ignore */ }
  }

  private apply(r: AuthResponse, newSession: boolean) {
    if (newSession) this.generation++;
    this.tokens.set(r.tokens);
    this.setSession(r.session);
    try { localStorage.setItem(TOKENS_KEY, JSON.stringify(r.tokens)); } catch { /* ignore */ }
  }

  private setSession(s: Session) {
    this.session.set(s);
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }

  private onStorage(e: StorageEvent) {
    if (e.key === null) {
      // localStorage.clear() in another tab.
      if (this.tokens()) this.endedElsewhere();
      return;
    }
    if (e.key === TOKENS_KEY) {
      const next = parse<Tokens>(e.newValue);
      if (!next?.accessToken) { if (this.tokens()) this.endedElsewhere(); return; }
      if (next.accessToken !== this.token() || next.refreshToken !== this.tokens()?.refreshToken) this.tokens.set(next);
    } else if (e.key === SESSION_KEY) {
      const next = parse<Session>(e.newValue);
      if (next) this.session.set(next);
      else if (this.session()) this.session.set(null);
    }
  }

  /** Logged out (or session cleared) in another tab: drop local state and leave the staff area. */
  private endedElsewhere() {
    this.generation++;
    this.tokens.set(null);
    this.session.set(null);
    const url = this.router.url || '';
    if (!url.startsWith('/portal') && !url.startsWith('/login') && !url.startsWith('/register')) void this.router.navigate(['/login']);
  }
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}
