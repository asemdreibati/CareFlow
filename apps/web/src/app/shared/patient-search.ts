import { Component, ElementRef, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService } from '../core/i18n/language.service';
import { Subject, debounceTime, distinctUntilChanged, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { PatientsApi } from '../core/api/patients.api';
import { Patient, PatientRef } from '../core/models';

/** Autocomplete input backed by GET /patients?search. Emits the chosen patient. */
@Component({
  selector: 'cf-patient-search',
  imports: [TranslatePipe],
  template: `
    <div class="ps">
      @if (selected(); as p) {
        <div class="selected">
          <span><strong>{{ p.firstName }} {{ p.lastName }}</strong> <span class="muted small">· {{ p.mrn }}@if (p.phone) { · {{ p.phone }}}</span></span>
          @if (!disabled()) { <button type="button" class="btn ghost xs" (click)="clear()">{{ 'common.change' | translate }}</button> }
        </div>
      } @else {
        <input class="input" type="text" [placeholder]="placeholderText()" [value]="query()" (input)="onInput($event)" (focus)="open.set(true)" [disabled]="disabled()" autocomplete="off" />
        @if (open() && (results().length || loading() || query())) {
          <div class="menu">
            @if (loading()) { <div class="row-item muted">{{ 'common.searching' | translate }}</div> }
            @for (p of results(); track p.id) {
              <button type="button" class="row-item" (click)="choose(p)">
                <span>{{ p.firstName }} {{ p.lastName }}</span>
                <span class="muted small">{{ p.mrn }}@if (p.phone) { · {{ p.phone }}}</span>
              </button>
            } @empty {
              @if (!loading() && query()) { <div class="row-item muted">{{ 'patients.noneFound' | translate }}</div> }
            }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .ps { position: relative; }
    .selected { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 36px; padding: 0 10px; border: 1px solid var(--cf-border-strong); border-radius: var(--cf-radius-sm); background: var(--cf-surface-2); }
    .menu { position: absolute; inset-inline: 0; top: calc(100% + 4px); background: var(--cf-surface); border: 1px solid var(--cf-border); border-radius: var(--cf-radius-sm); box-shadow: var(--cf-shadow-lg); z-index: 60; max-height: 240px; overflow-y: auto; }
    .row-item { display: flex; justify-content: space-between; gap: 8px; width: 100%; padding: 8px 10px; border: none; background: none; font: inherit; text-align: start; cursor: pointer; }
    button.row-item:hover { background: var(--cf-surface-2); }
  `],
})
export class PatientSearchComponent {
  private readonly api = inject(PatientsApi);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly lang = inject(LanguageService);
  /** Override placeholder; defaults to the translated "Search patient by name, MRN or phone…". */
  readonly placeholder = input<string>('');
  readonly placeholderText = computed(() => this.placeholder() || this.lang.t('patients.searchPlaceholder'));
  readonly disabled = input(false);
  readonly initial = input<PatientRef | null>(null);
  readonly selectedChange = output<PatientRef | null>();

  readonly query = signal('');
  readonly results = signal<Patient[]>([]);
  readonly loading = signal(false);
  readonly open = signal(false);
  readonly selected = signal<PatientRef | null>(null);
  private readonly search$ = new Subject<string>();

  constructor() {
    this.search$
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((q) => { this.loading.set(true); return this.api.list({ search: q || undefined, pageSize: 8 }); }),
        takeUntilDestroyed(),
      )
      .subscribe({ next: (r) => { this.results.set(r.items); this.loading.set(false); }, error: () => this.loading.set(false) });
  }

  /** Allow a pre-selected patient (e.g. booking from a patient profile). */
  ngOnInit() { const i = this.initial(); if (i) this.selected.set(i); }

  onInput(e: Event) {
    const q = (e.target as HTMLInputElement).value;
    this.query.set(q);
    this.open.set(true);
    this.search$.next(q.trim());
  }
  choose(p: Patient) {
    this.selected.set(p);
    this.open.set(false);
    this.selectedChange.emit(p);
  }
  clear() {
    this.selected.set(null);
    this.query.set('');
    this.results.set([]);
    this.selectedChange.emit(null);
  }
  @HostListener('document:click', ['$event']) onDocClick(e: Event) {
    if (!this.host.nativeElement.contains(e.target as Node)) this.open.set(false);
  }
}
