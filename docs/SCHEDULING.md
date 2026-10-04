# Scheduling engine

Everything below builds on the pure primitives in `apps/api/src/scheduling-engine/`:

* `intervals.ts` — half-open `[start, end)` epoch-ms interval algebra: `normalize` (sweep-line union),
  `subtract`, `intersect`, `intersectMany` (k-way sweep with coverage counter), `freeIntervals`,
  `enumerateSlots`, `fragmentationCost` (best-fit scoring), `overlapsSorted` (binary search).
* `heap.ts` — `BinaryHeap<T>` priority queue and `topK`.
* `../modules/appointments/scheduling.ts` — timezone helpers (`zonedTimeToUtc`, `dayBounds`,
  `weekdayOfDate`), availability blocks, `findScheduleProblem`, status transition table.

Engine code is pure (no Nest/Prisma) and lives in `src/scheduling-engine/<feature>.ts` with
`*.spec.ts` tests next to it. Modules under `src/modules/*` wire it to the database and HTTP.

Permissions: `appointments:read|write` for search, waitlist and series; `doctors:read` to read the
resource catalogue and `resources:write` to change it (OWNER/ADMIN); `scheduling:manage` for reschedule proposals, no-show model and
reminders (OWNER, ADMIN, RECEPTIONIST, NURSE).

Data model additions (see `prisma/schema.prisma`): `Appointment.version`, `idempotencyKey`,
`holdExpiresAt`, `noShowRisk`, `seriesId`, `occurrenceIndex`, `isException`; tables `resources`,
`resource_bookings` (GiST exclusion per resource), `appointment_series`, `waitlist_entries`,
`reminders`, `no_show_models`, `reschedule_proposals`. All tenant tables have RLS.

Domain events (EventEmitter2, already emitted by `AppointmentsService.emit`):
`appointment.created|updated|cancelled|checked_in` with payload `AppointmentEvent`
(`src/modules/appointments/appointments.service.ts`). Any code that inserts/updates appointments
directly MUST emit the same events with the same payload shape so waitlist, reminders and
no-show scoring stay consistent.

---

## 1. Smart slot search  (`GET /appointments/search`) — owner: appointments module

Query: `durationMinutes` (required), `doctorId?`, `specialty?`, `from?` (ISO, default now),
`to?` (ISO, default from+14d, max 60d), `preferredDoctorId?`, `preferredWindows?`
(JSON-encoded `[{weekday,startTime,endTime}]`), `resourceIds?` (comma list), `limit?` (default 10, max 50),
`patientId?` (to avoid double-booking the patient).

Algorithm: for each candidate doctor (one, or all active doctors of the specialty/clinic):
availability blocks for each day in range → busy = active appointments ∪ time off (and the
patient's own appointments) → `freeIntervals` → `enumerateSlots` on the doctor's slot grid →
score each slot: `soonness` (hours from `from`, weight 1.0), `preferredDoctor` (−6h bonus),
`inPreferredWindow` (−3h bonus), `loadBalance` (+ minutes already booked that day / 30),
`fragmentation` (`fragmentationCost` with minUseful = doctor's slotMinutes, in minutes / 10).
Lower score wins; collect with `topK`. When `resourceIds` is given, slots must also lie in
`intersectMany` of the resources' free intervals.

Response: `{ query, candidates: [{ doctor:{id,firstName,lastName,title,specialty,color}, startsAt, endsAt,
score, reasons: string[] }] }` sorted by score.

## 2. Resources  (`/resources`) — owner: resources module + appointments module

`GET /resources?includeInactive`, `POST /resources {name,type,color?,notes?}`, `PATCH /resources/:id`,
`GET /resources/:id/bookings?from&to` → `{resource, from, to, bookings[]}` (with appointment summary),
`GET /resources/availability?resourceIds=a,b&date=YYYY-MM-DD&durationMinutes` → free slots common to ALL
listed resources (`intersectMany`).

Appointments accept `resourceIds?: string[]` on `POST /appointments` and `PATCH /appointments/:id`.
Booking validates each resource exists/active, computes the resources' free intervals and rejects
with 409 `Resource "<name>" is not available` when any is busy; writes `resource_bookings` rows in
the same transaction; the GiST constraint `resource_bookings_no_overlap` is the final arbiter
(translate violations to 409). On reschedule the booking rows are updated; on CANCELLED/NO_SHOW
`active=false`. Appointment responses include `resources: [{id,name,type,color}]`.

## 3. Booking robustness — owner: appointments module

* `POST /appointments` accepts header `Idempotency-Key` (or body `idempotencyKey`). The same key
  within the clinic returns the ORIGINAL appointment (200, with header `Idempotent-Replay: true`)
  instead of creating a second one. Keys are stored on the row (`idempotencyKey`, unique per clinic).
* Optimistic locking: `PATCH /appointments/:id` and `POST /appointments/:id/status` accept
  `expectedVersion?: number` (body) or `If-Match: <version>` header. When supplied and it does not
  match the row's `version` → 409 `Appointment was modified by someone else (version N)`. Every
  update increments `version` (atomic `updateMany where version = expected`). Responses include `version`.

## 4. Waitlist  (`/waitlist`) — owner: waitlist module

`GET /waitlist?status&doctorId&page`, `POST /waitlist {patientId, doctorId? | specialty?, durationMinutes?,
priority?, earliestAt?, latestAt?, preferredWindows?, type?, notes?}`, `PATCH /waitlist/:id`,
`DELETE /waitlist/:id` (→ CANCELLED), `GET /waitlist/matches/:id` → `{entry, candidates[]}` (earliest slots that satisfy the entry), `POST /waitlist/:id/book {startsAt, doctorId}` (book one of the
matches directly: creates the appointment and marks entry BOOKED), `POST /waitlist/:id/accept`
(patient accepted the offered hold: clears `holdExpiresAt`, entry → BOOKED), `POST /waitlist/:id/decline`
(cancel the held appointment, entry back to WAITING with `offerCount+1`).

Backfill algorithm (listener on `appointment.cancelled` and on doctor time-off removal is out of scope):
build the freed interval → load WAITING entries of the clinic whose `doctorId` matches (or specialty
matches the doctor) and whose `earliestAt/latestAt/preferredWindows` admit the slot and whose
`durationMinutes <= freed length` → `BinaryHeap` ordered by priority (URGENT > SOON > ROUTINE), then
`createdAt` → pop the best entry, create a HELD appointment (status SCHEDULED, `holdExpiresAt =
now + 24h`, notes "Waitlist offer"), entry → OFFERED with `offeredAppointmentId`, notify the patient's
creator user and the doctor's user (NotificationsService, type APPOINTMENT_CREATED, title "Waitlist offer").
Expiry: a `@Cron` every 5 minutes cancels held appointments whose `holdExpiresAt < now`
(status CANCELLED, cancellationNote "Hold expired"), returns the entry to WAITING, and re-runs
backfill for the freed slot (next candidate), bounded to 3 offers per entry (then stays WAITING without
auto-offers). Must run in `tenantContext.runSystem` per clinic (iterate distinct clinic ids).

## 5. Recurring series  (`/series`) — owner: series module

`POST /series {doctorId, patientId, frequency: DAILY|WEEKLY|MONTHLY, interval?, byWeekday?: number[],
byMonthDay?, startsOn: YYYY-MM-DD, startTime: "HH:mm", durationMinutes, count? | until?, type?, reason?,
resolve?: 'skip'|'next-slot'|'fail' (default 'next-slot')}`.
Occurrence generation (`scheduling-engine/recurrence.ts`, pure): expand the rule in the clinic
timezone (DST-safe via `zonedTimeToUtc`), max 365 occurrences, `count` xor `until` required.
For each occurrence check availability/time-off/overlap (`findScheduleProblem` + busy intervals);
conflicts are resolved per `resolve`: `skip` (drop it), `next-slot` (move to the earliest free
slot the same day, else the next day within 3 days, flagged `isException=true`), `fail` (409 with
the list of conflicting occurrences, nothing created). All inserts in ONE transaction with
`seriesId`/`occurrenceIndex`; emit `appointment.created` per row.
Response: `{ series, created: Appointment[], skipped: [{index, plannedStartsAt, reason}] }`.
`GET /series?patientId&doctorId&status`, `GET /series/:id` (with occurrences),
`PATCH /series/:id {reason?, status: CANCELLED}` → cancels all FUTURE non-final occurrences (emits
`appointment.cancelled` each), `POST /series/:id/occurrences/:index/detach` → marks that
appointment `isException=true` and `seriesId=null` so it can be edited independently.
Editing a single occurrence via `PATCH /appointments/:id` is allowed and sets `isException=true`
(owner: appointments module).

## 6. Reschedule cascade  (`/scheduling/reschedule-proposals`) — owner: scheduling module

`POST /scheduling/time-off-impact {doctorId, startsAt, endsAt, allowOtherDoctors?, searchDays?}` → preview
(not persisted): `{doctor, timeOff, searchWindow, candidateCount, affected[], items[], unresolvedAppointmentIds,
totalDisplacementMinutes}`; items for unresolved appointments carry `to: null`.
`POST /scheduling/reschedule-proposals {doctorId, startsAt, endsAt, reason?, allowOtherDoctors?: boolean,
searchDays?: number (default 14), createTimeOff?: boolean}` → computes and PERSISTS a proposal;
when `createTimeOff` is true also inserts the `doctor_time_off` row in the same transaction
(bypassing the doctors module's "has appointments" guard, because the proposal handles them).
Algorithm (`scheduling-engine/matching.ts`, pure): displaced appointments = rows (left side);
candidate slots = free slots of the same doctor (and, if allowed, other active doctors of the same
specialty) within `searchDays` after the time off (right side, deduplicated on a grid of each
doctor's slotMinutes, capped at ~2000 candidates). Cost(appointment, slot) = |slot.start − original.start|
in minutes + 240 if the doctor changes + 60 if the slot is on a different weekday + ∞ if the
duration does not fit or the slot overlaps the patient's other appointments. Solve the assignment
with min-cost bipartite matching (successive shortest augmenting path with potentials / Hungarian;
implement generically with unit tests, including a brute-force comparison on small random instances).
Unmatched appointments are listed in `unresolvedAppointmentIds`.
`GET /scheduling/reschedule-proposals?status`, `GET /scheduling/reschedule-proposals/:id`,
`POST /scheduling/reschedule-proposals/:id/apply {itemAppointmentIds?: string[]}` → moves the
selected (default all) appointments in a transaction (update startsAt/endsAt/doctorId, `version+1`,
re-validate overlap; a failing item is recorded with `error` and the others still apply),
emits `appointment.updated`, status APPLIED or PARTIALLY_APPLIED; `POST .../dismiss`.

## 7. No-show prediction + reminders — owner: scheduling module

Model (`scheduling-engine/logistic.ts`, pure): logistic regression trained by gradient descent
with L2 regularisation on standardised features; functions `trainLogistic(samples, {epochs, lr, l2})`
→ `{bias, weights, means, scales, metrics:{accuracy, auc, positiveRate, n}}` and
`predictLogistic(model, features)`. Unit tests on synthetic separable data (AUC > 0.9) and a
brute-force AUC check.
Features per appointment: patient's historical no-show rate (Laplace-smoothed), patient's number of
past appointments, lead time in days (created → start), hour of day, weekday, is follow-up,
patient age (or 0), days since the patient's last visit (capped).
`POST /scheduling/no-show-model/train` → trains on the clinic's COMPLETED vs NO_SHOW appointments
(min 30 samples else 400), upserts `no_show_models`, returns metrics. `GET /scheduling/no-show-model`.
Scoring: listener on `appointment.created` (and `updated`) computes `noShowRisk` and stores it when a
model exists; `GET /appointments` and calendar already return the column. `GET /scheduling/no-show/at-risk?date&threshold?`
→ `{date, timezone, threshold, items[]}`: appointments of that day with risk ≥ threshold (default 0.5) sorted desc (for extra reminders / controlled overbooking).
A nightly `@Cron` retrains every clinic with ≥ 30 samples.

Reminders: on `appointment.created|updated` upsert `reminders` rows for channels IN_APP (24h and 2h
before) and EMAIL (24h before) if the start is in the future; on `cancelled` → CANCELLED.
`@Cron` every minute: claim PENDING rows with `scheduledFor <= now` (`updateMany ... status='PENDING'`
→ in-flight marker via `attempts+1`, batch 100), send (IN_APP → NotificationsService to the patient's
creator/doctor user with type APPOINTMENT_REMINDER; EMAIL → `EmailSender` stub to the patient's email),
mark SENT or FAILED with `lastError` (max 3 attempts). `GET /scheduling/reminders?appointmentId&status`.

---

## Frontend (apps/web) — owner: web agent

* Calendar → "Find a slot" panel (smart search form + ranked candidates with reasons, one-click book).
* Resources page (`/resources`: catalogue CRUD, per-resource day view) and a resources multi-select in
  the booking dialog with 409 messages.
* Waitlist board (`/waitlist`): entries grouped by status with priority chips, add dialog, "Matches"
  drawer with book button, accept/decline for OFFERED entries, countdown to offer expiry.
* Series: "Repeat…" section in the booking dialog (frequency, weekdays, count/until, resolve policy)
  and a series summary on the appointment page (occurrence N of M, detach).
* Reschedule proposals (`/scheduling/proposals`): create from a doctor's time off (impact preview →
  proposal table with from/to/doctor change/displacement → apply selected / dismiss).
* No-show risk badge on dashboard/calendar/appointment detail (≥0.5 amber, ≥0.75 red), "Train model"
  button on Settings with metrics, at-risk list on the dashboard.
* Reminders status list on the appointment page.
* Booking dialog sends `Idempotency-Key` (uuid per dialog open) and PATCH sends `If-Match`.
