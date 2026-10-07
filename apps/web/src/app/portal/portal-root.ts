import { Component, DestroyRef, ViewEncapsulation, inject } from '@angular/core';
import { setPortalMode } from '../core/i18n/locale-registry';
import { PortalAuthService } from './portal-auth.service';
import { RouterOutlet } from '@angular/router';

/**
 * Root of the `/portal` tree. Carries the portal-wide stylesheet (prefixed `pt-`, encapsulation off)
 * so the patient UI stays mobile-first and independent from the staff layout without touching
 * `styles.scss`. Logical CSS properties keep everything RTL-safe.
 */
@Component({
  selector: 'cf-portal-root',
  imports: [RouterOutlet],
  encapsulation: ViewEncapsulation.None,
  template: `<div class="pt-root"><router-outlet /></div>`,
  styles: [`
    .pt-root { min-height: 100dvh; background: var(--cf-bg); color: var(--cf-text); -webkit-tap-highlight-color: transparent; }
    .pt-frame { max-width: 520px; margin: 0 auto; min-height: 100dvh; background: var(--cf-bg); position: relative; display: flex; flex-direction: column; }
    @media (min-width: 640px) { .pt-frame { box-shadow: 0 0 0 1px var(--cf-border); } }
    .pt-header { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 56px; padding: 0 16px; background: var(--cf-surface); border-bottom: 1px solid var(--cf-border); }
    .pt-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .pt-brand .name { font-weight: 700; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pt-brand .sub { font-size: 11px; color: var(--cf-text-3); }
    .pt-logo { width: 34px; height: 34px; border-radius: 10px; background: var(--cf-primary); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px; flex-shrink: 0; }
    .pt-main { flex: 1; padding: 16px 16px calc(84px + env(safe-area-inset-bottom)); }
    .pt-tabbar { position: fixed; inset-inline: 0; bottom: 0; margin: 0 auto; max-width: 520px; padding-bottom: env(safe-area-inset-bottom); background: var(--cf-surface); border-top: 1px solid var(--cf-border); display: grid; grid-template-columns: repeat(5, 1fr); z-index: 20; }
    .pt-tab { height: 60px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; font-size: 11px; font-weight: 600; color: var(--cf-text-3); text-decoration: none; }
    .pt-tab:hover { text-decoration: none; }
    .pt-tab svg { width: 22px; height: 22px; }
    .pt-tab.active { color: var(--cf-primary); }
    .pt-tab .fab { width: 46px; height: 46px; border-radius: 50%; background: var(--cf-primary); color: #fff; display: inline-flex; align-items: center; justify-content: center; margin-top: -22px; box-shadow: 0 6px 16px rgba(15, 118, 110, 0.35); }
    .pt-tab .fab svg { width: 24px; height: 24px; }
    .pt-card { background: var(--cf-surface); border: 1px solid var(--cf-border); border-radius: 14px; padding: 16px; box-shadow: var(--cf-shadow); }
    .pt-card + .pt-card { margin-top: 12px; }
    .pt-card.accent { border-color: #99f6e4; background: linear-gradient(180deg, #f0fdfa, #fff); }
    .pt-card.warn { border-color: #fde68a; background: linear-gradient(180deg, #fffbeb, #fff); }
    .pt-title { font-size: 21px; font-weight: 700; margin: 4px 0 14px; letter-spacing: -0.01em; }
    .pt-section { font-size: 12px; font-weight: 700; color: var(--cf-text-2); text-transform: uppercase; letter-spacing: 0.05em; margin: 18px 0 8px; }
    .pt-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 18px; border-radius: 12px; border: 1px solid var(--cf-border-strong); background: var(--cf-surface); color: var(--cf-text); font: inherit; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.12s, border-color 0.12s, transform 0.08s; }
    .pt-btn:active:not(:disabled) { transform: scale(0.985); }
    .pt-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .pt-btn.primary { background: var(--cf-primary); border-color: var(--cf-primary); color: #fff; }
    .pt-btn.primary:hover:not(:disabled) { background: var(--cf-primary-600); }
    .pt-btn.danger { color: var(--cf-danger); border-color: #fca5a5; background: #fff; }
    .pt-btn.ghost { border-color: transparent; background: transparent; color: var(--cf-primary); }
    .pt-btn.block { width: 100%; }
    .pt-btn.sm { min-height: 36px; padding: 0 14px; font-size: 13.5px; border-radius: 10px; }
    .pt-btn.icon { width: 40px; min-height: 40px; padding: 0; border-radius: 10px; border-color: transparent; background: transparent; color: var(--cf-text-2); }
    .pt-btn.icon svg { width: 20px; height: 20px; }
    .pt-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
    .pt-actions .pt-btn { flex: 1; }
    .pt-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
    .pt-field label { font-size: 13px; font-weight: 600; color: var(--cf-text-2); }
    .pt-input { width: 100%; min-height: 46px; padding: 0 14px; font: inherit; font-size: 16px; color: var(--cf-text); background: var(--cf-surface); border: 1px solid var(--cf-border-strong); border-radius: 12px; outline: none; transition: border-color 0.12s, box-shadow 0.12s; }
    textarea.pt-input { min-height: 84px; padding: 10px 14px; resize: vertical; }
    .pt-input:focus { border-color: var(--cf-primary); box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.15); }
    .pt-input:disabled, .pt-input[readonly] { background: var(--cf-surface-2); color: var(--cf-text-2); }
    .pt-input.invalid { border-color: var(--cf-danger); }
    .pt-hint { font-size: 12.5px; color: var(--cf-text-3); }
    .pt-error { font-size: 12.5px; color: var(--cf-danger); }
    .pt-alert { padding: 10px 12px; border-radius: 10px; font-size: 13.5px; margin-bottom: 12px; }
    .pt-alert.error { background: var(--cf-danger-soft); color: #991b1b; border: 1px solid #fecaca; }
    .pt-alert.info { background: var(--cf-info-soft); color: #1e3a8a; border: 1px solid #bfdbfe; }
    .pt-list { display: flex; flex-direction: column; gap: 10px; }
    .pt-item { display: flex; align-items: center; gap: 12px; padding: 14px 16px; background: var(--cf-surface); border: 1px solid var(--cf-border); border-radius: 14px; color: inherit; text-decoration: none; box-shadow: var(--cf-shadow); }
    .pt-item:hover { text-decoration: none; border-color: var(--cf-border-strong); }
    .pt-item .body { flex: 1; min-width: 0; }
    .pt-item .primary { font-weight: 600; font-size: 15px; }
    .pt-item .secondary { font-size: 13px; color: var(--cf-text-2); margin-top: 2px; }
    .pt-chevron { color: var(--cf-text-3); flex-shrink: 0; width: 18px; height: 18px; }
    [dir='rtl'] .pt-chevron { transform: scaleX(-1); }
    .pt-datebox { width: 52px; flex-shrink: 0; border-radius: 12px; background: var(--cf-primary-soft); color: var(--cf-primary); text-align: center; padding: 6px 0; line-height: 1.15; }
    .pt-datebox .d { font-size: 20px; font-weight: 700; }
    .pt-datebox .m { font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .pt-datebox.muted { background: var(--cf-surface-2); color: var(--cf-text-3); }
    .pt-empty { padding: 40px 16px; text-align: center; color: var(--cf-text-3); font-size: 14px; }
    .pt-empty .big { font-size: 34px; margin-bottom: 8px; }
    .pt-loading { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 28px; color: var(--cf-text-2); }
    .pt-segment { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; background: var(--cf-surface-2); border: 1px solid var(--cf-border); border-radius: 12px; padding: 3px; margin-bottom: 14px; }
    .pt-segment button { border: none; background: transparent; font: inherit; font-size: 14px; font-weight: 600; color: var(--cf-text-2); min-height: 36px; border-radius: 9px; cursor: pointer; }
    .pt-segment button.active { background: var(--cf-surface); color: var(--cf-primary); box-shadow: var(--cf-shadow); }
    .pt-kv { display: grid; grid-template-columns: 110px 1fr; gap: 8px 12px; font-size: 14px; }
    .pt-kv dt { color: var(--cf-text-2); } .pt-kv dd { margin: 0; font-weight: 500; }
    .pt-amount { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .pt-row { display: flex; align-items: center; gap: 10px; }
    .pt-row.between { justify-content: space-between; }
    .pt-muted { color: var(--cf-text-2); } .pt-small { font-size: 12.5px; } .pt-strong { font-weight: 600; }
    .pt-lang { display: inline-flex; align-items: center; height: 32px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--cf-border-strong); background: var(--cf-surface); font: inherit; font-size: 12.5px; font-weight: 600; color: var(--cf-text-2); cursor: pointer; }
    .pt-countdown { font-variant-numeric: tabular-nums; direction: ltr; display: inline-block; }
    .pt-fade { animation: pt-in 0.18s ease-out; }
    @keyframes pt-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  `],
})
export class PortalRoot {
  constructor() {
    inject(PortalAuthService); // registers the portal clinic-timezone source
    // While the portal is mounted, dates use the portal clinic's timezone and language switches never touch the staff account.
    setPortalMode(true);
    inject(DestroyRef).onDestroy(() => setPortalMode(false));
  }
}
