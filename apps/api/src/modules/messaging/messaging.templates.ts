/**
 * Bilingual message templates (pure). Every template exists in Arabic and
 * English; `{{param}}` placeholders are replaced from `params` (missing values
 * render as an empty string). Reminders carry the reply instructions that the
 * inbound webhook understands (`1` confirm / `2` cancel).
 */
export type Locale = 'ar' | 'en';

export const TEMPLATE_KEYS = ['appointment.reminder', 'appointment.confirmed', 'appointment.cancelled', 'waitlist.offer', 'portal.otp', 'invoice.issued'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export type TemplateParams = Record<string, string | number | null | undefined>;

export interface RenderedMessage {
  subject: string;
  body: string;
}

interface TemplateText {
  subject: string;
  body: string;
}

export const REPLY_INSTRUCTIONS: Record<Locale, string> = {
  en: 'Reply 1 to confirm or 2 to cancel.',
  ar: 'أرسل 1 للتأكيد أو 2 للإلغاء.',
};

/**
 * Templates whose body carries `REPLY_INSTRUCTIONS`: a patient's `1` / `2` is
 * applied to the appointment of the latest such message sent to their phone.
 */
export const REPLYABLE_TEMPLATES: readonly TemplateKey[] = ['appointment.reminder', 'appointment.confirmed'];

/** Placeholder stored / logged instead of a secret template parameter. */
export const SECRET_MASK = '******';

/**
 * Template parameters that are secrets (one-time codes): they are sent to the
 * provider but never persisted in `messages.body` nor written to logs.
 */
export const SECRET_PARAMS: Partial<Record<TemplateKey, readonly string[]>> = {
  'portal.otp': ['code'],
};

const TEMPLATES: Record<TemplateKey, Record<Locale, TemplateText>> = {
  'appointment.reminder': {
    en: {
      subject: 'Appointment reminder - {{clinicName}}',
      body: 'Dear {{patientName}}, this is a reminder of your appointment with {{doctorName}} on {{when}} at {{clinicName}}. ' + REPLY_INSTRUCTIONS.en,
    },
    ar: {
      subject: 'تذكير بالموعد - {{clinicName}}',
      body: 'عزيزي/عزيزتي {{patientName}}، نذكّرك بموعدك مع {{doctorName}} يوم {{when}} في {{clinicName}}. ' + REPLY_INSTRUCTIONS.ar,
    },
  },
  'appointment.confirmed': {
    en: {
      subject: 'Appointment booked - {{clinicName}}',
      body: 'Dear {{patientName}}, your appointment with {{doctorName}} on {{when}} at {{clinicName}} is booked. ' + REPLY_INSTRUCTIONS.en,
    },
    ar: {
      subject: 'تم حجز الموعد - {{clinicName}}',
      body: 'عزيزي/عزيزتي {{patientName}}، تم حجز موعدك مع {{doctorName}} يوم {{when}} في {{clinicName}}. ' + REPLY_INSTRUCTIONS.ar,
    },
  },
  'appointment.cancelled': {
    en: {
      subject: 'Appointment cancelled - {{clinicName}}',
      body: 'Dear {{patientName}}, your appointment with {{doctorName}} on {{when}} at {{clinicName}} has been cancelled. Contact the clinic to book a new one.',
    },
    ar: {
      subject: 'تم إلغاء الموعد - {{clinicName}}',
      body: 'عزيزي/عزيزتي {{patientName}}، تم إلغاء موعدك مع {{doctorName}} يوم {{when}} في {{clinicName}}. تواصل مع العيادة لحجز موعد جديد.',
    },
  },
  'waitlist.offer': {
    en: {
      subject: 'A slot is available - {{clinicName}}',
      body: 'Dear {{patientName}}, a slot with {{doctorName}} on {{when}} is held for you at {{clinicName}} until {{expires}}. Open the patient portal to accept or decline.',
    },
    ar: {
      subject: 'موعد متاح - {{clinicName}}',
      body: 'عزيزي/عزيزتي {{patientName}}، تم حجز موعد مؤقت لك مع {{doctorName}} يوم {{when}} في {{clinicName}} حتى {{expires}}. افتح بوابة المريض لقبول الموعد أو رفضه.',
    },
  },
  'portal.otp': {
    en: {
      subject: 'Your {{clinicName}} login code',
      body: '{{code}} is your {{clinicName}} login code. It expires in {{minutes}} minutes. Do not share it with anyone.',
    },
    ar: {
      subject: 'رمز الدخول إلى {{clinicName}}',
      body: 'رمز الدخول إلى {{clinicName}} هو {{code}}. تنتهي صلاحيته خلال {{minutes}} دقائق. لا تشاركه مع أي شخص.',
    },
  },
  'invoice.issued': {
    en: {
      subject: 'Invoice {{number}} - {{clinicName}}',
      body: 'Dear {{patientName}}, invoice {{number}} for {{total}} {{currency}} has been issued by {{clinicName}}. You can view it in the patient portal.',
    },
    ar: {
      subject: 'فاتورة {{number}} - {{clinicName}}',
      body: 'عزيزي/عزيزتي {{patientName}}، أصدرت {{clinicName}} الفاتورة رقم {{number}} بمبلغ {{total}} {{currency}}. يمكنك الاطلاع عليها في بوابة المريض.',
    },
  },
};

export function isTemplateKey(key: string): key is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(key);
}

/** `'ar'` unless the value is explicitly `'en'`; unknown values fall back to the default. */
export function resolveLocale(value: string | null | undefined, fallback: Locale = 'ar'): Locale {
  return value === 'en' || value === 'ar' ? value : fallback;
}

/** Replaces `{{name}}` placeholders; unknown names become an empty string. */
export function interpolate(text: string, params: TemplateParams): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name: string) => {
    const v = params[name];
    return v === null || v === undefined ? '' : String(v);
  });
}

export function renderTemplate(key: TemplateKey, locale: Locale, params: TemplateParams = {}): RenderedMessage {
  const t = TEMPLATES[key][locale];
  return { subject: interpolate(t.subject, params).replace(/\s+/g, ' ').trim(), body: interpolate(t.body, params).replace(/[ \t]+/g, ' ').trim() };
}

/**
 * `params` with every secret parameter of `key` replaced by `SECRET_MASK`, and
 * the secrets themselves (empty when the template has none).
 */
export function splitSecretParams(key: TemplateKey, params: TemplateParams): { redacted: TemplateParams; secrets: Record<string, string> } {
  const names = SECRET_PARAMS[key] ?? [];
  const redacted: TemplateParams = { ...params };
  const secrets: Record<string, string> = {};
  for (const name of names) {
    const v = params[name];
    if (v === null || v === undefined || v === '') continue;
    secrets[name] = String(v);
    redacted[name] = SECRET_MASK;
  }
  return { redacted, secrets };
}

/** Masks one-time codes in an already rendered `portal.otp` body (rows written before codes were masked). */
export function maskSecretsInBody(template: string | null, body: string): string {
  return template === 'portal.otp' ? body.replace(/\d{4,8}/g, SECRET_MASK) : body;
}

export type InboundReplyKey = 'confirmed' | 'cancelled' | 'nothing' | 'unknown' | 'unknownPatient' | 'contactClinic' | 'tooLateToCancel' | 'offerDeclined';

/** Localised acknowledgements sent back to inbound replies (TwiML body). */
export const INBOUND_REPLIES: Record<InboundReplyKey, Record<Locale, string>> = {
  confirmed: {
    en: 'Thank you, your appointment on {{when}} is confirmed.',
    ar: 'شكراً لك، تم تأكيد موعدك يوم {{when}}.',
  },
  cancelled: {
    en: 'Your appointment on {{when}} has been cancelled. Contact the clinic to book again.',
    ar: 'تم إلغاء موعدك يوم {{when}}. تواصل مع العيادة لحجز موعد جديد.',
  },
  nothing: {
    en: 'We could not find an upcoming appointment for this number. Please contact the clinic.',
    ar: 'لم نجد موعداً قادماً لهذا الرقم. يرجى التواصل مع العيادة.',
  },
  unknown: {
    en: 'Sorry, we did not understand your reply. ' + REPLY_INSTRUCTIONS.en,
    ar: 'عذراً، لم نفهم ردك. ' + REPLY_INSTRUCTIONS.ar,
  },
  unknownPatient: {
    en: 'This number is not registered with a clinic. Please contact your clinic directly.',
    ar: 'هذا الرقم غير مسجل لدى أي عيادة. يرجى التواصل مع عيادتك مباشرة.',
  },
  contactClinic: {
    en: 'We could not match your reply to an upcoming appointment, so nothing was changed. Please contact the clinic directly.',
    ar: 'لم نتمكن من ربط ردك بموعد قادم، لذلك لم يتم إجراء أي تغيير. يرجى التواصل مع العيادة مباشرة.',
  },
  tooLateToCancel: {
    en: 'Your appointment on {{when}} starts in less than 2 hours and can no longer be cancelled by message. Please call the clinic.',
    ar: 'موعدك يوم {{when}} يبدأ خلال أقل من ساعتين ولا يمكن إلغاؤه برسالة. يرجى الاتصال بالعيادة.',
  },
  offerDeclined: {
    en: 'You declined the slot on {{when}}. You remain on the waiting list.',
    ar: 'لقد رفضت الموعد المعروض يوم {{when}}. ستبقى على قائمة الانتظار.',
  },
};

/** Date + time in the clinic timezone, in the patient's language (Latin digits, Gregorian calendar). */
export function formatWhen(date: Date, timeZone: string, locale: Locale): string {
  const tag = locale === 'ar' ? 'ar-SA-u-nu-latn-ca-gregory' : 'en-GB';
  try {
    return new Intl.DateTimeFormat(tag, { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
}
