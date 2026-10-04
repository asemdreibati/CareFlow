import { Component, input } from '@angular/core';

@Component({
  selector: 'cf-page-header',
  template: `
    <div class="ph">
      <div>
        <h1>{{ title() }}</h1>
        @if (subtitle()) { <div class="muted">{{ subtitle() }}</div> }
      </div>
      <div class="row wrap"><ng-content /></div>
    </div>
  `,
  styles: [`.ph { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }`],
})
export class PageHeaderComponent {
  readonly title = input.required<string>();
  readonly subtitle = input<string>();
}
