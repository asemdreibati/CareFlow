import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AiApi } from '../../core/api/ai.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { AiInteraction, Encounter } from '../../core/models';
import { StatusChipComponent } from '../../shared/status-chip';

@Component({
  selector: 'cf-encounter-ai-panel',
  imports: [FormsModule, StatusChipComponent],
  template: `
    @if (enabled() && canUse) {
      <div class="card">
        <div class="card-header"><h3>AI SOAP draft</h3><span class="subtle">Drafts never touch the record until approved</span></div>
        <div class="card-body">
          @if (!draft()) {
            <div class="field"><label>Dictation / transcript</label><textarea class="input" rows="5" [(ngModel)]="transcript" placeholder="Paste or dictate the visit summary…" [disabled]="generating()"></textarea></div>
            <div class="row end"><button type="button" class="btn primary sm" (click)="generate()" [disabled]="generating() || !transcript.trim() || !editable()">{{ generating() ? 'Drafting…' : 'Generate SOAP draft' }}</button></div>
            @if (!editable()) { <div class="subtle">The encounter is read-only; drafting is disabled.</div> }
          } @else {
            <div class="row between mb-1"><cf-chip [status]="draft()!.status" /><span class="subtle">{{ draft()!.model }}</span></div>
            @for (k of keys; track k) {
              <div class="sec"><div class="label-text">{{ k }}</div><div class="txt">{{ draft()!.structuredOutput?.[k] || '—' }}</div></div>
            }
            @if (draft()!.status === 'GENERATED') {
              <div class="row end mt-2">
                <button type="button" class="btn danger-outline sm" (click)="review('REJECTED')" [disabled]="reviewing()">Reject</button>
                @if (canReview) { <button type="button" class="btn success sm" (click)="review('APPROVED')" [disabled]="reviewing() || !editable()">Approve & apply</button> }
              </div>
            } @else { <div class="row end mt-2"><button type="button" class="btn sm" (click)="draft.set(null)">New draft</button></div> }
          }
        </div>
      </div>
    }
  `,
  styles: [`.sec { margin-bottom: 10px; } .txt { white-space: pre-line; font-size: 13.5px; background: var(--cf-surface-2); padding: 8px 10px; border-radius: 6px; margin-top: 3px; }`],
})
export class EncounterAiPanel {
  private readonly api = inject(AiApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly encounter = input.required<Encounter>();
  readonly editable = input(false);
  readonly applied = output<void>();
  readonly keys = ['subjective', 'objective', 'assessment', 'plan'] as const;
  readonly canUse = this.auth.hasPermission('ai:use');
  readonly canReview = this.auth.hasPermission('ai:review');
  readonly enabled = signal(false);
  readonly generating = signal(false);
  readonly reviewing = signal(false);
  readonly draft = signal<AiInteraction | null>(null);
  transcript = '';

  ngOnInit() {
    this.api.status().subscribe({ next: (s) => this.enabled.set(!!s.enabled), error: () => this.enabled.set(false) });
  }
  generate() {
    this.generating.set(true);
    this.api.soapNote(this.encounter().id, this.transcript.trim()).subscribe({
      next: (i) => { this.generating.set(false); this.draft.set(i); if (i.status === 'FAILED') this.toast.error(i.error || 'Draft generation failed'); },
      error: (err) => { this.generating.set(false); this.toast.fromError(err); },
    });
  }
  review(decision: 'APPROVED' | 'REJECTED') {
    const d = this.draft()!;
    this.reviewing.set(true);
    this.api.review(d.id, decision, decision === 'APPROVED' ? true : undefined).subscribe({
      next: (r) => {
        this.reviewing.set(false);
        this.draft.set({ ...d, ...r });
        this.toast.success(decision === 'APPROVED' ? 'Draft applied to the encounter' : 'Draft rejected');
        if (decision === 'APPROVED') this.applied.emit();
      },
      error: (err) => { this.reviewing.set(false); this.toast.fromError(err); },
    });
  }
}
