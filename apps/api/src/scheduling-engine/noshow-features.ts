/**
 * Feature extraction for the no-show predictor. Pure: works on plain inputs the
 * caller has already loaded (patient history counters, dates), so it can be used
 * both for training rows and for live scoring.
 */
import { zonedParts } from '../modules/appointments/scheduling.js';

export const NO_SHOW_FEATURE_NAMES = [
  'historicalNoShowRate',
  'pastAppointments',
  'leadTimeDays',
  'hourOfDay',
  'weekday',
  'isFollowUp',
  'patientAge',
  'daysSinceLastVisit',
] as const;

export type NoShowFeatureName = (typeof NO_SHOW_FEATURE_NAMES)[number];

export interface NoShowFeatureInput {
  startsAt: Date;
  /** When the appointment was booked. */
  createdAt: Date;
  /** Appointment type, e.g. "FOLLOW_UP". */
  type: string;
  /** IANA timezone of the clinic (hour of day / weekday are wall-clock). */
  timeZone: string;
  patientDateOfBirth: Date | null;
  /** Number of the patient's past appointments that ended (COMPLETED or NO_SHOW) before this one. */
  patientPastAppointments: number;
  /** How many of those were no-shows. */
  patientPastNoShows: number;
  /** Start of the patient's most recent past visit (COMPLETED), or null. */
  patientLastVisitAt: Date | null;
}

const DAY_MS = 86_400_000;
export const MAX_LEAD_TIME_DAYS = 365;
export const MAX_DAYS_SINCE_LAST_VISIT = 365;

/** Laplace-smoothed no-show rate: (noShows + 1) / (past + 2); 0.5 for a brand-new patient. */
export function smoothedNoShowRate(pastNoShows: number, pastAppointments: number): number {
  return (Math.max(0, pastNoShows) + 1) / (Math.max(0, pastAppointments) + 2);
}

export function ageAt(dateOfBirth: Date | null, at: Date): number {
  if (!dateOfBirth || Number.isNaN(dateOfBirth.getTime())) return 0;
  const years = (at.getTime() - dateOfBirth.getTime()) / (365.25 * DAY_MS);
  return years > 0 ? Math.floor(years) : 0;
}

/** Feature vector in the order of `NO_SHOW_FEATURE_NAMES`. */
export function extractNoShowFeatures(input: NoShowFeatureInput): number[] {
  const parts = zonedParts(input.startsAt, input.timeZone);
  const leadTime = (input.startsAt.getTime() - input.createdAt.getTime()) / DAY_MS;
  const sinceLast = input.patientLastVisitAt ? (input.startsAt.getTime() - input.patientLastVisitAt.getTime()) / DAY_MS : MAX_DAYS_SINCE_LAST_VISIT;
  return [
    smoothedNoShowRate(input.patientPastNoShows, input.patientPastAppointments),
    Math.max(0, input.patientPastAppointments),
    Math.min(MAX_LEAD_TIME_DAYS, Math.max(0, leadTime)),
    parts.hour + parts.minute / 60,
    parts.weekday,
    input.type === 'FOLLOW_UP' ? 1 : 0,
    ageAt(input.patientDateOfBirth, input.startsAt),
    Math.min(MAX_DAYS_SINCE_LAST_VISIT, Math.max(0, sinceLast)),
  ];
}

export interface HistoricalAppointment {
  patientId: string;
  startsAt: Date;
  status: string;
}

export interface PatientHistory {
  pastAppointments: number;
  pastNoShows: number;
  lastVisitAt: Date | null;
}

/**
 * Patient history as it stood strictly before `at`, from a list of the patient's
 * ended appointments (any order). Only COMPLETED and NO_SHOW rows count.
 */
export function patientHistoryBefore(rows: readonly HistoricalAppointment[], at: Date): PatientHistory {
  let pastAppointments = 0;
  let pastNoShows = 0;
  let lastVisitAt: Date | null = null;
  for (const r of rows) {
    if (r.startsAt.getTime() >= at.getTime()) continue;
    if (r.status === 'COMPLETED') {
      pastAppointments++;
      if (!lastVisitAt || r.startsAt > lastVisitAt) lastVisitAt = r.startsAt;
    } else if (r.status === 'NO_SHOW') {
      pastAppointments++;
      pastNoShows++;
    }
  }
  return { pastAppointments, pastNoShows, lastVisitAt };
}
