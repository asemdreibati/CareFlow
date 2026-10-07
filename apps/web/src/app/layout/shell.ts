import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';
import { LanguageService } from '../core/i18n/language.service';
import { NotificationsBellComponent } from './notifications-bell';
import { UserMenuComponent } from './user-menu';
import { LanguageSwitcherComponent } from '../shared/language-switcher';

/** `label`/`group` are `nav.*` translation keys. */
interface NavItem { label: string; path: string; icon: string; perms?: string[]; any?: boolean; group?: string; }
interface NavGroup { label: string | null; items: NavItem[]; }

const NAV: NavItem[] = [
  { label: 'nav.dashboard', path: '/dashboard', icon: '▦' },
  { label: 'nav.calendar', path: '/calendar', icon: '▤', perms: ['appointments:read'] },
  { label: 'nav.patients', path: '/patients', icon: '☺', perms: ['patients:read'] },
  { label: 'nav.doctors', path: '/doctors', icon: '✚', perms: ['doctors:read'] },
  { label: 'nav.billing', path: '/billing', icon: '▭', perms: ['billing:read'] },
  { label: 'nav.waitlist', path: '/waitlist', icon: '⌛', perms: ['appointments:read'], group: 'nav.scheduling' },
  { label: 'nav.resources', path: '/resources', icon: '⌂', perms: ['doctors:read'], group: 'nav.scheduling' },
  { label: 'nav.proposals', path: '/scheduling/proposals', icon: '⇄', perms: ['scheduling:manage'], group: 'nav.scheduling' },
  { label: 'nav.members', path: '/members', icon: '☷', perms: ['members:read'], group: 'nav.administration' },
  { label: 'nav.audit', path: '/audit', icon: '≡', perms: ['audit:read'], group: 'nav.administration' },
  { label: 'nav.settings', path: '/settings', icon: '⚙', group: 'nav.administration' },
];

@Component({
  selector: 'cf-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslatePipe, NotificationsBellComponent, UserMenuComponent, LanguageSwitcherComponent],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class ShellComponent {
  readonly auth = inject(AuthService);
  readonly lang = inject(LanguageService);
  private readonly toast = inject(ToastService);
  readonly sidebarOpen = signal(false);
  readonly switching = signal(false);
  readonly nav = computed(() => NAV.filter((n) => !n.perms || this.auth.hasPermission(...n.perms)));
  /** Visible items grouped in declaration order; a group with no visible item is omitted. */
  readonly groups = computed<NavGroup[]>(() => {
    const out: NavGroup[] = [];
    for (const item of this.nav()) {
      const label = item.group ?? null;
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(item); else out.push({ label, items: [item] });
    }
    return out;
  });
  readonly clinics = computed(() => this.auth.session()?.clinics ?? []);

  switchClinic(e: Event) {
    const id = (e.target as HTMLSelectElement).value;
    if (!id || id === this.auth.clinic()?.id) return;
    this.switching.set(true);
    this.auth.switchClinic(id).subscribe({
      next: (r) => { this.switching.set(false); this.toast.success(this.lang.t('app.switchedTo', { name: r.session.clinic.name })); location.assign('/dashboard'); },
      error: (err) => { this.switching.set(false); this.toast.fromError(err); },
    });
  }
}
