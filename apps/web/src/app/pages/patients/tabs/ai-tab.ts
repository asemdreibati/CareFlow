import { Component, inject, input, signal } from '@angular/core';
import { AiApi } from '../../../core/api/ai.api';
import { AuthService } from '../../../core/auth.service';
import { ToastService, errorMessage } from '../../../core/toast.service';
import { AiInteraction, Patient } from '../../../core/models';
import { fmtDateTime } from '../../../core/date-utils';
import { StatusChipComponent } from '../../../shared/status-chip';
import { MarkdownComponent } from '../../../shared/markdown';

@Component({
  selector: 'cf-patient-ai',
  imports: [StatusChipComponent, MarkdownComponent],
  template: `
    @if (enabled() === false) {
      <div class="inline-alert info">AI features are disabled for this deployment.</div>
    }
    <div class="grid grid-2">
      <div class="card">
        <div class="card-header">
          <h3>Pre-visit summary</h3>
          @if (canUse) { <button type="button" class="btn sm primary" (click)="generate()" [disabled]="generating() || enabled() === false">{{ generating() ? 'Generating…' : 'Generate pre-visit summary' }}</button> }
        </div>
        <div class="card-body">
          @if (current(); as c) {
            <div class="row between mb-1"><cf-chip [status]="c.status" /><span class="subtle">{{ c.provider }} · {{ c.model }} · {{ fmt(c.createdAt) }}</span></div>
            @if (c.status === 'FAILED') { <div class="inline-alert error">{{ c.error || 'Generation failed' }}</div> }
            <cf-markdown [source]="c.output" />
            @if (c.status === 'GENERATED' && canReview) {
              <div class="row end mt-2">
                <button type="button" class="btn danger-outline sm" (click)="review(c, 'REJECTED')" [disabled]="reviewing()">Reject</button>
                <button type="button" class="btn success sm" (click)="review(c, 'APPROVED')" [disabled]="reviewing()">Approve</button>
              </div>
            }
          } @else {
            <div class="muted">No summary generated yet. The AI drafts a briefing from the patient's history; a clinician must approve it. Direct identifiers are stripped before leaving the system.</div>
          }
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>History</h3></div>
        <div class="card-body">
          @if (historyError()) { <div class="muted">{{ historyError() }}</div> }
          @for (h of history(); track h.id) {
            <button type="button" class="list-item hist" (click)="current.set(h)">
              <div class="flex-1"><div class="strong">{{ fmt(h.createdAt) }}</div><div class="subtle">{{ h.model }}@if (h.latencyMs) { · {{ h.latencyMs }} ms }</div></div>
              <cf-chip [status]="h.status" />
            </button>
          } @empty { @if (!historyError()) { <div class="muted">No previous summaries.</div> } }
        </div>
      </div>
    </div>
  `,
  styles: [`.hist { width: 100%; background: none; border: none; border-bottom: 1px solid var(--cf-border); font: inherit; cursor: pointer; text-align: left; } .hist:hover { background: var(--cf-surface-2); }`],
})
export class PatientAiTab {
  private readonly api = inject(AiApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly p = input.required<Patient>({ alias: 'patient' });
  readonly fmt = fmtDateTime;
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
      error: (err) => this.historyError.set(errorMessage(err, 'History unavailable')),
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
      next: (r) => { this.reviewing.set(false); this.current.set({ ...i, ...r }); this.toast.success(`Summary ${decision.toLowerCase()}`); this.loadHistory(); },
      error: (err) => { this.reviewing.set(false); this.toast.fromError(err); },
    });
  }
}
