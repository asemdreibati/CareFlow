import { Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { offerCountdown } from '../../core/scheduling/offer-countdown';
import { ToastService } from '../../core/toast.service';
import { PortalApi } from '../portal-api.service';
import { useFormat } from '../portal-ui';
import { PortalWaitlistEntry } from '../portal.models';

/** Amber banner for an OFFERED waitlist entry: live countdown + accept / decline. */
@Component({
  selector: 'cf-portal-offer',
  imports: [TranslatePipe],
  template: `
    <div class="pt-card warn pt-fade" style="margin-bottom:12px">
      <div class="pt-row between">
        <div class="pt-strong">{{ 'portal.home.offers' | translate }}</div>
        <span class="chip" [class]="'chip ' + (view().urgent ? 'red' : 'amber')"><span class="dot"></span>{{ 'portal.home.expiresIn' | translate }} <span class="pt-countdown">{{ view().label }}</span></span>
      </div>
      <p style="margin:8px 0 0;font-size:14px">{{ 'portal.home.offerText' | translate: { doctor: f.doctor(entry().offeredAppointment?.doctor || entry().doctor), when: f.dateTime(entry().offeredAppointment?.startsAt) } }}</p>
      <div class="pt-actions">
        <button type="button" class="pt-btn primary" (click)="act('accept')" [disabled]="busy()">{{ 'portal.home.accept' | translate }}</button>
        <button type="button" class="pt-btn" (click)="act('decline')" [disabled]="busy()">{{ 'portal.home.decline' | translate }}</button>
      </div>
    </div>
  `,
})
export class WaitlistOfferCard {
  readonly entry = input.required<PortalWaitlistEntry>();
  readonly changed = output<void>();
  readonly f = useFormat();
  private readonly api = inject(PortalApi);
  private readonly toast = inject(ToastService);
  private readonly now = signal(Date.now());
  readonly view = computed(() => {
    const c = offerCountdown(this.entry().offerExpiresAt, this.now());
    return { ...c, label: c.expired ? this.f.lang.t('portal.common.expired') : c.label };
  });
  readonly busy = signal(false);

  constructor() {
    const t = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  act(kind: 'accept' | 'decline') {
    this.busy.set(true);
    const call = kind === 'accept' ? this.api.acceptOffer(this.entry().id) : this.api.declineOffer(this.entry().id);
    call.subscribe({
      next: () => { this.busy.set(false); this.toast.success(this.f.lang.t(kind === 'accept' ? 'portal.waitlist.accepted' : 'portal.waitlist.declined')); this.changed.emit(); },
      error: (err: unknown) => { this.busy.set(false); this.toast.fromError(err, this.f.lang.t('portal.errors.generic')); this.changed.emit(); },
    });
  }
}
