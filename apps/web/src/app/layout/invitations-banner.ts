import { Component, computed, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../core/auth.service';
import { LanguageService } from '../core/i18n/language.service';
import { ToastService } from '../core/toast.service';
import type { ClinicInvitation } from '../core/models';

/**
 * Shows pending invitations from other clinics. An existing account is never added to a
 * clinic without the account holder's consent: they accept or decline here.
 */
@Component({
  selector: 'cf-invitations-banner',
  imports: [TranslatePipe],
  template: `
    @for (inv of invitations(); track inv.id) {
      <div class="invite" role="status">
        <span class="text">
          {{ 'invitations.message' | translate: { clinic: inv.clinic.name, role: lang.enumLabel(inv.role, 'role') } }}
        </span>
        <span class="actions">
          <button class="btn btn-primary btn-sm" [disabled]="busy() === inv.id" (click)="respond(inv, 'accept')">
            {{ 'invitations.accept' | translate }}
          </button>
          <button class="btn btn-sm" [disabled]="busy() === inv.id" (click)="respond(inv, 'decline')">
            {{ 'invitations.decline' | translate }}
          </button>
        </span>
      </div>
    }
  `,
  styles: [`
    .invite { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem;
      margin-block-end: 1rem; padding: .75rem 1rem; border-radius: 10px;
      background: var(--cf-info-bg, #eff6ff); border: 1px solid var(--cf-info-border, #bfdbfe); }
    .actions { display: flex; gap: .5rem; }
  `],
})
export class InvitationsBannerComponent {
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);
  readonly busy = signal<string | null>(null);
  readonly invitations = computed<ClinicInvitation[]>(() => this.auth.session()?.invitations ?? []);

  respond(inv: ClinicInvitation, decision: 'accept' | 'decline'): void {
    this.busy.set(inv.id);
    this.auth.respondToInvitation(inv.id, decision).subscribe({
      next: () => {
        this.busy.set(null);
        this.toast.success(this.lang.t(decision === 'accept' ? 'invitations.accepted' : 'invitations.declined', { clinic: inv.clinic.name }));
      },
      error: (e) => {
        this.busy.set(null);
        this.toast.fromError(e);
      },
    });
  }
}
