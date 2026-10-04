import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { MembersApi } from '../../core/api/members.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { Member, PermissionsCatalog, ROLES, Role } from '../../core/models';
import { fmtDateTime } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { DialogComponent } from '../../shared/dialog';

@Component({
  selector: 'cf-members',
  imports: [FormsModule, NgTemplateOutlet, PageHeaderComponent, StatusChipComponent, DialogComponent],
  template: `
    <div class="page">
      <cf-page-header title="Members" subtitle="Staff accounts and roles">
        @if (canManage) { <button type="button" class="btn primary" (click)="openInvite()">+ Invite member</button> }
      </cf-page-header>
      <div class="card">
        @if (loading()) { <div class="loading"><span class="spinner"></span> Loading…</div> }
        @else {
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Extra permissions</th><th>Last login</th><th>Status</th><th></th></tr></thead>
              <tbody>
                @for (m of members(); track m.id) {
                  <tr>
                    <td><span class="row gap-1"><span class="avatar">{{ m.user.firstName[0] }}{{ m.user.lastName[0] }}</span><span class="strong">{{ m.user.firstName }} {{ m.user.lastName }}</span>@if (m.user.id === myId) { <span class="subtle">(you)</span> }</span></td>
                    <td class="muted">{{ m.user.email }}</td>
                    <td><cf-chip [status]="m.role" /></td>
                    <td>@for (p of m.extraPermissions; track p) { <span class="chip gray">{{ p }}</span> } @empty { <span class="muted">—</span> }</td>
                    <td class="muted nowrap">{{ m.user.lastLoginAt ? fmt(m.user.lastLoginAt) : 'Never' }}</td>
                    <td><cf-chip [status]="m.isActive" /></td>
                    <td class="actions">@if (canManage && m.user.id !== myId) { <button type="button" class="btn xs" (click)="openEdit(m)">Edit</button> }</td>
                  </tr>
                } @empty { <tr><td colspan="7" class="empty">No members.</td></tr> }
              </tbody>
            </table>
          </div>
        }
      </div>
    </div>

    @if (dialog() === 'invite') {
      <cf-dialog title="Invite member" [width]="560" (closed)="dialog.set(null)">
        <div class="form-grid">
          <div class="field"><label class="req">First name</label><input class="input" [(ngModel)]="invite.firstName" /></div>
          <div class="field"><label class="req">Last name</label><input class="input" [(ngModel)]="invite.lastName" /></div>
          <div class="field span-2"><label class="req">Email</label><input class="input" type="email" [(ngModel)]="invite.email" /></div>
          <div class="field"><label class="req">Role</label><select class="input" [(ngModel)]="invite.role">@for (r of roles; track r) { <option [value]="r">{{ r }}</option> }</select></div>
          <div class="field"><label class="req">Initial password</label><input class="input" type="text" [(ngModel)]="invite.password" placeholder="Min 10 chars, 1 uppercase, 1 digit" /></div>
        </div>
        <ng-container *ngTemplateOutlet="permsTpl; context: { role: invite.role, selected: invite.extraPermissions }" />
        <div footer>
          <button type="button" class="btn" (click)="dialog.set(null)">Cancel</button>
          <button type="button" class="btn primary" (click)="submitInvite()" [disabled]="saving() || !invite.email || !invite.firstName || !invite.lastName || !invite.password">{{ saving() ? 'Inviting…' : 'Invite' }}</button>
        </div>
      </cf-dialog>
    }
    @if (dialog() === 'edit' && editing) {
      <cf-dialog [title]="'Edit ' + editing.user.firstName + ' ' + editing.user.lastName" [width]="560" (closed)="dialog.set(null)">
        <div class="form-grid">
          <div class="field"><label>Role</label><select class="input" [(ngModel)]="edit.role">@for (r of roles; track r) { <option [value]="r">{{ r }}</option> }</select></div>
          <div class="field"><label>Status</label><label class="checkbox" style="height: 36px"><input type="checkbox" [(ngModel)]="edit.isActive" /> Active (can sign in)</label></div>
        </div>
        <ng-container *ngTemplateOutlet="permsTpl; context: { role: edit.role, selected: edit.extraPermissions }" />
        <div footer>
          <button type="button" class="btn" (click)="dialog.set(null)">Cancel</button>
          <button type="button" class="btn primary" (click)="submitEdit()" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save' }}</button>
        </div>
      </cf-dialog>
    }

    <ng-template #permsTpl let-role="role" let-selected="selected">
      <div class="label-text mb-1">Extra permissions <span class="subtle">(beyond the {{ role }} defaults)</span></div>
      <div class="perms">
        @for (p of catalog()?.all ?? []; track p) {
          @if (!byRole(role).has(p)) {
            <label class="checkbox small"><input type="checkbox" [checked]="selected.includes(p)" (change)="toggle(selected, p)" /> {{ p }}</label>
          }
        }
      </div>
      @if (!catalog()) { <div class="subtle">Loading permission catalog…</div> }
    </ng-template>
  `,
  styles: [`.perms { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 12px; max-height: 200px; overflow-y: auto; padding: 8px; background: var(--cf-surface-2); border-radius: 6px; }`],
})
export class MembersPage {
  private readonly api = inject(MembersApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly fmt = fmtDateTime;
  readonly roles = ROLES;
  readonly canManage = this.auth.hasPermission('members:manage');
  readonly myId = this.auth.user()?.id;
  readonly members = signal<Member[]>([]);
  readonly catalog = signal<PermissionsCatalog | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly dialog = signal<'invite' | 'edit' | null>(null);
  editing: Member | null = null;
  invite = { firstName: '', lastName: '', email: '', role: 'RECEPTIONIST' as Role, password: '', extraPermissions: [] as string[] };
  edit = { role: 'RECEPTIONIST' as Role, isActive: true, extraPermissions: [] as string[] };

  constructor() {
    this.load();
    this.api.permissions().subscribe({ next: (c) => this.catalog.set(c), error: () => undefined });
  }
  load() {
    this.api.list().subscribe({ next: (m) => { this.members.set(m); this.loading.set(false); }, error: (err) => { this.loading.set(false); this.toast.fromError(err); } });
  }
  byRole(role: Role) { return new Set(this.catalog()?.byRole?.[role] ?? []); }
  toggle(list: string[], p: string) { const i = list.indexOf(p); i >= 0 ? list.splice(i, 1) : list.push(p); }
  openInvite() { this.invite = { firstName: '', lastName: '', email: '', role: 'RECEPTIONIST', password: '', extraPermissions: [] }; this.dialog.set('invite'); }
  openEdit(m: Member) { this.editing = m; this.edit = { role: m.role, isActive: m.isActive, extraPermissions: [...m.extraPermissions] }; this.dialog.set('edit'); }
  submitInvite() {
    this.saving.set(true);
    const extra = this.invite.extraPermissions.filter((p) => !this.byRole(this.invite.role).has(p));
    this.api.invite({ ...this.invite, email: this.invite.email.trim(), extraPermissions: extra.length ? extra : undefined }).subscribe({
      next: () => { this.saving.set(false); this.dialog.set(null); this.toast.success('Member invited'); this.load(); },
      error: (err) => { this.saving.set(false); this.toast.fromError(err); },
    });
  }
  submitEdit() {
    if (!this.editing) return;
    this.saving.set(true);
    const extra = this.edit.extraPermissions.filter((p) => !this.byRole(this.edit.role).has(p));
    this.api.update(this.editing.id, { role: this.edit.role, isActive: this.edit.isActive, extraPermissions: extra }).subscribe({
      next: () => { this.saving.set(false); this.dialog.set(null); this.toast.success('Member updated'); this.load(); },
      error: (err) => { this.saving.set(false); this.toast.fromError(err); },
    });
  }
}
