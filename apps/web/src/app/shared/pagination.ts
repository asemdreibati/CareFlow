import { Component, computed, inject, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService } from '../core/i18n/language.service';

@Component({
  selector: 'cf-pagination',
  imports: [TranslatePipe],
  template: `
    <div class="pg">
      <span class="muted small">{{ rangeLabel() }}</span>
      <div class="row gap-1">
        <button type="button" class="btn sm" [disabled]="page() <= 1" (click)="pageChange.emit(page() - 1)">‹ {{ 'common.previous' | translate }}</button>
        <span class="small">{{ 'common.page' | translate: { page: page(), pages: pages() } }}</span>
        <button type="button" class="btn sm" [disabled]="page() >= pages()" (click)="pageChange.emit(page() + 1)">{{ 'common.next' | translate }} ›</button>
      </div>
    </div>
  `,
  styles: [`.pg { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-top: 1px solid var(--cf-border); gap: 12px; flex-wrap: wrap; }`],
})
export class PaginationComponent {
  private readonly lang = inject(LanguageService);
  readonly page = input(1);
  readonly pageSize = input(25);
  readonly total = input(0);
  readonly pageChange = output<number>();
  readonly pages = computed(() => Math.max(1, Math.ceil(this.total() / Math.max(1, this.pageSize()))));
  readonly rangeLabel = computed(() => {
    if (!this.total()) return this.lang.t('common.noResults');
    const start = (this.page() - 1) * this.pageSize() + 1;
    const end = Math.min(this.total(), this.page() * this.pageSize());
    return this.lang.t('common.range', { start, end, total: this.total() });
  });
}
