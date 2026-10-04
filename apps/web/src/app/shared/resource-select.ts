import { Component, computed, inject, input, output, signal } from '@angular/core';
import { ResourcesApi } from '../core/api/resources.api';
import { Resource } from '../core/models';
import { errorMessage } from '../core/toast.service';

/**
 * Multi-select of clinic resources (rooms, equipment…) rendered as toggle chips.
 * Loads the catalogue itself; degrades to a hint when the endpoint is missing.
 */
@Component({
  selector: 'cf-resource-select',
  template: `
    @if (loading()) { <div class="muted small">Loading resources…</div> }
    @else if (error()) { <div class="subtle">{{ error() }}</div> }
    @else if (!resources().length) { <div class="muted small">{{ emptyText() }}</div> }
    @else {
      <div class="rs">
        @for (r of resources(); track r.id) {
          <button type="button" class="rs-chip" [class.on]="isOn(r.id)" [disabled]="disabled()" (click)="toggle(r.id)" [attr.aria-pressed]="isOn(r.id)">
            <span class="pill-color" [style.background]="r.color || '#6b7280'"></span>{{ r.name }}<span class="subtle">{{ r.type.toLowerCase() }}</span>
          </button>
        }
      </div>
    }
  `,
  styles: [`
    .rs { display: flex; flex-wrap: wrap; gap: 6px; }
    .rs-chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--cf-border-strong); background: var(--cf-surface); font: inherit; font-size: 12.5px; cursor: pointer; }
    .rs-chip:hover:not(:disabled) { background: var(--cf-surface-2); }
    .rs-chip.on { background: var(--cf-primary-soft); border-color: var(--cf-primary); color: #115e59; font-weight: 600; }
    .rs-chip:disabled { opacity: 0.55; cursor: not-allowed; }
  `],
})
export class ResourceSelectComponent {
  private readonly api = inject(ResourcesApi);
  readonly selected = input<string[]>([]);
  readonly disabled = input(false);
  readonly emptyText = input('No resources defined yet.');
  readonly selectedChange = output<string[]>();
  readonly resources = signal<Resource[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly set = computed(() => new Set(this.selected()));

  constructor() {
    this.api.list().subscribe({
      next: (r) => { this.resources.set(r.filter((x) => x.isActive !== false)); this.loading.set(false); },
      error: (err) => { this.loading.set(false); this.error.set(`Resources unavailable: ${errorMessage(err)}`); },
    });
  }
  isOn(id: string) { return this.set().has(id); }
  toggle(id: string) {
    const next = this.isOn(id) ? this.selected().filter((x) => x !== id) : [...this.selected(), id];
    this.selectedChange.emit(next);
  }
}
