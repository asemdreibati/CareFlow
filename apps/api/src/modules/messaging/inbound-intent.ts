/**
 * Interprets a patient's reply to a reminder (pure). Replies are short and come
 * in Arabic or English, with the digits `1` / `2` as the documented shortcut.
 */
export type InboundIntent = 'CONFIRM' | 'CANCEL' | 'UNKNOWN';

const CONFIRM_WORDS = new Set(['1', 'yes', 'y', 'ok', 'okay', 'confirm', 'confirmed', 'نعم', 'تأكيد', 'اكد', 'أكد', 'موافق', 'ايوه', 'أيوه', 'اي', 'أي', 'تم']);
const CANCEL_WORDS = new Set(['2', 'no', 'n', 'cancel', 'cancelled', 'canceled', 'لا', 'إلغاء', 'الغاء', 'الغي', 'ألغي', 'إلغي', 'كلا']);

/** Strips punctuation, diacritics, tatweel and folds Arabic-Indic digits. */
export function normalizeReply(body: string): string {
  return body
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '') // Arabic diacritics + tatweel
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .toLowerCase();
}

export function parseIntent(body: string | null | undefined): InboundIntent {
  if (!body) return 'UNKNOWN';
  const text = normalizeReply(body);
  if (!text) return 'UNKNOWN';
  if (CONFIRM_WORDS.has(text)) return 'CONFIRM';
  if (CANCEL_WORDS.has(text)) return 'CANCEL';
  // "yes please" / "نعم شكرا": decide on the first word only when it is unambiguous.
  const words = text.split(/\s+/);
  if (words.length <= 3) {
    const first = words[0];
    if (CONFIRM_WORDS.has(first) && !words.some((w) => CANCEL_WORDS.has(w))) return 'CONFIRM';
    if (CANCEL_WORDS.has(first) && !words.some((w) => CONFIRM_WORDS.has(w))) return 'CANCEL';
  }
  return 'UNKNOWN';
}
