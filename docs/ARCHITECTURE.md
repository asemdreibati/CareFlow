# CareFlow Architecture

CareFlow is a multi-tenant clinic management platform. One deployment serves many
clinics; every clinic's data is isolated at the database level.

```
apps/
  api/   NestJS 12 (ESM, TypeScript 6) + Prisma 6 + PostgreSQL 16
  web/   Angular 21 (standalone components, signals)
```

## Request lifecycle (API)

1. `RequestContextMiddleware` creates a per-request `TenantContext` in
   `AsyncLocalStorage` (request id, ip, user agent).
2. `JwtAuthGuard` (global) validates the bearer token. `JwtStrategy.validate`
   re-checks the clinic membership on every request and fills the context with
   `clinicId`, `userId`, `role`, `doctorId` and the resolved permission set.
3. `PermissionsGuard` (global) enforces `@RequirePermissions(...)`.
4. The handler runs. Services use `PrismaService.db` (single operations) or
   `PrismaService.transaction(tx => ...)` (multi-step work).
5. `AuditInterceptor` (global) writes an append-only `audit_logs` row for every
   mutating request (and any handler decorated with `@Audit`), success or failure.
6. `PrismaExceptionFilter` maps database errors to HTTP (unique → 409, overlap → 409, missing → 404).

## Multi-tenancy: `clinic_id` + Row-Level Security

* Every clinic-scoped table has a `clinic_id` column and a PostgreSQL RLS policy:
  `clinic_id = careflow_current_clinic_id()`.
* `FORCE ROW LEVEL SECURITY` is on, so even the table owner (the app role) is subject to it.
* `PrismaService` sets `app.current_clinic_id`, `app.current_user_id` and
  `app.bypass_rls` with `set_config(..., true)` (transaction-local) before every
  query, from the `TenantContext`.
* A request with no clinic context sees **zero rows** and cannot insert.
* `tenantContext.runSystem(fn)` is the only way to bypass RLS. It is used for
  login (membership lookup across clinics), clinic provisioning, audit writes and
  seeds. **Important:** Prisma queries are lazy, so `await` must happen inside
  the `runSystem` callback.
* Services still filter by `clinicId` explicitly (defense in depth); RLS is the backstop.

## Permissions

`src/common/permissions/permissions.ts` defines fine-grained permission keys and
the default set per role (OWNER, ADMIN, DOCTOR, NURSE, RECEPTIONIST, ACCOUNTANT).
A membership can carry `extraPermissions`. Two notable rules:

* `patients:sensitive` gates decrypted identifiers (national ID). Everyone else
  gets a masked value, list endpoints never expose it.
* Doctors see only their own schedule and encounters unless they hold
  `appointments:read_all`. Services apply this using `user.doctorId`.

## Scheduling conflicts

Overlap checks happen twice:

1. In `AppointmentsService` (friendly validation: availability, time off, overlap).
2. In PostgreSQL: `appointments_no_overlap EXCLUDE USING gist (doctor_id WITH =,
   tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE status NOT IN ('CANCELLED','NO_SHOW')`.
   Concurrent bookings cannot both succeed; the loser gets 409.

## Scheduling engine

`apps/api/src/scheduling-engine/` is a pure, dependency-free library (interval
algebra with sweep-line union/subtraction/k-way intersection, a binary heap,
slot search scoring, recurrence expansion, min-cost bipartite matching, logistic
regression) that the appointments, resources, waitlist, series and scheduling
modules wire to the database. Features and algorithms are specified in
[SCHEDULING.md](SCHEDULING.md): smart cross-doctor slot search with
fragmentation-aware best-fit, multi-resource booking (rooms/equipment with their
own exclusion constraints), a priority-queue waitlist with automatic backfill
and timed holds, recurring series with per-occurrence conflict resolution,
reschedule proposals computed by min-cost matching when a doctor takes time off,
a per-clinic no-show prediction model, a reminder outbox worker, idempotent
booking and optimistic locking.

## Search

PostgreSQL only, no external search engine. `careflow_normalize()` (migration
`20261006090000`) folds Arabic diacritics, alef/taa-marbuta/alef-maqsura variants,
Arabic-Indic digits and Latin accents. `patients.search_text` is maintained by a
trigger and indexed with `pg_trgm` (substring + `word_similarity` ranking);
`encounters.search_vector` is a weighted `tsvector` over the SOAP fields with
highlighted snippets; diagnoses and invoice numbers have trigram indexes. All raw
SQL runs inside the tenant transaction so RLS applies, with explicit `clinic_id`
filters and bound parameters. Semantic search uses `pgvector`: signed encounters
are embedded (de-identified text, Gemini embeddings, 768 dimensions, HNSW cosine
index) and "ask the record" retrieves the closest encounters of one patient and
answers with citations through the AI provider.

## Patient portal and messaging

Patients log in per clinic with their phone number and a one-time code (hashed,
bound to clinic + phone, attempt-limited, no enumeration). The portal JWT has
`type: "patient"` and is accepted only by `PortalAuthGuard`, which puts
`clinicId` and `patientId` into the tenant context; staff routes reject it. Portal
actions reuse the appointment writer, so staff notifications, reminders and
waitlist backfill behave exactly as for staff-made changes.

`MessagingModule` sends SMS/WhatsApp (Twilio REST) and email (SMTP) through
provider interfaces, with a log provider for development. Every message is stored
in `messages`; bilingual templates live in code. Inbound replies arrive on a
signature-validated webhook: "1 / نعم" confirms and "2 / لا" cancels the next
appointment. The reminder worker delivers through the same service using the
clinic's configured channels.

## Localisation

The web app runs in Arabic (RTL, default) and English with runtime switching
(`@ngx-translate`, bundles under `public/i18n`, logical CSS properties). Staff
preference is stored in `users.locale`, patient preference in `patients.locale`,
clinic default in `clinic.settings.defaultLocale`; server-side messages resolve the
locale in that order.

## Sensitive data

* Passwords: bcrypt (12 rounds). Refresh tokens: random, stored hashed, rotated on use.
* `patients.national_id_enc`: AES-256-GCM via `FieldEncryptionService` (key from `FIELD_ENCRYPTION_KEY`).
* `record_access_logs`: who opened which patient record (append-only, DB trigger blocks UPDATE/DELETE).
* `audit_logs`: request-level trail with redacted bodies (append-only).
* Helmet, CORS allow-list, request throttling, validation whitelist (unknown fields rejected).

## Notifications

Domain events (`@nestjs/event-emitter`) → `NotificationsService` persists a
`notifications` row per recipient → pushes it over Socket.IO to the user's room
(`user:<id>`). Email is a logging stub (`EmailSender`) to be replaced by a provider.

## AI layer

`src/modules/ai` is isolated behind an `AiProvider` interface with two
implementations: Claude (`@anthropic-ai/sdk`) and Gemini (`@google/genai`).
Rules:

* AI never writes to a medical record directly. Output lands in `ai_interactions`
  with status `GENERATED`; a clinician must `APPROVE` it (optionally applying it
  to the encounter) or `REJECT` it. Every step is audited.
* Prompts receive the minimum data needed and strip direct identifiers
  (name, phone, national ID, email) before leaving the system.
* Every call records provider, model, token usage, latency and an input hash.
* Features: patient summary (pre-visit briefing) and SOAP note drafting from a
  clinician's dictation. No diagnosis or treatment recommendation features.

## Roadmap (not in MVP)

Patient portal, video appointments, automated reminders (scheduler + SMS/email),
insurance integration, analytics warehouse, document uploads.
