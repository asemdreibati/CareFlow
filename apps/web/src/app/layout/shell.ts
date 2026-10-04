import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { ToastService } from '../core/toast.service';
import { NotificationsBellComponent } from './notifications-bell';
import { UserMenuComponent } from './user-menu';

interface NavItem { label: string; path: string; icon: string; perms?: string[]; any?: boolean; group?: string; }
interface NavGroup { label: string | null; items: NavItem[]; }

const NAV: NavItem[] = [
  { label: 'Dashboard', path: '/dashboard', icon: '▦' },
  { label: 'Calendar', path: '/calendar', icon: '▤', perms: ['appointments:read'] },
  { label: 'Patients', path: '/patients', icon: '☺', perms: ['patients:read'] },
  { label: 'Doctors', path: '/doctors', icon: '✚', perms: ['doctors:read'] },
  { label: 'Billing', path: '/billing', icon: '▭', perms: ['billing:read'] },
  { label: 'Waitlist', path: '/waitlist', icon: '⌛', perms: ['appointments:read'], group: 'Scheduling' },
  { label: 'Resources', path: '/resources', icon: '⌂', perms: ['doctors:read'], group: 'Scheduling' },
  { label: 'Proposals', path: '/scheduling/proposals', icon: '⇄', perms: ['scheduling:manage'], group: 'Scheduling' },
  { label: 'Members', path: '/members', icon: '☷', perms: ['members:read'], group: 'Administration' },
  { label: 'Audit', path: '/audit', icon: '≡', perms: ['audit:read'], group: 'Administration' },
  { label: 'Settings', path: '/settings', icon: '⚙', group: 'Administration' },
];

@Component({
  selector: 'cf-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NotificationsBellComponent, UserMenuComponent],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class ShellComponent {
  readonly auth = inject(AuthService);
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
      next: (r) => { this.switching.set(false); this.toast.success(`Switched to ${r.session.clinic.name}`); location.assign('/dashboard'); },
      error: (err) => { this.switching.set(false); this.toast.fromError(err); },
    });
  }
}
