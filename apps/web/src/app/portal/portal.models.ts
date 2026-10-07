/**
 * Patient-portal API shapes (docs/PHASE3.md §C "Patient portal (API)").
 * Everything optional-ish is parsed defensively: the backend is landing concurrently.
 */
import type { Appointment, Invoice, PreferredWindow, WaitlistEntry } from '../core/models';

export type PortalLocale = 'ar' | 'en';

export interface PortalPatient { id: string; firstName: string; lastName: string; locale?: PortalLocale | null; }
export interface PortalClinic { name: string; slug: string; timezone: string; currency: string; }
export interface PortalVerifyResponse { accessToken: string; patient: PortalPatient; clinic: PortalClinic; }
/** Returned by verify when several patients of the clinic share the phone number. */
export interface PortalSelectionRequired { requiresPatientSelection: true; candidates: { id: string; displayName: string }[]; selectionToken: string; }
export type PortalVerifyResult = PortalVerifyResponse | PortalSelectionRequired;
export function needsPatientSelection(r: PortalVerifyResult): r is PortalSelectionRequired {
  return (r as PortalSelectionRequired).requiresPatientSelection === true;
}

export interface PortalConsent { id?: string; type: string; version: string; acceptedAt?: string | null; }

/** `GET /portal/me` — profile + consents + locale. */
export interface PortalMe {
  id: string; firstName: string; lastName: string; phone?: string | null; email?: string | null; address?: string | null;
  locale?: PortalLocale | null; dateOfBirth?: string | null; consents?: PortalConsent[];
}
/** `null` clears a stored value. */
export interface PortalMePatch { locale?: PortalLocale; email?: string | null; address?: string | null; }

export interface PortalDoctor { id: string; firstName: string; lastName: string; title?: string | null; specialty: string; }
export interface PortalClinicInfo {
  name: string; slug?: string; address?: string | null; phone?: string | null; timezone?: string; currency?: string;
  doctors: PortalDoctor[];
}

export type PortalAppointment = Appointment;
export type PortalInvoice = Invoice;
export type PortalWaitlistEntry = WaitlistEntry;

export interface PortalSlot { doctor: PortalDoctor; startsAt: string; endsAt: string; }
export interface PortalSlotsResponse { candidates: PortalSlot[]; query?: Record<string, unknown>; }

export interface PortalBookDto { doctorId: string; startsAt: string; reason?: string; }
export interface PortalWaitlistDto { doctorId?: string; specialty?: string; priority: 'ROUTINE'; preferredWindows?: PreferredWindow[]; }

/** The consent every patient must accept before using the portal. */
export const REQUIRED_CONSENT: PortalConsent = { type: 'PRIVACY', version: 'v1' };
/** Consents offered on the profile page (required first). */
export const KNOWN_CONSENTS: PortalConsent[] = [REQUIRED_CONSENT, { type: 'MESSAGING', version: 'v1' }];

/** True when `consents` contains the given type at the same version ("v1" and "1" are treated alike). */
export function hasConsent(consents: readonly PortalConsent[] | null | undefined, wanted: PortalConsent): boolean {
  const norm = (v: string) => String(v).toLowerCase().replace(/^v/, '');
  return (consents ?? []).some((c) => c.type === wanted.type && norm(c.version) === norm(wanted.version));
}
