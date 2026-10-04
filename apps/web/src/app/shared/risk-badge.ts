import { Component, computed, input } from '@angular/core';
import { riskView } from '../core/scheduling/risk';

/**
 * No-show risk badge. Renders nothing below the "at risk" threshold unless `showLow` is set.
 * ≥0.5 → amber "At risk · 62%", ≥0.75 → red "High risk · 81%".
 */
@Component({
  selector: 'cf-risk-badge',
  template: `
    @if (visible()) {
      <span class="chip" [class]="'chip ' + v().color" [title]="'Predicted no-show probability ' + v().percent + '%'">
        <span class="dot"></span>{{ v().label }}@if (v().percent !== null) { <span class="pct">· {{ v().percent }}%</span> }
      </span>
    }
  `,
  styles: [`.pct { font-weight: 500; opacity: 0.85; margin-left: 2px; }`],
})
export class RiskBadgeComponent {
  readonly risk = input<number | null | undefined>(null);
  readonly showLow = input(false);
  readonly v = computed(() => riskView(this.risk()));
  readonly visible = computed(() => this.v().level === 'high' || this.v().level === 'medium' || (this.showLow() && this.v().level === 'low'));
}
