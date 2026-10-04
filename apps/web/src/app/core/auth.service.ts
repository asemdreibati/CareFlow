import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, tap } from 'rxjs';
import { AuthResponse, LoginDto, RegisterDto, Session, Tokens } from './models';

const TOKENS_KEY = 'cf.tokens';
const SESSION_KEY = 'cf.session';

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

  hasPermission(...perms: string[]): boolean {
    const set = this.permissions();
    return perms.every((p) => set.has(p));
  }
  hasAny(...perms: string[]): boolean {
    const set = this.permissions();
    return perms.some((p) => set.has(p));
  }

  login(dto: LoginDto): Observable<AuthResponse> {
    return this.http.post<AuthResponse>('/api/v1/auth/login', dto).pipe(tap((r) => this.apply(r)));
  }

  register(dto: RegisterDto): Observable<AuthResponse> {
    return this.http.post<AuthResponse>('/api/v1/auth/register', dto).pipe(tap((r) => this.apply(r)));
  }

  /** Rotates the refresh token. Called by the interceptor; the interceptor skips auth for this URL. */
  refresh(): Observable<AuthResponse> {
    const refreshToken = this.tokens()?.refreshToken ?? '';
    return this.http.post<AuthResponse>('/api/v1/auth/refresh', { refreshToken }).pipe(tap((r) => this.apply(r)));
  }

  switchClinic(clinicId: string): Observable<AuthResponse> {
    return this.http.post<AuthResponse>('/api/v1/auth/switch-clinic', { clinicId }).pipe(tap((r) => this.apply(r)));
  }

  me(): Observable<Session> {
    return this.http.get<Session>('/api/v1/auth/me').pipe(tap((s) => this.setSession(s)));
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
    this.tokens.set(null);
    this.session.set(null);
    try {
      localStorage.removeItem(TOKENS_KEY);
      localStorage.removeItem(SESSION_KEY);
    } catch { /* ignore */ }
  }

  private apply(r: AuthResponse) {
    this.tokens.set(r.tokens);
    this.setSession(r.session);
    try { localStorage.setItem(TOKENS_KEY, JSON.stringify(r.tokens)); } catch { /* ignore */ }
  }

  private setSession(s: Session) {
    this.session.set(s);
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }
}
