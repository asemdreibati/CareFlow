/**
 * Phone number helpers (pure). Numbers are stored and sent in E.164
 * (`+<country><national>`); local numbers without a country code are assumed
 * to belong to the default country (Saudi Arabia, +966, by default).
 */

const ARABIC_INDIC_ZERO = 0x0660; // ٠..٩
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0; // ۰..۹

/** Folds Arabic-Indic digits to ASCII so numbers typed on Arabic keyboards work. */
export function foldDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) out += String(code - ARABIC_INDIC_ZERO);
    else if (code >= EXTENDED_ARABIC_INDIC_ZERO && code <= EXTENDED_ARABIC_INDIC_ZERO + 9) out += String(code - EXTENDED_ARABIC_INDIC_ZERO);
    else out += ch;
  }
  return out;
}

/**
 * Normalises `raw` to E.164 or returns null when it cannot be a phone number.
 * Accepts `+966501234567`, `00966501234567`, `966501234567`, `0501234567`,
 * `501234567`, with spaces, dashes, dots or parentheses, and a `whatsapp:` prefix.
 */
export function normalizePhone(raw: string | null | undefined, defaultCountryCode = '966'): string | null {
  if (!raw) return null;
  let s = foldDigits(raw).trim().replace(/^whatsapp:/i, '').trim();
  const hasPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (s.length === 0) return null;
  const cc = defaultCountryCode.replace(/\D/g, '');

  let digits: string;
  if (hasPlus) digits = s;
  else if (s.startsWith('00')) digits = s.slice(2);
  else if (s.startsWith('0')) digits = cc + s.slice(1);
  else if (s.startsWith(cc) && s.length >= cc.length + 8) digits = s;
  else digits = cc + s;

  digits = digits.replace(/^0+/, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

/**
 * The ways the same number may have been typed into a patient record, so an
 * inbound reply can be matched against stored (un-normalised) phones.
 */
export function phoneVariants(e164: string, defaultCountryCode = '966'): string[] {
  const digits = e164.replace(/\D/g, '');
  const cc = defaultCountryCode.replace(/\D/g, '');
  const variants = new Set<string>([`+${digits}`, digits, `00${digits}`]);
  if (digits.startsWith(cc)) {
    const national = digits.slice(cc.length);
    variants.add(`0${national}`);
    variants.add(national);
  }
  return [...variants];
}

/** `whatsapp:+966…` → WHATSAPP, otherwise SMS. */
export function channelOfAddress(from: string): 'SMS' | 'WHATSAPP' {
  return /^whatsapp:/i.test(from.trim()) ? 'WHATSAPP' : 'SMS';
}
