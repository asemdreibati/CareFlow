# CareFlow API contract

Base URL: `/api/v1`. All endpoints except `/health`, `/auth/register`, `/auth/login`,
`/auth/refresh` require `Authorization: Bearer <accessToken>`. Swagger UI at `/docs`.

Pagination: `?page=1&pageSize=25&search=` → `{ items, total, page, pageSize }`.
Errors: `{ statusCode, message, error }`. Validation errors return 400 with `message: string[]`.

## Auth (`/auth`) — implemented
| Method | Path | Body → Response |
|---|---|---|
| POST | /auth/register | `{clinicName, slug, timezone?, email, password, firstName, lastName}` → `{tokens, session}` |
| POST | /auth/login | `{email, password, clinicId?}` → `{tokens:{accessToken, refreshToken, expiresIn}, session}` |
| POST | /auth/refresh | `{refreshToken}` → `{tokens, session}` (rotates) |
| POST | /auth/logout | `{refreshToken?}` → 204 |
| POST | /auth/switch-clinic | `{clinicId}` → `{tokens, session}` |
| GET | /auth/me | → `session` |
| POST | /auth/change-password | `{currentPassword,newPassword}` → 204 |

`session = { user:{id,email,firstName,lastName,locale}, clinic:{id,name,slug,timezone,currency}, role, doctorId?, permissions:string[], clinics:[{id,name,slug,role}], invitations:[{id,clinic:{id,name},role,invitedAt}] }`

Access tokens are accepted only in the `Authorization: Bearer` header. Refresh tokens rotate atomically (one use).
Invitations: POST `/auth/invitations/:id/accept` and `/auth/invitations/:id/decline` (the invited user only).

## Clinic (`/clinic`) — implemented
GET `/clinic`, PATCH `/clinic`, GET `/clinic/stats` → `{patients, doctors, todayAppointments, upcoming, unpaidInvoices, outstanding}`

## Members (`/members`) — implemented
GET `/members` (each row has `status: ACTIVE|INACTIVE|INVITED`), GET `/members/permissions` → `{all, byRole}`, POST `/members` (invite), PATCH `/members/:id`, DELETE `/members/:id/invitation` (withdraw a pending invitation).
Inviting an email that already has an account creates a pending invitation the user must accept; nothing about the account is returned.
Members cannot change their own permissions; only owners may grant permissions outside their own role.

## Doctors (`/doctors`) — implemented
GET `/doctors?includeInactive`, GET `/doctors/:id` (includes `availability[]`, `timeOff[]`), POST, PATCH `/:id`, DELETE `/:id` (deactivate),
PUT `/doctors/:id/availability` `{slots:[{weekday 0-6, startTime "HH:mm", endTime, slotMinutes?}]}`,
POST `/doctors/:id/time-off` `{startsAt, endsAt, reason?}`, DELETE `/doctors/:id/time-off/:timeOffId`

## Patients (`/patients`) — implemented
GET `/patients?search&includeInactive`, GET `/patients/:id` (includes `allergies[]`, last 10 `appointments[]`, active `prescriptions[]`; logs access),
POST, PATCH `/:id`, DELETE `/:id` (deactivate), POST `/patients/:id/allergies`, DELETE `/patients/:id/allergies/:allergyId`,
GET `/patients/:id/access-log` (audit:read).
Patient view: `{..., nationalId (only with patients:sensitive, else null), nationalIdMasked}`.

## Appointments (`/appointments`) — implemented
| Method | Path | Notes |
|---|---|---|
| GET | /appointments?from&to&doctorId&patientId&status&page&pageSize | paginated; each item includes `doctor:{id,firstName,lastName,title,color}` and `patient:{id,mrn,firstName,lastName,phone}` |
| GET | /appointments/calendar?from&to&doctorId? | unpaginated list for calendar views (max 31 days) |
| GET | /appointments/availability?doctorId&date=YYYY-MM-DD&durationMinutes? | `{date, timezone, doctorId, slots:[{startsAt, endsAt}]}` from weekly availability minus time off minus booked |
| GET | /appointments/:id | with doctor, patient, encounter summary |
| POST | /appointments | `{doctorId, patientId, startsAt, endsAt? or durationMinutes?, type?, reason?, notes?}` → 201; 409 on overlap; 400 outside availability/in time off |
| PATCH | /appointments/:id | reschedule / edit `{startsAt?, endsAt?, doctorId?, type?, reason?, notes?}` (not allowed once COMPLETED/CANCELLED) |
| POST | /appointments/:id/status | 200; `{status, cancellationNote?}` with transitions: SCHEDULED→CONFIRMED/CHECKED_IN/CANCELLED/NO_SHOW; CONFIRMED→CHECKED_IN/CANCELLED/NO_SHOW; CHECKED_IN→IN_PROGRESS/CANCELLED; IN_PROGRESS→COMPLETED |

DOCTOR without `appointments:read_all` only sees/creates for `user.doctorId`.
Emits events: `appointment.created|updated|cancelled|checked_in` (payload: the appointment with doctor & patient).

## Medical records — implemented
| Method | Path | Notes |
|---|---|---|
| GET | /patients/:patientId/encounters | list (newest first) with doctor summary, diagnoses |
| POST | /patients/:patientId/encounters | `{appointmentId?, occurredAt?, chiefComplaint?, subjective?, objective?, assessment?, plan?, vitals?}` → DRAFT; doctorId = user.doctorId (NURSE must pass `doctorId`) |
| GET | /encounters/:id | full: diagnoses, prescriptions, patient summary; logs `VIEW_ENCOUNTER` |
| PATCH | /encounters/:id | DRAFT only (SIGNED → 409 unless `records:sign`, which sets status AMENDED) |
| POST | /encounters/:id/sign | records:sign; only the authoring doctor; sets SIGNED + signedAt; marks linked appointment COMPLETED |
| POST | /encounters/:id/diagnoses | `{code, description, isPrimary?}` |
| DELETE | /encounters/:id/diagnoses/:dxId | |
| POST | /encounters/:id/prescriptions | `{medication, dosage, frequency, durationDays?, instructions?}` |
| PATCH | /prescriptions/:id | `{status}` |

## Billing (`/billing`) — implemented
| Method | Path | Notes |
|---|---|---|
| GET/POST | /billing/services | price list; PATCH `/billing/services/:id` |
| GET | /billing/invoices?status&patientId&page | with patient summary |
| GET | /billing/invoices/:id | items, payments, patient |
| POST | /billing/invoices | `{patientId, appointmentId?, encounterId?, items:[{serviceId?, description?, quantity, unitPrice?}], discount?, tax?, dueAt?, notes?}` → DRAFT with computed totals; number `INV-YYYY-000001` per clinic |
| PATCH | /billing/invoices/:id | DRAFT only; replaces items/discount/tax |
| POST | /billing/invoices/:id/issue | DRAFT→ISSUED, sets issuedAt; emits `invoice.issued` |
| POST | /billing/invoices/:id/void | not PAID |
| POST | /billing/invoices/:id/payments | `{amount, method, reference?, paidAt?}`; updates amountPaid/status (PARTIALLY_PAID/PAID); overpayment → 400; emits `payment.received` |
| GET | /billing/summary?from&to | `{invoiced, collected, outstanding, byStatus}` |

## Notifications (`/notifications`) — implemented
GET `/notifications?unreadOnly` → `{items (latest 50), unreadCount}`; POST `/notifications/:id/read`; POST `/notifications/read-all`.
Socket.IO namespace `/notifications`, handshake `auth: { token }`, server emits `notification` (row) and `unread-count` `{count}`.
`NotificationsService.notify(userIds, {type, title, body, data?})` is the single entry point; listeners map domain events to recipients
(doctor's linked user + creator for appointment events; OWNER/ADMIN/ACCOUNTANT for billing events).

## AI (`/ai`) — implemented
| Method | Path | Notes |
|---|---|---|
| GET | /ai/status | `{enabled, provider, model}` (`model` is null when disabled) |
| POST | /ai/patients/:patientId/summary | → AiInteraction (feature PATIENT_SUMMARY, `output` markdown); logs `AI_SUMMARY` access |
| POST | /ai/encounters/:encounterId/soap-note | `{transcript}` → AiInteraction with `structuredOutput:{subjective, objective, assessment, plan}` |
| POST | /ai/interactions/:id/review | 200; `{decision:'APPROVED'|'REJECTED', applyToEncounter?:boolean}` (ai:review); applying copies SOAP fields into the DRAFT encounter |
| GET | /ai/interactions?patientId&feature | history |

## Audit (`/audit`) — implemented
GET `/audit?entityType&entityId&actorUserId&action&from&to&page&pageSize` (audit:read) → paginated audit rows.

## Search (`/search`, `/records/search`) — implemented (phase 3)
GET `/search?q&limit` → `{patients, encounters, invoices, appointments}` (entity groups gated by permissions);
GET `/search/diagnoses?q` → `[{code, description, uses}]`; GET `/records/search?q&patientId&doctorId&from&to&page&pageSize`
→ paginated encounters with `rank` and `snippet`. `GET /patients?search=` is trigram-based and Arabic-aware
(`careflow_normalize`). AI: POST `/ai/patients/:id/ask {question}` → `{answer, citations[], interactionId, retrieval}`;
POST `/ai/embeddings/backfill` → `{scanned, embedded, unchanged, failed}`.

## Patient portal (`/portal`) — implemented (phase 3)
Public, throttled: POST `/portal/auth/request-otp {clinicSlug, phone}` → `{sent:true}` (never reveals whether the phone exists);
POST `/portal/auth/verify {clinicSlug, phone, code}` → `{accessToken, expiresIn, patient, clinic}` (JWT type `patient`; rejected on staff routes).
With the patient token: GET/PATCH `/portal/me`, GET `/portal/clinic`, GET `/portal/appointments?scope=upcoming|past`,
GET `/portal/appointments/:id`, GET `/portal/slots?doctorId|specialty&durationMinutes&from&to`, POST `/portal/appointments {doctorId, startsAt, reason?}`
(idempotent via `Idempotency-Key`), POST `/portal/appointments/:id/confirm|cancel` (cancel < 2h before start → 409),
GET `/portal/invoices[/:id]`, GET/POST `/portal/waitlist`, POST `/portal/waitlist/:id/accept|decline`, GET/POST `/portal/consents {type, version}`.
Staff enable access per patient with `PATCH /patients/:id {portalEnabled: true, locale}`.
When several patients share the phone, verify returns `{requiresPatientSelection: true, candidates, selectionToken}` and
POST `/portal/auth/select {selectionToken, patientId}` completes the login. Limits: OTP requests 60 s apart and 3 per 15 min
per phone, a per-phone failure budget, at most 3 upcoming portal bookings within a 90-day horizon on the doctor's slot grid
(`clinic.settings.portalMaxActiveBookings`, `portalBookingHorizonDays`), patient cancellation ≥ 2 h before start (portal and SMS).

## Messaging (`/messages`, `/webhooks/twilio/*`) — implemented (phase 3)
GET `/messages?patientId&appointmentId&channel&direction&page` (patients:read), POST `/messages {patientId, channel, body, subject?, appointmentId?}` (patients:write).
Providers from env: SMS/WhatsApp via Twilio REST, email via SMTP, or `log` for development. Reminder channels per clinic
(`clinic.settings.reminderChannels`, default IN_APP + SMS when a phone exists). Inbound replies: POST `/webhooks/twilio/inbound`
(signature-validated) parses `1/نعم/yes` → CONFIRMED and `2/لا/no` → CANCELLED on the patient's next appointment and answers with TwiML;
POST `/webhooks/twilio/status` records delivery status. Replies act only on the appointment named by the latest
reminder/confirmation sent to that phone within 7 days; duplicate deliveries (same MessageSid) are ignored. Without
`TWILIO_AUTH_TOKEN`, webhooks are refused unless `TWILIO_WEBHOOK_INSECURE=1` (never in production). OTP bodies are masked in
`messages` and logs.
