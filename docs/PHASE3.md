# Phase 3: search, Arabic/RTL, patient portal & messaging

Builds on docs/API.md, docs/SCHEDULING.md and the migration `20261006090000_search_portal_messaging`
(pg_trgm + unaccent + pgvector, `careflow_normalize()`, `patients.search_text`,
`encounters.search_vector`, `encounter_embeddings`, `otp_codes`, `patient_consents`, `messages`,
`users.locale`, `patients.portal_enabled/locale`, `ReminderChannel.WHATSAPP`).

Locale rules (API and web): `"ar" | "en"`. Resolution order for a staff user: `users.locale` →
`clinic.settings.locale` → `"ar"`. For a patient: `patients.locale` → clinic → `"ar"`.

---

## A. Search (API `src/modules/search`, AI module additions) — owner: search agent

Normalisation: ALWAYS pass the user's query through `careflow_normalize($1)` in SQL so Arabic
diacritics/alef/taa-marbuta variants and Latin accents fold the same way as the indexed text.

| Method | Path | Behaviour |
|---|---|---|
| GET | /search?q&limit? | Global search (min 2 chars). Returns `{ patients: [...], encounters: [...], invoices: [...], appointments: [...] }`, each ≤ `limit` (default 5, max 20). Patients: `search_text ILIKE '%'||norm||'%' OR word_similarity(norm, search_text) >= 0.45`, ordered by `word_similarity` desc then last name; includes `score`. Encounters: `search_vector @@ websearch_to_tsquery('simple', norm)` ranked by `ts_rank_cd`, with `ts_headline` snippet, patient + doctor summaries; only when the user has `records:read` and respects the DOCTOR own-records scoping. Invoices: `lower(number) LIKE`. Appointments: by matched patients (next 3 upcoming). Permissions per entity (`patients:read`, `records:read`, `billing:read`, `appointments:read`). |
| GET | /patients?search= | Replace the existing `contains` filter with the same normalised trigram query (keep pagination). The search must find "محمد" from "مُحَمَّد", "Sami" from "sami@example.com" and "0501" inside phone numbers. |
| GET | /records/search?q&patientId?&doctorId?&from?&to?&page&pageSize | Paginated full-text search over encounters with snippets and rank; same scoping as GET /encounters/:id (logs nothing). |
| GET | /search/diagnoses?q | Distinct ICD codes/descriptions previously used in the clinic matching the trigram query (autocomplete). |

Semantic search / "ask the record" (AI module, `src/modules/ai`):
* `EmbeddingProvider` interface (`embed(texts[]) → number[][]`, `dimensions = 768`, `model`) with a
  Gemini implementation (`@google/genai` `models.embedContent` with `outputDimensionality: 768`,
  taskType RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY) and a disabled one (503 when `EMBEDDING_PROVIDER=none`
  or no key). Config from `env.ts` (add `embedding: { provider, model }` — the search agent OWNS
  `src/config/env.ts` for this phase and must keep the existing keys).
* Listener on encounter sign/amend (emit `encounter.signed` / `encounter.amended` events from the
  records module — the search agent may add these two `events.emit` calls in `records.service.ts`,
  nothing else there) → embed the de-identified SOAP text (reuse `renderPatientContext`-style
  stripping; no names/contacts), upsert `encounter_embeddings` via `$executeRaw` with
  `'[...]'::vector` cast, skip when `content_hash` unchanged. `POST /ai/embeddings/backfill` (ai:use)
  embeds all signed encounters of the clinic missing/outdated embeddings (batched, returns counts).
* `POST /ai/patients/:patientId/ask { question }` (ai:use): embed the question, select the top 6
  encounters of THAT patient by cosine distance (`embedding <=> $1::vector`, RLS + `patient_id` filter),
  build a prompt with those encounters (dates, SOAP, diagnoses) and the question, answer via the
  existing `AiProvider` with instructions to cite encounters as `[E1]`, `[E2]`… and to say when the
  record does not contain the answer; store an `AiInteraction` (feature `RECORD_QA` — add it to the
  `AiFeature` enum? NO schema changes allowed: use `PATIENT_SUMMARY` with `structuredOutput.kind =
  'RECORD_QA'`), write a `RecordAccessLog` `AI_RECORD_QA`. Response `{ answer, citations: [{ref, encounterId, occurredAt, chiefComplaint}], interactionId }`.

## B. Arabic + RTL + i18n (web) — owner: i18n agent

Scaffolding already in place: `@ngx-translate` with `MultiFileTranslateLoader` (merges
`/i18n/<lang>.json` and `/i18n/portal.<lang>.json`), `LanguageService` (signal `locale`, `dir`,
`t()`, `formatDate/Time/Number/Money`), base bundles `public/i18n/{en,ar}.json`, `<html lang="ar" dir="rtl">`
default, Noto Sans Arabic + Inter fonts.

Required:
* Every user-visible string in `src/app/{layout,pages,shared,core}` goes through `translate` pipe /
  `LanguageService.t()`; organise keys by feature (`dashboard.*`, `patients.*`, `calendar.*`, …) in
  `public/i18n/en.json` and `ar.json` (both complete, identical key sets — add a unit test that
  compares key sets).
* Language switcher in the top bar and on the login/register pages; persist; apply immediately
  (no reload). Save the staff preference via `PATCH /auth/me { locale }` (the portal/messaging agent
  adds that endpoint; call it best-effort).
* RTL: audit `styles.scss` and component styles — replace physical margins/paddings/positions
  (`margin-left`, `left`, `text-align: left`, `border-left`…) with logical properties
  (`margin-inline-start`, `inset-inline-start`, `text-align: start`, `border-inline-start`) or `[dir=rtl]`
  overrides; mirror icons/chevrons; sidebar on the right in RTL; calendar grid, dialogs, tables,
  dropdowns and the notifications bell must render correctly in both directions.
* Dates/times/numbers/currency via `LanguageService` formatters (Arabic locale with Latin digits);
  weekday names and month names localised in the calendar, availability editor and preferred-windows editor.
* API validation/error messages: map the most common server messages to translated toasts
  (unauthorized, forbidden, conflict, validation list) with a fallback to the raw message.
* Status chips, roles, appointment types, priorities and enum labels translated via a central
  `enums.*` key group.
* Unit tests: key-set parity, LanguageService dir/locale persistence, a formatter test.
* Screenshots of dashboard, calendar, patient detail and booking dialog in Arabic RTL.

## C. Patient portal + messaging (API `src/modules/{portal,messaging}`, web `src/app/portal`) — owners: portal API agent, portal web agent

### Messaging (API)
* `MessagingModule` exporting `MessagingService.send({ clinicId, patientId?, appointmentId?, channel, to, template, locale, params })`
  and `sendRaw(...)`. Providers behind interfaces: `SmsProvider`, `WhatsAppProvider`, `EmailProvider`
  with implementations `TwilioSmsProvider`, `TwilioWhatsAppProvider` (plain `fetch` to the Twilio REST
  API, Basic auth; no SDK), `SmtpEmailProvider` (nodemailer — add dependency) and `LogProvider`
  fallbacks selected from env (`MESSAGING_*_PROVIDER`). Every send persists a `messages` row
  (QUEUED → SENT/FAILED with provider ids). Templates are bilingual (`ar`/`en`) in code:
  `appointment.reminder`, `appointment.confirmed`, `appointment.cancelled`, `waitlist.offer`,
  `portal.otp`, `invoice.issued`. Reminder texts include "Reply 1 to confirm, 2 to cancel" (localised).
* Replace the `EmailSender` stub usage in reminders: `RemindersService` channel delivery → `MessagingService`
  (EMAIL/SMS/WHATSAPP). Reminder channel selection from `clinic.settings.reminderChannels`
  (default `['IN_APP','SMS']` when a phone exists) — the portal API agent may edit
  `src/modules/scheduling/reminders.service.ts` ONLY in the delivery/sync channel-selection parts.
* Inbound webhook `POST /webhooks/twilio/inbound` (public, Twilio signature validated with
  `TWILIO_AUTH_TOKEN` via HMAC-SHA1 over URL + sorted params; reject otherwise): parse `From`/`Body`,
  find the patient by phone across clinics (system context), interpret `1|نعم|yes|confirm` → CONFIRMED
  the next SCHEDULED appointment, `2|لا|no|cancel` → CANCELLED (which triggers waitlist backfill through
  the existing event), otherwise store as `intent: UNKNOWN`; persist the inbound `messages` row linked
  to the outbound one; reply with a short localised acknowledgement (TwiML). `GET /messages?patientId&channel&page`
  (`patients:read`) and `POST /messages { patientId, channel, body }` (`patients:write`) for staff.
* Twilio status callback `POST /webhooks/twilio/status` → updates `messages.status` (DELIVERED/FAILED).

### Patient portal (API `/portal/...`)
* Auth: `POST /portal/auth/request-otp { clinicSlug, phone }` (public, throttled 5/min/IP): finds an active
  patient with `portalEnabled` and that phone in the clinic; always responds 200 `{ sent: true }` (no
  enumeration); creates an `otp_codes` row (6 digits, bcrypt/sha256 hashed, TTL from env), sends via
  `MessagingService` template `portal.otp` (SMS). `POST /portal/auth/verify { clinicSlug, phone, code }` →
  checks latest unconsumed code, attempts ≤ max, marks consumed, returns `{ accessToken, patient:{id,firstName,lastName,locale}, clinic:{name,slug,timezone,currency} }`.
  Token: JWT `{ sub: patientId, clinicId, type: 'patient' }`, expiry `PORTAL_JWT_EXPIRES_IN`.
* Guard: `PortalAuthGuard` + `@PortalRoute()` decorator; it sets `tenantContext` `{ clinicId, patientId }`
  (add an optional `patientId` field to `TenantContext` — the portal API agent may edit
  `src/common/tenancy/tenant-context.ts` for this one field and `src/common/auth/jwt.strategy.ts` to
  REJECT `type: 'patient'` tokens on staff routes). Portal controllers use their own guard (mark with
  `@Public()` to skip the staff guard, then apply the portal guard).
* Endpoints (all under `/portal`, patient-scoped by `patientId` from the token, explicit filters in
  every query): `GET /me` (profile, consents, locale), `PATCH /me { locale, email, address }`,
  `GET /clinic` (public info: name, address, phone, timezone, doctors `{id,firstName,lastName,title,specialty}`),
  `GET /appointments?upcoming|past`, `GET /appointments/:id`, `GET /slots?doctorId|specialty&durationMinutes?&from&to`
  (uses `SlotSearchService.searchForClinic`, max 14 days, patientId set to avoid double booking),
  `POST /appointments { doctorId, startsAt, reason? }` (type CONSULTATION, duration = doctor default,
  createdById null, notes "Booked via patient portal", idempotency by `Idempotency-Key`), `POST /appointments/:id/confirm`,
  `POST /appointments/:id/cancel { reason? }` (≥ 2h before start, else 409),
  `GET /invoices`, `GET /invoices/:id`, `GET /waitlist` + `POST /waitlist { doctorId|specialty, priority: ROUTINE, preferredWindows? }`,
  `POST /waitlist/:id/accept|decline` (reuse `WaitlistService`), `GET /consents` + `POST /consents { type, version }`.
  Appointment mutations emit the standard `appointment.*` events (reuse `AppointmentsService` where
  possible by constructing an `AuthUser`-like actor for the patient — add a small adapter; or use the
  `AppointmentWriterService` from the waitlist module).
* Staff side: `PATCH /patients/:id` accepts `portalEnabled`, `locale` (the portal API agent may extend
  `patients.dto.ts` and the service `update` with these two fields); `PATCH /auth/me { locale }` for staff users.
* Notifications: when a patient books/cancels via the portal, staff notifications flow through the
  existing listeners (events). The patient receives a confirmation message (template `appointment.confirmed`).

### Patient portal (web, `src/app/portal/**`, routes already mounted at `/portal`)
* Own shell: mobile-first, bottom tab bar (Home, Appointments, Book, Invoices, Profile), clinic name,
  language switcher, logout. Default Arabic RTL (uses the shared `LanguageService`; portal strings in
  `public/i18n/portal.{ar,en}.json` under the `portal.*` key group).
* `PortalAuthService` (separate token key `cf.portal.token`, patient + clinic signals) and a
  `portalAuthInterceptor` that attaches the portal token ONLY to `/api/v1/portal/*` requests (must not
  interfere with the staff interceptor: register both; staff interceptor must skip `/portal/` URLs — the
  portal web agent may make that one-line change in `core/auth.interceptor.ts`).
* Pages: `/portal/:clinicSlug` login (phone → OTP code with resend countdown), home (next appointment
  card with Confirm/Cancel, outstanding balance, quick "Book"), book (choose doctor or specialty → day
  picker → slot grid from `/portal/slots` → reason → confirm, with 409 handling), appointments
  (upcoming/past), appointment detail, invoices list/detail, waitlist (join + offers accept/decline with
  countdown), profile (locale, email, consents with accept buttons). Consent gate on first login (PRIVACY v1).
* Unit tests for the OTP countdown and the portal interceptor URL rule; screenshots at phone width (390px).

---

Validation for every agent: `npx tsc -p tsconfig.build.json --noEmit`, `npx oxlint src/ test/`,
`npx vitest run`, and the relevant e2e file(s) for the API; `pnpm --filter web build` and
`pnpm --filter web test -- --watch=false` for the web. Never run git. Never create migrations.
