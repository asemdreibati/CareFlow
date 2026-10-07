import { activeIntlTag } from './i18n/locale-registry';

/** Currency amount in the active UI locale (Latin digits, ISO code). Components may prefer `LanguageService.formatMoney`. */
export function money(v: number | string | null | undefined, currency = 'SAR'): string {
  const n = typeof v === 'string' ? parseFloat(v) : (v ?? 0);
  if (Number.isNaN(n)) return '—';
  try {
    return new Intl.NumberFormat(activeIntlTag(), { style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}
export const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? parseFloat(v) : (v ?? 0);
  return Number.isNaN(n) ? 0 : n;
};
