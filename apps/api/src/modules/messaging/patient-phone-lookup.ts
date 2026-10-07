import { Prisma } from '@prisma/client';

/**
 * Patient lookups by phone number. Stored phones are free text (`+966 50 123
 * 4567`, `050-123-4567`, `(050) 1234567` …), so both sides are compared in
 * their digits-only form: `regexp_replace(phone, '[^0-9]', '', 'g')` against
 * `phoneDigitVariants(...)`. Raw SQL with bound parameters only.
 */

export interface ClinicPhonePatient {
  id: string;
  clinicId: string;
  firstName: string;
  lastName: string;
  locale: string | null;
}

export interface AnyClinicPhonePatient {
  id: string;
  clinicId: string;
  locale: string | null;
  timezone: string;
  settings: unknown;
}

const MAX_MATCHES = 20;

/**
 * Active patients of ONE clinic whose phone matches. Run it inside a tenant
 * transaction of `clinicId` (`withClinic` + `prisma.transaction`): RLS applies
 * and the clinic is also filtered explicitly.
 */
export function findClinicPatientsByPhone(
  tx: Prisma.TransactionClient,
  clinicId: string,
  digitVariants: readonly string[],
  opts: { portalEnabledOnly: boolean },
): Promise<ClinicPhonePatient[]> {
  if (digitVariants.length === 0) return Promise.resolve([]);
  return tx.$queryRaw<ClinicPhonePatient[]>`
    SELECT id, clinic_id AS "clinicId", first_name AS "firstName", last_name AS "lastName", locale
      FROM patients
     WHERE clinic_id = ${clinicId}::uuid
       AND is_active
       ${opts.portalEnabledOnly ? Prisma.sql`AND portal_enabled` : Prisma.empty}
       AND phone IS NOT NULL
       AND regexp_replace(phone, '[^0-9]', '', 'g') = ANY(${[...digitVariants]}::text[])
     ORDER BY created_at ASC, id ASC
     LIMIT ${MAX_MATCHES}`;
}

/**
 * Active patients of any active clinic whose phone matches (inbound replies,
 * where the phone is the only identity). Must run in a system context
 * (`tenantContext.runSystem` + `prisma.transaction`).
 */
export function findPatientsByPhoneAnyClinic(tx: Prisma.TransactionClient, digitVariants: readonly string[]): Promise<AnyClinicPhonePatient[]> {
  if (digitVariants.length === 0) return Promise.resolve([]);
  return tx.$queryRaw<AnyClinicPhonePatient[]>`
    SELECT p.id, p.clinic_id AS "clinicId", p.locale, c.timezone, c.settings
      FROM patients p
      JOIN clinics c ON c.id = p.clinic_id
     WHERE p.is_active
       AND c.is_active
       AND p.phone IS NOT NULL
       AND regexp_replace(p.phone, '[^0-9]', '', 'g') = ANY(${[...digitVariants]}::text[])
     ORDER BY p.created_at ASC, p.id ASC
     LIMIT ${MAX_MATCHES}`;
}

/** True for a unique-constraint violation (e.g. a duplicate `provider_message_id`). */
export function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === 'P2002';
  // Raw queries surface the PostgreSQL error code instead.
  return err instanceof Error && /23505|unique constraint/i.test(err.message);
}
