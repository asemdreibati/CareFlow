import { describe, expect, it } from 'vitest';
import { normalizeReply, parseIntent } from './inbound-intent.js';

describe('parseIntent', () => {
  it.each(['1', 'yes', 'YES', 'Yes.', 'confirm', 'Confirm!', 'نعم', 'تأكيد', ' 1 ', '١', 'ok', 'yes please'])('%s → CONFIRM', (s) => {
    expect(parseIntent(s)).toBe('CONFIRM');
  });

  it.each(['2', 'no', 'No', 'cancel', 'CANCEL.', 'لا', 'إلغاء', 'الغاء', '٢', '\n2\n', 'no thanks'])('%s → CANCEL', (s) => {
    expect(parseIntent(s)).toBe('CANCEL');
  });

  it.each(['', '   ', 'maybe', 'hello there how are you', '3', 'yes no', 'I will call the clinic tomorrow', null, undefined])('%s → UNKNOWN', (s) => {
    expect(parseIntent(s as string)).toBe('UNKNOWN');
  });

  it('normalises punctuation, whitespace and diacritics', () => {
    expect(normalizeReply('  Yes!!  ')).toBe('yes');
    expect(normalizeReply('نَعَمْ')).toBe('نعم');
    expect(normalizeReply('"1"')).toBe('1');
  });
});
