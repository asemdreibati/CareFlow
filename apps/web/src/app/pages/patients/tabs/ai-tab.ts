import { Component, inject, input, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { AiApi } from '../../../core/api/ai.api';
import { AuthService } from '../../../core/auth.service';
import { ToastService } from '../../../core/toast.service';
import { LanguageService } from '../../../core/i18n/language.service';
import { AiInteraction, Patient } from '../../../core/models';
import { StatusChipComponent } from '../../../shared/status-chip';
import { MarkdownComponent } from '../../../shared/markdown';

@Component({
  selector: 'cf-patient-ai',
  imports: [TranslatePipe, StatusChipComponent, MarkdownComponent],
  template: `
    @if (enabled() === false) {
      <div class="inline-alert info">{{ 'ai.disabled' | translate }}</div>
    }
    <div class="grid grid-2">
      <div class="card">
        <div class="card-header">
          <h3>{{ 'ai.previsitSummary' | translate }}</h3>
          @if (canUse) { <button type="button" class="btn sm primary" (click)="generate()" [disabled]="generating() || enabled() === false">{{ (generating() ? 'ai.generating' : 'ai.generateSummary') | translate }}</button> }
        </div>
        <div class="card-body">
          @if (current(); as c) {
            <div class="row between mb-1"><cf-chip [status]="c.status" group="status" /><span class="subtle">{{ c.provider }} · {{ c.model }} · {{ lang.formatDateTime(c.createdAt) }}</span></div>
            @if (c.status === 'FAILED') { <div class="inline-alert error">{{ c.error || ('ai.generationFailed' | translate) }}</div> }
            <cf-markdown [source]="c.output" />
            @if (c.status === 'GENERATED' && canReview) {
              <div class="row end mt-2">
                <button type="button" class="btn danger-outline sm" (click)="review(c, 'REJECTED')" [disabled]="reviewing()">{{ 'ai.reject' | translate }}</button>
                <button type="button" class="btn success sm" (click)="review(c, 'APPROVED')" [disabled]="reviewing()">{{ 'ai.approve' | translate }}</button>
              </div>
            }
          } @else {
            <div class="muted">{{ 'ai.noSummary' | translate }}</div>
          }
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>{{ 'ai.history' | translate }}</h3></div>
        <div class="card-body">
          @if (historyError()) { <div class="muted">{{ historyError() }}</div> }
          @for (h of history(); track h.id) {
            <button type="button" class="list-item hist" (click)="current.set(h)">
              <div class="flex-1"><div class="strong">{{ lang.formatDateTime(h.createdAt) }}</div><div class="subtle">{{ h.model }}@if (h.latencyMs) { · {{ h.latencyMs }} ms }</div></div>
              <cf-chip [status]="h.status" group="status" />
            </button>
          } @empty { @if (!historyError()) { <div class="muted">{{ 'ai.noPrevious' | translate }}</div> } }
        </div>
      </div>
    </div>
  `,
  styles: [`.hist { width: 100%; background: none; border: none; border-bottom: 1px solid var(--cf-border); font: inherit; cursor: pointer; text-align: start; } .hist:hover { background: var(--cf-surface-2); }`],
})
export class PatientAiTab {
  private readonly api = inject(AiApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);
  readonly p = input.required<Patient>({ alias: 'patient' });
  readonly canUse = this.auth.hasPermission('ai:use');
  readonly canReview = this.auth.hasPermission('ai:review');
  readonly enabled = signal<boolean | null>(null);
  readonly current = signal<AiInteraction | null>(null);
  readonly history = signal<AiInteraction[]>([]);
  readonly historyError = signal<string | null>(null);
  readonly generating = signal(false);
  readonly reviewing = signal(false);

  ngOnInit() {
    this.api.status().subscribe({ next: (s) => this.enabled.set(s.enabled), error: () => this.enabled.set(false) });
    this.loadHistory();
  }
  loadHistory() {
    this.api.interactions({ patientId: this.p().id, feature: 'PATIENT_SUMMARY' }).subscribe({
      next: (h) => { this.history.set(h); if (!this.current() && h.length) this.current.set(h[0]); },
      error: (err) => this.historyError.set(this.lang.errorMessage(err, this.lang.t('ai.historyUnavailable'))),
    });
  }
  generate() {
    this.generating.set(true);
    this.api.patientSummary(this.p().id).subscribe({
      next: (i) => { this.generating.set(false); this.current.set(i); this.loadHistory(); },
      error: (err) => { this.generating.set(false); this.toast.fromError(err); },
    });
  }
  review(i: AiInteraction, decision: 'APPROVED' | 'REJECTED') {
    this.reviewing.set(true);
    this.api.review(i.id, decision).subscribe({
      next: (r) => { this.reviewing.set(false); this.current.set({ ...i, ...r }); this.toast.success(this.lang.t(decision === 'APPROVED' ? 'ai.summaryApproved' : 'ai.summaryRejected')); this.loadHistory(); },
      error: (err) => { this.reviewing.set(false); this.toast.fromError(err); },
    });
  }
}
