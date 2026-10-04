import { Component, computed, input, output } from '@angular/core';

@Component({
  selector: 'cf-pagination',
  template: `
    <div class="pg">
      <span class="muted small">{{ rangeLabel() }}</span>
      <div class="row gap-1">
        <button type="button" class="btn sm" [disabled]="page() <= 1" (click)="pageChange.emit(page() - 1)">‹ Prev</button>
        <span class="small">Page {{ page() }} / {{ pages() }}</span>
        <button type="button" class="btn sm" [disabled]="page() >= pages()" (click)="pageChange.emit(page() + 1)">Next ›</button>
      </div>
    </div>
  `,
  styles: [`.pg { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-top: 1px solid var(--cf-border); gap: 12px; flex-wrap: wrap; }`],
})
export class PaginationComponent {
  readonly page = input(1);
  readonly pageSize = input(25);
  readonly total = input(0);
  readonly pageChange = output<number>();
  readonly pages = computed(() => Math.max(1, Math.ceil(this.total() / Math.max(1, this.pageSize()))));
  readonly rangeLabel = computed(() => {
    if (!this.total()) return 'No results';
    const start = (this.page() - 1) * this.pageSize() + 1;
    const end = Math.min(this.total(), this.page() * this.pageSize());
    return `${start}–${end} of ${this.total()}`;
  });
}
