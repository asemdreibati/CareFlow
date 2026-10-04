import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { offerCountdown } from '../core/scheduling/offer-countdown';

/** Live countdown chip to a deadline (waitlist offer expiry). Ticks every second. */
@Component({
  selector: 'cf-countdown',
  template: `<span class="chip" [class]="'chip ' + color()"><span class="dot"></span>{{ prefix() }}{{ view().label }}</span>`,
})
export class CountdownComponent {
  readonly until = input.required<string | null | undefined>();
  readonly prefix = input('');
  private readonly now = signal(Date.now());
  readonly view = computed(() => offerCountdown(this.until(), this.now()));
  readonly color = computed(() => (this.view().expired ? 'gray' : this.view().urgent ? 'red' : 'amber'));
  constructor() {
    const t = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }
}
