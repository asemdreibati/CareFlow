-- Extensions required by exclusion constraints on uuid + range columns
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'ACCOUNTANT');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AllergySeverity" AS ENUM ('MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('SCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "AppointmentType" AS ENUM ('CONSULTATION', 'FOLLOW_UP', 'PROCEDURE', 'CHECKUP', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "EncounterStatus" AS ENUM ('DRAFT', 'SIGNED', 'AMENDED');

-- CreateEnum
CREATE TYPE "PrescriptionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'BANK_TRANSFER', 'INSURANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('APPOINTMENT_CREATED', 'APPOINTMENT_UPDATED', 'APPOINTMENT_CANCELLED', 'APPOINTMENT_REMINDER', 'PATIENT_CHECKED_IN', 'INVOICE_ISSUED', 'PAYMENT_RECEIVED', 'AI_RESULT_READY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AiFeature" AS ENUM ('PATIENT_SUMMARY', 'SOAP_NOTE');

-- CreateEnum
CREATE TYPE "AiInteractionStatus" AS ENUM ('GENERATED', 'APPROVED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "clinics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "clinics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinic_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "extra_permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "clinic_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "user_id" UUID,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "title" TEXT,
    "specialty" TEXT NOT NULL,
    "license_number" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "color" TEXT NOT NULL DEFAULT '#2563eb',
    "bio" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "doctors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_availability" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "slot_minutes" INTEGER NOT NULL DEFAULT 30,

    CONSTRAINT "doctor_availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_time_off" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "reason" TEXT,

    CONSTRAINT "doctor_time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "mrn" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "date_of_birth" DATE,
    "gender" "Gender" NOT NULL DEFAULT 'UNKNOWN',
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "national_id_enc" TEXT,
    "blood_type" TEXT,
    "emergency_contact" JSONB,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allergies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "substance" TEXT NOT NULL,
    "reaction" TEXT,
    "severity" "AllergySeverity" NOT NULL DEFAULT 'MODERATE',
    "noted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allergies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "type" "AppointmentType" NOT NULL DEFAULT 'CONSULTATION',
    "reason" TEXT,
    "notes" TEXT,
    "cancellation_note" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "appointment_id" UUID,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chief_complaint" TEXT,
    "subjective" TEXT,
    "objective" TEXT,
    "assessment" TEXT,
    "plan" TEXT,
    "vitals" JSONB,
    "status" "EncounterStatus" NOT NULL DEFAULT 'DRAFT',
    "signed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "encounters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnoses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "diagnoses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "medication" TEXT NOT NULL,
    "dosage" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "duration_days" INTEGER,
    "instructions" TEXT,
    "status" "PrescriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_access_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "encounter_id" UUID,
    "action" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "duration_minutes" INTEGER NOT NULL DEFAULT 30,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "appointment_id" UUID,
    "encounter_id" UUID,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMPTZ,
    "due_at" TIMESTAMPTZ,
    "notes" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "service_id" UUID,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "reference" TEXT,
    "paid_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID,
    "actor_user_id" UUID,
    "actor_email" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "request_body" JSONB,
    "diff" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_interactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "patient_id" UUID,
    "encounter_id" UUID,
    "feature" "AiFeature" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "output" TEXT,
    "structured_output" JSONB,
    "status" "AiInteractionStatus" NOT NULL DEFAULT 'GENERATED',
    "error" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clinics_slug_key" ON "clinics"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "clinic_memberships_user_id_idx" ON "clinic_memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "clinic_memberships_clinic_id_user_id_key" ON "clinic_memberships"("clinic_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "doctors_clinic_id_idx" ON "doctors"("clinic_id");

-- CreateIndex
CREATE INDEX "doctors_clinic_id_user_id_idx" ON "doctors"("clinic_id", "user_id");

-- CreateIndex
CREATE INDEX "doctor_availability_clinic_id_doctor_id_idx" ON "doctor_availability"("clinic_id", "doctor_id");

-- CreateIndex
CREATE INDEX "doctor_time_off_clinic_id_doctor_id_starts_at_idx" ON "doctor_time_off"("clinic_id", "doctor_id", "starts_at");

-- CreateIndex
CREATE INDEX "patients_clinic_id_last_name_first_name_idx" ON "patients"("clinic_id", "last_name", "first_name");

-- CreateIndex
CREATE INDEX "patients_clinic_id_phone_idx" ON "patients"("clinic_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "patients_clinic_id_mrn_key" ON "patients"("clinic_id", "mrn");

-- CreateIndex
CREATE INDEX "allergies_clinic_id_patient_id_idx" ON "allergies"("clinic_id", "patient_id");

-- CreateIndex
CREATE INDEX "appointments_clinic_id_doctor_id_starts_at_idx" ON "appointments"("clinic_id", "doctor_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_clinic_id_patient_id_starts_at_idx" ON "appointments"("clinic_id", "patient_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_clinic_id_starts_at_idx" ON "appointments"("clinic_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "encounters_appointment_id_key" ON "encounters"("appointment_id");

-- CreateIndex
CREATE INDEX "encounters_clinic_id_patient_id_occurred_at_idx" ON "encounters"("clinic_id", "patient_id", "occurred_at");

-- CreateIndex
CREATE INDEX "encounters_clinic_id_doctor_id_occurred_at_idx" ON "encounters"("clinic_id", "doctor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "diagnoses_clinic_id_encounter_id_idx" ON "diagnoses"("clinic_id", "encounter_id");

-- CreateIndex
CREATE INDEX "prescriptions_clinic_id_patient_id_status_idx" ON "prescriptions"("clinic_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "record_access_logs_clinic_id_patient_id_created_at_idx" ON "record_access_logs"("clinic_id", "patient_id", "created_at");

-- CreateIndex
CREATE INDEX "record_access_logs_clinic_id_user_id_created_at_idx" ON "record_access_logs"("clinic_id", "user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "services_clinic_id_code_key" ON "services"("clinic_id", "code");

-- CreateIndex
CREATE INDEX "invoices_clinic_id_patient_id_idx" ON "invoices"("clinic_id", "patient_id");

-- CreateIndex
CREATE INDEX "invoices_clinic_id_status_idx" ON "invoices"("clinic_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_clinic_id_number_key" ON "invoices"("clinic_id", "number");

-- CreateIndex
CREATE INDEX "invoice_items_clinic_id_invoice_id_idx" ON "invoice_items"("clinic_id", "invoice_id");

-- CreateIndex
CREATE INDEX "payments_clinic_id_invoice_id_idx" ON "payments"("clinic_id", "invoice_id");

-- CreateIndex
CREATE INDEX "notifications_clinic_id_user_id_read_at_created_at_idx" ON "notifications"("clinic_id", "user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_clinic_id_created_at_idx" ON "audit_logs"("clinic_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_clinic_id_entity_type_entity_id_idx" ON "audit_logs"("clinic_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_interactions_clinic_id_patient_id_created_at_idx" ON "ai_interactions"("clinic_id", "patient_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_interactions_clinic_id_user_id_created_at_idx" ON "ai_interactions"("clinic_id", "user_id", "created_at");

-- AddForeignKey
ALTER TABLE "clinic_memberships" ADD CONSTRAINT "clinic_memberships_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_memberships" ADD CONSTRAINT "clinic_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_availability" ADD CONSTRAINT "doctor_availability_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_time_off" ADD CONSTRAINT "doctor_time_off_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allergies" ADD CONSTRAINT "allergies_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_access_logs" ADD CONSTRAINT "record_access_logs_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Integrity constraints that Prisma cannot express
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_time_order_check" CHECK ("ends_at" > "starts_at");

-- Two active appointments for the same doctor may never overlap. The database is
-- the final arbiter even under concurrent booking requests.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (
    "doctor_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("status" NOT IN ('CANCELLED', 'NO_SHOW'));

ALTER TABLE "doctor_time_off"
  ADD CONSTRAINT "doctor_time_off_time_order_check" CHECK ("ends_at" > "starts_at");

ALTER TABLE "doctor_availability"
  ADD CONSTRAINT "doctor_availability_weekday_check" CHECK ("weekday" BETWEEN 0 AND 6),
  ADD CONSTRAINT "doctor_availability_time_order_check" CHECK ("end_time" > "start_time"),
  ADD CONSTRAINT "doctor_availability_slot_check" CHECK ("slot_minutes" BETWEEN 5 AND 240);

ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_check" CHECK ("amount" > 0);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Append-only tables: audit_logs and record_access_logs can never be altered.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION careflow_prevent_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION careflow_prevent_mutation();

CREATE TRIGGER record_access_logs_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON "record_access_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION careflow_prevent_mutation();

-- ═══════════════════════════════════════════════════════════════════════════════
-- Row-Level Security (multi-tenancy)
--
-- The application sets, per transaction:
--   SELECT set_config('app.current_clinic_id', '<uuid>', true);
--   SELECT set_config('app.current_user_id',   '<uuid>', true);
-- and, only in explicitly privileged system paths (login, clinic provisioning, seeds):
--   SELECT set_config('app.bypass_rls', 'on', true);
--
-- With no clinic context set, every tenant-scoped query returns zero rows and every
-- insert is rejected. FORCE ROW LEVEL SECURITY makes the policies apply to the
-- table owner as well, so the application role cannot accidentally bypass them.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION careflow_current_clinic_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_clinic_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION careflow_current_user_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION careflow_rls_bypassed() RETURNS boolean AS $$
  SELECT COALESCE(current_setting('app.bypass_rls', true), 'off') = 'on';
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'doctors', 'doctor_availability', 'doctor_time_off',
    'patients', 'allergies',
    'appointments',
    'encounters', 'diagnoses', 'prescriptions', 'record_access_logs',
    'services', 'invoices', 'invoice_items', 'payments',
    'notifications', 'audit_logs', 'ai_interactions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (careflow_rls_bypassed() OR clinic_id = careflow_current_clinic_id())
         WITH CHECK (careflow_rls_bypassed() OR clinic_id = careflow_current_clinic_id())',
      t
    );
  END LOOP;
END $$;

-- Memberships are visible inside the active clinic, or to the user they belong to
-- (needed to list "my clinics" before a clinic is selected).
ALTER TABLE "clinic_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinic_memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clinic_memberships"
  USING (
    careflow_rls_bypassed()
    OR clinic_id = careflow_current_clinic_id()
    OR user_id = careflow_current_user_id()
  )
  WITH CHECK (
    careflow_rls_bypassed()
    OR clinic_id = careflow_current_clinic_id()
  );

-- Clinics are visible to their members or the active tenant.
ALTER TABLE "clinics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinics" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clinics"
  USING (
    careflow_rls_bypassed()
    OR id = careflow_current_clinic_id()
    OR EXISTS (
      SELECT 1 FROM "clinic_memberships" m
      WHERE m.clinic_id = "clinics".id AND m.user_id = careflow_current_user_id()
    )
  )
  WITH CHECK (careflow_rls_bypassed() OR id = careflow_current_clinic_id());
