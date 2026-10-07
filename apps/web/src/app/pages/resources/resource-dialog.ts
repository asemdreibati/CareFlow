import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { ResourcesApi } from '../../core/api/resources.api';
import { clean, clearedToNull } from '../../core/api/http-utils';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { RESOURCE_TYPES, Resource, ResourceType } from '../../core/models';
import { DialogComponent } from '../../shared/dialog';

const PALETTE = ['#0f766e', '#2563eb', '#7c3aed', '#d97706', '#dc2626', '#16a34a', '#0891b2', '#db2777', '#6b7280'];

@Component({
  selector: 'cf-resource-dialog',
  imports: [FormsModule, TranslatePipe, DialogComponent],
  template: `
    <cf-dialog [title]="(resource() ? 'resources.edit' : 'resources.new') | translate" [width]="480" (closed)="closed.emit()">
      @if (error()) { <div class="inline-alert error">{{ error() }}</div> }
      <div class="form-grid">
        <div class="field span-2"><label class="req">{{ 'common.name' | translate }}</label><input class="input" [(ngModel)]="name" [placeholder]="'resources.namePlaceholder' | translate" autofocus /></div>
        <div class="field"><label class="req">{{ 'common.type' | translate }}</label>
          <select class="input" [(ngModel)]="type">@for (t of types; track t) { <option [value]="t">{{ lang.enumLabel(t, 'resourceType') }}</option> }</select>
        </div>
        <div class="field"><label>{{ 'doctors.color' | translate }}</label>
          <div class="row gap-1 wrap">
            @for (c of palette; track c) { <button type="button" class="sw" [class.on]="color === c" [style.background]="c" (click)="color = c" [attr.aria-label]="c"></button> }
            <input type="color" [(ngModel)]="color" style="width: 36px; height: 28px; padding: 0; border: 1px solid var(--cf-border-strong); border-radius: 6px; background: none" />
          </div>
        </div>
        <div class="field span-2"><label>{{ 'common.notes' | translate }}</label><textarea class="input" rows="2" [(ngModel)]="notes"></textarea></div>
        @if (resource()) { <div class="field span-2"><label class="checkbox"><input type="checkbox" [(ngModel)]="isActive" /> {{ 'resources.activeBookable' | translate }}</label></div> }
      </div>
      <div footer>
        <button type="button" class="btn" (click)="closed.emit()">{{ 'common.cancel' | translate }}</button>
        <button type="button" class="btn primary" (click)="save()" [disabled]="saving() || !name.trim()">{{ (saving() ? 'common.saving' : resource() ? 'common.save' : 'common.create') | translate }}</button>
      </div>
    </cf-dialog>
  `,
  styles: [`.sw { width: 24px; height: 24px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; } .sw.on { border-color: var(--cf-text); box-shadow: 0 0 0 2px #fff inset; }`],
})
export class ResourceDialogComponent {
  private readonly api = inject(ResourcesApi);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);
  readonly resource = input<Resource | null>(null);
  readonly closed = output<void>();
  readonly saved = output<Resource>();
  readonly types = RESOURCE_TYPES;
  readonly palette = PALETTE;
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  name = ''; type: ResourceType = 'ROOM'; color = PALETTE[0]; notes = ''; isActive = true;

  ngOnInit() {
    const r = this.resource();
    if (r) { this.name = r.name; this.type = r.type; this.color = r.color || PALETTE[0]; this.notes = r.notes ?? ''; this.isActive = r.isActive; }
  }
  save() {
    if (!this.name.trim()) return;
    this.saving.set(true); this.error.set(null);
    const r = this.resource();
    const dto = clean({ name: this.name.trim(), type: this.type, color: this.color, notes: this.notes.trim(), isActive: r ? this.isActive : undefined });
    // Edit: emptied notes are sent as null so the API clears them (create keeps omitting them).
    const req = r
      ? this.api.update(r.id, { ...dto, ...clearedToNull({ notes: this.notes }, r, ['notes'] as const) })
      : this.api.create(dto as { name: string; type: ResourceType; color?: string; notes?: string });
    req.subscribe({
      next: (res) => { this.saving.set(false); this.toast.success(this.lang.t(r ? 'resources.updated' : 'resources.created')); this.saved.emit(res); },
      error: (err) => { this.saving.set(false); this.error.set(this.lang.errorMessage(err)); },
    });
  }
}
