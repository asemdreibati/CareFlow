import { HttpErrorResponse } from '@angular/common/http';

export type Translator = (key: string, params?: Record<string, unknown>) => string;

/** Server messages (apps/api) that deserve a translated toast. First match wins. */
const KNOWN: { re: RegExp; key: string; params?: (m: RegExpMatchArray) => Record<string, unknown> }[] = [
  { re: /modified by someone else|version/i, key: 'errors.versionConflict' },
  { re: /^Resource "(.+)" is not available/i, key: 'errors.resourceBusy', params: (m) => ({ name: m[1] }) },
  { re: /^Resource "(.+)" is not active/i, key: 'errors.resourceInactive', params: (m) => ({ name: m[1] }) },
  { re: /requested resources is not available/i, key: 'errors.resourcesBusy' },
  { re: /overlaps another appointment/i, key: 'errors.slotOverlap' },
  { re: /^Invalid credentials/i, key: 'errors.invalidCredentials' },
  { re: /^Current password is incorrect/i, key: 'errors.currentPasswordWrong' },
  { re: /email already exists/i, key: 'errors.emailExists' },
  { re: /slug is already taken/i, key: 'errors.slugTaken' },
  { re: /^Missing permission/i, key: 'errors.forbidden' },
  { re: /^Patient is not active/i, key: 'errors.patientInactive' },
  { re: /^Doctor is not active/i, key: 'errors.doctorInactive' },
  { re: /^Encounter is already signed/i, key: 'errors.encounterSigned' },
  { re: /Only the authoring doctor can sign/i, key: 'errors.onlyAuthorCanSign' },
  { re: /already has an encounter/i, key: 'errors.encounterExists' },
  { re: /paid invoice cannot be voided/i, key: 'errors.paidInvoiceVoid' },
  { re: /^Only draft invoices can be edited/i, key: 'errors.onlyDraftInvoices' },
  { re: /Invoice changed while recording/i, key: 'errors.invoiceChanged' },
  { re: /^Invoice is \w+; only drafts can be issued/i, key: 'errors.onlyDraftIssue' },
  { re: /^Invoice is \w+; payments are only accepted/i, key: 'errors.paymentsOnlyIssued' },
  { re: /offered slot is no longer held/i, key: 'errors.offerExpired' },
  { re: /^Entry is no longer waiting|Only WAITING entries can be booked/i, key: 'errors.entryNotWaiting' },
  { re: /^No offer is pending/i, key: 'errors.noPendingOffer' },
  { re: /must be after (startsAt|from|earliestAt|startTime)/i, key: 'errors.endAfterStart' },
  { re: /first occurrence must be in the future/i, key: 'errors.firstOccurrenceFuture' },
  { re: /produces no occurrences/i, key: 'errors.noOccurrences' },
  { re: /^Series is already cancelled/i, key: 'errors.seriesCancelled' },
  { re: /^Proposal (was|is) already/i, key: 'errors.proposalAlreadyApplied' },
  { re: /^Proposal was dismissed/i, key: 'errors.proposalDismissed' },
  { re: /already a member of this clinic/i, key: 'errors.alreadyMember' },
  { re: /cannot deactivate or demote yourself/i, key: 'errors.selfDemote' },
  { re: /at least one active owner/i, key: 'errors.lastOwner' },
  { re: /^Only an owner can/i, key: 'errors.ownerOnly' },
  { re: /not linked to a doctor profile/i, key: 'errors.noDoctorProfile' },
  { re: /^You (may|can) only (access|work on|manage)/i, key: 'errors.ownRecordsOnly' },
  { re: /no-show model has been trained/i, key: 'errors.noModel' },
  { re: /completed or no-show appointments are required to train/i, key: 'errors.notEnoughSamples' },
  { re: /^The AI model declined/i, key: 'errors.aiDeclined' },
  { re: /Refresh token is invalid|Malformed refresh token|Invalid token type/i, key: 'errors.sessionExpired' },
  { re: /Membership is no longer active|No active clinic membership|Not a member of the requested clinic/i, key: 'errors.membershipInactive' },
];

const STATUS_KEYS: Record<number, string> = {
  401: 'errors.unauthorized', 403: 'errors.forbidden', 404: 'errors.notFound', 409: 'errors.conflict', 422: 'errors.validation',
  429: 'errors.rateLimited', 500: 'errors.server', 502: 'errors.server', 503: 'errors.server', 504: 'errors.server', 501: 'errors.notImplemented',
};

/** Extracts the API `message` (string | string[]) from an error body. */
export function rawServerMessage(err: unknown): string | null {
  if (!(err instanceof HttpErrorResponse)) return null;
  const body = err.error as { message?: string | string[] } | string | null | undefined;
  if (typeof body === 'string' && body) return body;
  const m = body && typeof body === 'object' ? body.message : undefined;
  if (Array.isArray(m)) return m.join('\n');
  return typeof m === 'string' && m ? m : null;
}

/**
 * Maps an HTTP error to a user-facing message: known server messages and HTTP
 * statuses become translated texts; anything else falls back to the raw message.
 */
export function mapApiError(err: unknown, t: Translator, fallback?: string): string {
  const generic = fallback || t('common.error');
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return t('errors.network');
    const raw = rawServerMessage(err);
    if (raw) {
      for (const k of KNOWN) {
        const m = raw.match(k.re);
        if (m) return t(k.key, k.params?.(m));
      }
      // Validation lists (class-validator) and other specific messages: keep the server text.
      if (err.status === 400 || err.status === 422 || err.status === 409) return raw;
      const byStatus = STATUS_KEYS[err.status];
      if (byStatus) return t(byStatus);
      return raw;
    }
    const byStatus = STATUS_KEYS[err.status];
    if (byStatus) return t(byStatus);
    return err.message || generic;
  }
  if (err instanceof Error) return err.message || generic;
  return generic;
}

type ErrorTranslator = (err: unknown, fallback?: string) => string;
let translator: ErrorTranslator | null = null;

/** Installed by LanguageService so the plain `errorMessage()` helper yields translated texts. */
export function registerErrorTranslator(fn: ErrorTranslator): void { translator = fn; }

/**
 * User-facing message for an HTTP error without DI: translated once LanguageService
 * has registered itself (always, in the running app), English defaults otherwise.
 */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (translator) return translator(err, fallback);
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'Cannot reach the server.';
    const raw = rawServerMessage(err);
    if (raw) return raw;
    if (err.status === 404) return 'Not found (this feature may not be available yet).';
    if (err.status === 501) return 'Not implemented yet.';
    return err.message || fallback;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}
