import { Component, ElementRef, HostListener, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../core/auth.service';
import { LanguageService } from '../core/i18n/language.service';

@Component({
  selector: 'cf-user-menu',
  imports: [RouterLink, TranslatePipe],
  template: `
    <div class="um">
      <button type="button" class="trigger" (click)="open.set(!open())">
        <span class="avatar">{{ initials() }}</span>
        <span class="name">{{ auth.user()?.firstName }} {{ auth.user()?.lastName }}</span>
      </button>
      @if (open()) {
        <div class="dropdown">
          <div class="info"><div class="strong">{{ auth.user()?.firstName }} {{ auth.user()?.lastName }}</div><div class="subtle">{{ auth.user()?.email }} · {{ lang.enumLabel(auth.role(), 'role') }}</div></div>
          <a class="item" routerLink="/settings" [queryParams]="{ tab: 'password' }" (click)="open.set(false)">{{ 'settings.changePassword' | translate }}</a>
          <button type="button" class="item danger-text" (click)="auth.logout()">{{ 'common.logout' | translate }}</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .um { position: relative; }
    .trigger { display: flex; align-items: center; gap: 8px; background: none; border: none; font: inherit; cursor: pointer; padding: 4px 6px; border-radius: 8px; }
    .trigger:hover { background: var(--cf-surface-2); }
    .name { font-weight: 500; }
    .info { padding: 8px 10px; border-bottom: 1px solid var(--cf-border); margin-bottom: 4px; }
    a.item:hover { text-decoration: none; }
    @media (max-width: 640px) { .name { display: none; } }
  `],
})
export class UserMenuComponent {
  readonly auth = inject(AuthService);
  readonly lang = inject(LanguageService);
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly open = signal(false);
  readonly initials = computed(() => {
    const u = this.auth.user();
    return u ? `${u.firstName?.[0] ?? ''}${u.lastName?.[0] ?? ''}`.toUpperCase() : '?';
  });
  @HostListener('document:click', ['$event']) onDoc(e: Event) {
    if (!this.host.nativeElement.contains(e.target as Node)) this.open.set(false);
  }
}
