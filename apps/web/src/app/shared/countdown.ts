import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { offerCountdown } from '../core/scheduling/offer-countdown';
import { LanguageService } from '../core/i18n/language.service';

/** Live countdown chip to a deadline (waitlist offer expiry). Ticks every second. */
@Component({
  selector: 'cf-countdown',
  template: `<span class="chip" [class]="'chip ' + color()"><span class="dot"></span>{{ prefix() }}{{ label() }}</span>`,
})
export class CountdownComponent {
  private readonly lang = inject(LanguageService);
  readonly until = input.required<string | null | undefined>();
  readonly prefix = input('');
  private readonly now = signal(Date.now());
  readonly view = computed(() => offerCountdown(this.until(), this.now()));
  readonly color = computed(() => (this.view().expired ? 'gray' : this.view().urgent ? 'red' : 'amber'));
  readonly label = computed(() => {
    const v = this.view();
    if (!this.until() || v.label === '—') return '—';
    return v.expired ? this.lang.t('common.expired') : this.lang.formatRemaining(v.ms);
  });
  constructor() {
    const t = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }
}
