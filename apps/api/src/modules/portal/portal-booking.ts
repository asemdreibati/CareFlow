/**
 * Self-booking rules of the patient portal (pure): per-clinic limits from
 * `clinic.settings`, the doctor's slot grid, and the localised messages of the
 * refusals.
 */
import { blocksForWeekday, hhmmToMinutes, zonedParts, type AvailabilityBlock } from '../appointments/scheduling.js';
import { interpolate, type Locale } from '../messaging/messaging.templates.js';

export const DEFAULT_MAX_ACTIVE_BOOKINGS = 3;
export const DEFAULT_BOOKING_HORIZON_DAYS = 90;
const MAX_HORIZON_DAYS = 730;
const MAX_ACTIVE_CAP = 50;

export interface PortalBookingLimits {
  /** Future SCHEDULED/CONFIRMED appointments a patient may hold at once. */
  maxActiveBookings: number;
  /** How far ahead (days) a patient may book. */
  horizonDays: number;
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** `clinic.settings.portalMaxActiveBookings` / `portalBookingHorizonDays`, with defaults 3 / 90. */
export function bookingLimits(settings: unknown): PortalBookingLimits {
  const s = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  return {
    maxActiveBookings: positiveInt(s.portalMaxActiveBookings, DEFAULT_MAX_ACTIVE_BOOKINGS, MAX_ACTIVE_CAP),
    horizonDays: positiveInt(s.portalBookingHorizonDays, DEFAULT_BOOKING_HORIZON_DAYS, MAX_HORIZON_DAYS),
  };
}

/**
 * True when `startsAt` lies on the doctor's slot grid: whole minutes, and a
 * multiple of the block's `slotMinutes` after the start of the availability
 * block containing it (the same grid the slot search offers). Starts outside
 * every block also return true: availability itself is checked (and reported)
 * by `AppointmentWriterService.assertBookable`.
 */
export function isOnSlotGrid(blocks: readonly AvailabilityBlock[], startsAt: Date, timeZone: string): boolean {
  if (startsAt.getUTCMilliseconds() !== 0) return false;
  const p = zonedParts(startsAt, timeZone);
  if (p.second !== 0) return false;
  const minute = p.hour * 60 + p.minute;
  const block = blocksForWeekday(blocks, p.weekday).find((b) => hhmmToMinutes(b.startTime) <= minute && minute < hhmmToMinutes(b.endTime));
  if (!block) return true;
  const step = block.slotMinutes > 0 ? block.slotMinutes : 30;
  return (minute - hhmmToMinutes(block.startTime)) % step === 0;
}

export type PortalMessageKey = 'tooManyBookings' | 'beyondHorizon' | 'offGrid' | 'cancelTooLate' | 'offerUnavailable';

export const PORTAL_MESSAGES: Record<PortalMessageKey, Record<Locale, string>> = {
  tooManyBookings: {
    en: 'You already have {{max}} upcoming appointments. Cancel one or contact the clinic to book another.',
    ar: 'لديك بالفعل {{max}} مواعيد قادمة. ألغِ أحدها أو تواصل مع العيادة لحجز موعد آخر.',
  },
  beyondHorizon: {
    en: 'Appointments can be booked online at most {{days}} days in advance.',
    ar: 'يمكن حجز المواعيد عبر الإنترنت قبل {{days}} يوماً كحد أقصى.',
  },
  offGrid: {
    en: 'Please choose one of the available time slots.',
    ar: 'يرجى اختيار أحد المواعيد المتاحة.',
  },
  cancelTooLate: {
    en: 'Appointments can only be cancelled online at least 2 hours before they start; please contact the clinic',
    ar: 'لا يمكن إلغاء الموعد عبر الإنترنت إلا قبل ساعتين على الأقل من بدايته؛ يرجى التواصل مع العيادة',
  },
  offerUnavailable: {
    en: 'This offered slot is no longer available.',
    ar: 'هذا الموعد المعروض لم يعد متاحاً.',
  },
};

export function portalMessage(key: PortalMessageKey, locale: Locale, params: Record<string, string | number> = {}): string {
  return interpolate(PORTAL_MESSAGES[key][locale], params);
}
