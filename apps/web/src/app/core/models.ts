/** TypeScript interfaces mirroring docs/API.md */

export type Role = 'OWNER' | 'ADMIN' | 'DOCTOR' | 'NURSE' | 'RECEPTIONIST' | 'ACCOUNTANT';
export const ROLES: Role[] = ['OWNER', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'ACCOUNTANT'];

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiError {
  statusCode: number;
  message: string | string[];
  error?: string;
}

// ---------- Auth ----------
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}
export interface SessionUser { id: string; email: string; firstName: string; lastName: string; locale?: 'ar' | 'en' | null; }
export interface SessionClinic { id: string; name: string; slug: string; timezone: string; currency: string; }
export interface ClinicSummary { id: string; name: string; slug: string; role: Role; }
export interface Session {
  user: SessionUser;
  clinic: SessionClinic;
  role: Role;
  doctorId?: string | null;
  permissions: string[];
  clinics: ClinicSummary[];
  /** Pending invitations from other clinics (accept to add the clinic to the switcher). */
  invitations?: ClinicInvitation[];
}
export interface ClinicInvitation { id: string; clinic: { id: string; name: string }; role: Role; invitedAt: string; }
export interface AuthResponse { tokens: Tokens; session: Session; }
export interface LoginDto { email: string; password: string; clinicId?: string; }
export interface RegisterDto {
  clinicName: string; slug: string; timezone?: string;
  email: string; password: string; firstName: string; lastName: string;
}

// ---------- Clinic ----------
export interface Clinic {
  id: string; name: string; slug: string; timezone: string; phone?: string | null; email?: string | null;
  address?: string | null; currency: string; settings?: Record<string, unknown>; isActive: boolean; createdAt: string;
}
export interface ClinicStats {
  patients: number; doctors: number; todayAppointments: number; upcoming: number; unpaidInvoices: number; outstanding: number;
}

// ---------- Members ----------
export interface Member {
  id: string; role: Role; extraPermissions: string[]; isActive: boolean; createdAt: string;
  user: { id: string; email: string; firstName: string; lastName: string; phone?: string | null; lastLoginAt?: string | null };
}
export interface PermissionsCatalog { all: string[]; byRole: Record<Role, string[]>; }
export interface InviteMemberDto {
  email: string; firstName: string; lastName: string; role: Role; password: string; extraPermissions?: string[];
}
export interface UpdateMemberDto { role?: Role; extraPermissions?: string[]; isActive?: boolean; }

// ---------- Doctors ----------
export interface AvailabilitySlot { id?: string; weekday: number; startTime: string; endTime: string; slotMinutes?: number; }
export interface TimeOff { id: string; startsAt: string; endsAt: string; reason?: string | null; }
export interface Doctor {
  id: string; userId?: string | null; firstName: string; lastName: string; title?: string | null; specialty: string;
  licenseNumber?: string | null; phone?: string | null; email?: string | null; color?: string | null; bio?: string | null;
  isActive: boolean; createdAt: string; updatedAt: string;
  availability?: AvailabilitySlot[]; timeOff?: TimeOff[];
}
export type DoctorRef = Pick<Doctor, 'id' | 'firstName' | 'lastName' | 'title' | 'color'>;
export interface DoctorDto {
  firstName: string; lastName: string; title?: string; specialty: string; licenseNumber?: string; phone?: string;
  email?: string; color?: string; bio?: string; userId?: string; isActive?: boolean;
}

// ---------- Patients ----------
export type Gender = 'MALE' | 'FEMALE' | 'OTHER' | 'UNKNOWN';
export type AllergySeverity = 'MILD' | 'MODERATE' | 'SEVERE' | 'LIFE_THREATENING';
export interface Allergy { id: string; substance: string; reaction?: string | null; severity?: AllergySeverity | null; }
export interface EmergencyContact { name?: string; phone?: string; relation?: string; }
export interface Patient {
  id: string; mrn: string; firstName: string; lastName: string; dateOfBirth?: string | null; gender?: Gender | null;
  phone?: string | null; email?: string | null; address?: string | null; bloodType?: string | null;
  emergencyContact?: EmergencyContact | null; notes?: string | null; isActive: boolean; createdAt: string; updatedAt: string;
  nationalId?: string | null; nationalIdMasked?: string | null;
  /** Patient may log in to the patient portal (phone OTP). */
  portalEnabled?: boolean; locale?: 'ar' | 'en' | null;
  allergies?: Allergy[]; appointments?: Appointment[]; prescriptions?: Prescription[];
}
export type PatientRef = Pick<Patient, 'id' | 'mrn' | 'firstName' | 'lastName' | 'phone'>;
export interface PatientDto {
  firstName: string; lastName: string; dateOfBirth?: string; gender?: Gender; phone?: string; email?: string; address?: string;
  nationalId?: string; bloodType?: string; emergencyContact?: EmergencyContact; notes?: string; isActive?: boolean;
}
/** PATCH body: `null` clears an optional field; portal access + preferred language are edit-only on the API. */
export type PatientUpdateDto = { [K in keyof PatientDto]?: PatientDto[K] | null } & { portalEnabled?: boolean; locale?: 'ar' | 'en' | null };
/** `null` clears an optional field on PATCH. */
export type NullablePatch<T> = { [K in keyof T]?: T[K] | null };
export interface AccessLogRow { id: string; userId: string; encounterId?: string | null; action: string; createdAt: string; user?: SessionUser; }

// ---------- Appointments ----------
export type AppointmentStatus = 'SCHEDULED' | 'CONFIRMED' | 'CHECKED_IN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
export type AppointmentType = 'CONSULTATION' | 'FOLLOW_UP' | 'PROCEDURE' | 'CHECKUP' | 'EMERGENCY';
export const APPOINTMENT_TYPES: AppointmentType[] = ['CONSULTATION', 'FOLLOW_UP', 'PROCEDURE', 'CHECKUP', 'EMERGENCY'];
export const APPOINTMENT_STATUSES: AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];
/** Allowed transitions per the API contract. */
export const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  SCHEDULED: ['CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};
export interface Appointment {
  id: string; doctorId: string; patientId: string; startsAt: string; endsAt: string; status: AppointmentStatus;
  type?: AppointmentType | null; reason?: string | null; notes?: string | null; cancellationNote?: string | null;
  createdById?: string | null; createdAt: string; updatedAt: string;
  doctor?: DoctorRef; patient?: PatientRef;
  encounter?: { id: string; status: EncounterStatus } | null;
  // Scheduling engine (docs/SCHEDULING.md)
  /** Optimistic-locking version; sent back as `If-Match` on PATCH / status changes. */
  version?: number;
  holdExpiresAt?: string | null;
  /** Predicted no-show probability 0..1 (null until a model exists). */
  noShowRisk?: number | null;
  seriesId?: string | null;
  occurrenceIndex?: number | null;
  isException?: boolean;
  resources?: ResourceRef[];
  series?: Pick<AppointmentSeries, 'id' | 'frequency' | 'interval' | 'count' | 'until' | 'status'> | null;
}
export interface AppointmentQuery {
  from?: string; to?: string; doctorId?: string; patientId?: string; status?: AppointmentStatus; page?: number; pageSize?: number;
}
export interface CreateAppointmentDto {
  doctorId: string; patientId: string; startsAt: string; endsAt?: string; durationMinutes?: number;
  type?: AppointmentType; reason?: string; notes?: string; resourceIds?: string[]; idempotencyKey?: string;
}
export interface UpdateAppointmentDto {
  startsAt?: string; endsAt?: string; doctorId?: string; type?: AppointmentType; reason?: string; notes?: string;
  resourceIds?: string[]; expectedVersion?: number;
}
export interface AvailabilityResponse { date: string; slots: { startsAt: string; endsAt: string }[]; }

// ---------- Records ----------
export type EncounterStatus = 'DRAFT' | 'SIGNED' | 'AMENDED';
export type PrescriptionStatus = 'ACTIVE' | 'COMPLETED' | 'DISCONTINUED';
export interface Vitals {
  temperature?: number | null; heartRate?: number | null; bloodPressure?: string | null; weight?: number | null;
  [k: string]: unknown;
}
export interface Diagnosis { id: string; code: string; description: string; isPrimary: boolean; }
export interface Prescription {
  id: string; encounterId: string; patientId: string; doctorId: string; medication: string; dosage: string; frequency: string;
  durationDays?: number | null; instructions?: string | null; status: PrescriptionStatus; createdAt: string;
}
export interface Encounter {
  id: string; patientId: string; doctorId: string; appointmentId?: string | null; occurredAt: string;
  chiefComplaint?: string | null; subjective?: string | null; objective?: string | null; assessment?: string | null;
  plan?: string | null; vitals?: Vitals | null; status: EncounterStatus; signedAt?: string | null; createdAt: string; updatedAt: string;
  doctor?: DoctorRef; patient?: PatientRef; diagnoses?: Diagnosis[]; prescriptions?: Prescription[];
}
export interface EncounterDto {
  appointmentId?: string; occurredAt?: string; chiefComplaint?: string; subjective?: string; objective?: string;
  assessment?: string; plan?: string; vitals?: Vitals; doctorId?: string;
}

// ---------- Billing ----------
export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'VOID';
export const INVOICE_STATUSES: InvoiceStatus[] = ['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID'];
export type PaymentMethod = 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'INSURANCE' | 'OTHER';
export const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'CARD', 'BANK_TRANSFER', 'INSURANCE', 'OTHER'];
export interface Service { id: string; code: string; name: string; price: number | string; durationMinutes: number; isActive: boolean; }
export interface ServiceDto { code: string; name: string; price: number; durationMinutes?: number; isActive?: boolean; }
export interface InvoiceItem { id?: string; serviceId?: string | null; description: string; quantity: number; unitPrice: number | string; total?: number | string; }
export interface Payment { id: string; amount: number | string; method: PaymentMethod; reference?: string | null; paidAt: string; }
export interface Invoice {
  id: string; patientId: string; appointmentId?: string | null; encounterId?: string | null; number: string; status: InvoiceStatus;
  currency: string; subtotal: number | string; discount: number | string; tax: number | string; total: number | string;
  amountPaid: number | string; issuedAt?: string | null; dueAt?: string | null; notes?: string | null; createdAt: string;
  patient?: PatientRef; items?: InvoiceItem[]; payments?: Payment[];
}
export interface CreateInvoiceDto {
  patientId: string; appointmentId?: string; encounterId?: string;
  items: { serviceId?: string; description?: string; quantity: number; unitPrice?: number }[];
  discount?: number; tax?: number; dueAt?: string; notes?: string;
}
export interface PaymentDto { amount: number; method: PaymentMethod; reference?: string; paidAt?: string; }
export interface BillingSummary { invoiced: number; collected: number; outstanding: number; byStatus: Record<string, number>; }

// ---------- Notifications ----------
export type NotificationType =
  | 'APPOINTMENT_CREATED' | 'APPOINTMENT_UPDATED' | 'APPOINTMENT_CANCELLED' | 'APPOINTMENT_REMINDER' | 'PATIENT_CHECKED_IN'
  | 'INVOICE_ISSUED' | 'PAYMENT_RECEIVED' | 'AI_RESULT_READY' | 'SYSTEM';
export interface Notification {
  id: string; type: NotificationType; title: string; body: string; data?: Record<string, unknown> | null;
  readAt?: string | null; createdAt: string;
}
export interface NotificationsResponse { items: Notification[]; unreadCount: number; }

// ---------- AI ----------
export type AiFeature = 'PATIENT_SUMMARY' | 'SOAP_NOTE';
export type AiInteractionStatus = 'GENERATED' | 'APPROVED' | 'REJECTED' | 'FAILED';
export interface AiStatus { enabled: boolean; provider?: string; model?: string; }
export interface AiInteraction {
  id: string; userId: string; patientId?: string | null; encounterId?: string | null; feature: AiFeature; provider: string; model: string;
  output?: string | null; structuredOutput?: { subjective?: string; objective?: string; assessment?: string; plan?: string } | null;
  status: AiInteractionStatus; error?: string | null; inputTokens?: number | null; outputTokens?: number | null; latencyMs?: number | null;
  reviewedById?: string | null; reviewedAt?: string | null; createdAt: string;
}

// ---------- Audit ----------
export interface AuditRow {
  id: string; actorUserId?: string | null; actorEmail?: string | null; action: string; entityType?: string | null;
  entityId?: string | null; method: string; path: string; statusCode: number; ip?: string | null; durationMs: number; createdAt: string;
}
export interface AuditQuery {
  entityType?: string; entityId?: string; actorUserId?: string; action?: string; from?: string; to?: string; page?: number; pageSize?: number;
}

// ====================== Scheduling engine (docs/SCHEDULING.md) ======================

/** Acceptable time window on a weekday (0 = Sunday … 6 = Saturday), "HH:mm" local clinic time. */
export interface PreferredWindow { weekday: number; startTime: string; endTime: string; }

// ---------- Smart slot search ----------
export interface SlotSearchQuery {
  durationMinutes: number; doctorId?: string; specialty?: string; from?: string; to?: string; preferredDoctorId?: string;
  preferredWindows?: PreferredWindow[]; resourceIds?: string[]; limit?: number; patientId?: string;
}
export interface SlotCandidate {
  doctor: DoctorRef & { specialty?: string }; startsAt: string; endsAt: string; score: number; reasons?: string[];
}
export interface SlotSearchResponse { query: Record<string, unknown>; candidates: SlotCandidate[]; }

// ---------- Resources ----------
export type ResourceType = 'ROOM' | 'EQUIPMENT' | 'STAFF' | 'OTHER';
export const RESOURCE_TYPES: ResourceType[] = ['ROOM', 'EQUIPMENT', 'STAFF', 'OTHER'];
export interface Resource {
  id: string; name: string; type: ResourceType; color?: string | null; notes?: string | null; isActive: boolean; createdAt?: string;
}
export type ResourceRef = Pick<Resource, 'id' | 'name' | 'type' | 'color'>;
export interface ResourceDto { name: string; type: ResourceType; color?: string; notes?: string; isActive?: boolean; }
export interface ResourceBooking {
  id: string; resourceId: string; appointmentId: string; startsAt: string; endsAt: string; active: boolean;
  appointment?: Pick<Appointment, 'id' | 'status' | 'type' | 'startsAt' | 'endsAt' | 'doctorId' | 'patientId'> & { doctor?: DoctorRef; patient?: PatientRef };
}
export interface ResourceAvailabilityResponse { date: string; resourceIds?: string[]; slots: { startsAt: string; endsAt: string }[]; }

// ---------- Waitlist ----------
export type WaitlistPriority = 'ROUTINE' | 'SOON' | 'URGENT';
export const WAITLIST_PRIORITIES: WaitlistPriority[] = ['URGENT', 'SOON', 'ROUTINE'];
export type WaitlistStatus = 'WAITING' | 'OFFERED' | 'BOOKED' | 'EXPIRED' | 'CANCELLED';
export const WAITLIST_STATUSES: WaitlistStatus[] = ['WAITING', 'OFFERED', 'BOOKED', 'EXPIRED', 'CANCELLED'];
export interface WaitlistEntry {
  id: string; patientId: string; doctorId?: string | null; specialty?: string | null; durationMinutes: number; priority: WaitlistPriority;
  earliestAt: string; latestAt?: string | null; preferredWindows: PreferredWindow[]; type?: AppointmentType | null; notes?: string | null;
  status: WaitlistStatus; offeredAppointmentId?: string | null; offerExpiresAt?: string | null; offerCount: number;
  createdAt: string; updatedAt: string;
  patient?: PatientRef; doctor?: DoctorRef | null; offeredAppointment?: Appointment | null;
}
export interface WaitlistDto {
  patientId: string; doctorId?: string; specialty?: string; durationMinutes?: number; priority?: WaitlistPriority;
  earliestAt?: string; latestAt?: string; preferredWindows?: PreferredWindow[]; type?: AppointmentType; notes?: string;
}
export interface WaitlistQuery { status?: WaitlistStatus; doctorId?: string; page?: number; pageSize?: number; }

// ---------- Recurring series ----------
export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export const RECURRENCE_FREQUENCIES: RecurrenceFrequency[] = ['DAILY', 'WEEKLY', 'MONTHLY'];
export type SeriesStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type SeriesResolvePolicy = 'skip' | 'next-slot' | 'fail';
export interface AppointmentSeries {
  id: string; doctorId: string; patientId: string; frequency: RecurrenceFrequency; interval: number; byWeekday: number[];
  byMonthDay?: number | null; startsOn: string; startTime: string; durationMinutes: number; count?: number | null; until?: string | null;
  type?: AppointmentType | null; reason?: string | null; status: SeriesStatus; createdAt: string; updatedAt?: string;
  doctor?: DoctorRef; patient?: PatientRef; appointments?: Appointment[]; occurrences?: Appointment[];
}
export interface CreateSeriesDto {
  doctorId: string; patientId: string; frequency: RecurrenceFrequency; interval?: number; byWeekday?: number[]; byMonthDay?: number;
  startsOn: string; startTime: string; durationMinutes: number; count?: number; until?: string; type?: AppointmentType; reason?: string;
  resolve?: SeriesResolvePolicy;
}
export interface SkippedOccurrence { index: number; plannedStartsAt: string; reason: string; }
export interface CreateSeriesResponse { series: AppointmentSeries; created: Appointment[]; skipped: SkippedOccurrence[]; }

// ---------- Reschedule proposals ----------
export type ProposalStatus = 'PENDING' | 'APPLIED' | 'PARTIALLY_APPLIED' | 'DISMISSED';
export interface ProposalItem {
  appointmentId: string; patientId?: string; patientName?: string;
  /** Original start (ISO). */
  from: string;
  /** Proposed start (ISO); null when no slot was found (unresolved). */
  to: string | null; toEndsAt?: string | null;
  fromDoctorId: string; toDoctorId: string | null; toDoctorName?: string | null;
  durationMinutes?: number; displacementMinutes: number; cost?: number | null; version?: number; applied?: boolean; error?: string | null;
}
export interface RescheduleProposal {
  id: string; cause: string; doctorTimeOffId?: string | null; items: ProposalItem[]; unresolvedAppointmentIds: string[];
  totalDisplacementMinutes: number; status: ProposalStatus; createdById?: string | null; appliedById?: string | null;
  appliedAt?: string | null; createdAt: string;
  doctor?: DoctorRef; unresolvedAppointments?: Appointment[];
}
export interface TimeOffImpactDto { doctorId: string; startsAt: string; endsAt: string; allowOtherDoctors?: boolean; searchDays?: number; }
export interface AffectedAppointment {
  id: string; patientId: string; patientName: string; doctorId: string; startsAt: string; endsAt: string; status: AppointmentStatus;
  type?: AppointmentType | null; version?: number;
}
/** Preview of a planned time off (not persisted): displaced appointments + the computed moves. */
export interface TimeOffImpact {
  doctor?: DoctorRef & { specialty?: string }; timeOff?: { startsAt: string; endsAt: string }; searchWindow?: { from: string; to: string };
  candidateCount?: number; affected: AffectedAppointment[]; items: ProposalItem[]; unresolvedAppointmentIds: string[]; totalDisplacementMinutes: number;
}
export interface CreateProposalDto extends TimeOffImpactDto { reason?: string; createTimeOff?: boolean; }

// ---------- No-show model + reminders ----------
export interface NoShowModelMetrics { accuracy?: number; auc?: number; positiveRate?: number; n?: number; }
export interface NoShowModel {
  id?: string; sampleSize?: number; metrics?: NoShowModelMetrics | null; trainedAt: string; parameters?: unknown;
}
export type ReminderChannel = 'IN_APP' | 'EMAIL' | 'SMS';
export type ReminderStatus = 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
export interface Reminder {
  id: string; appointmentId: string; channel: ReminderChannel; scheduledFor: string; status: ReminderStatus; attempts: number;
  lastError?: string | null; sentAt?: string | null; createdAt: string;
}
