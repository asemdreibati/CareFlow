-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('ROOM', 'EQUIPMENT', 'STAFF', 'OTHER');

-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "SeriesStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WaitlistPriority" AS ENUM ('ROUTINE', 'SOON', 'URGENT');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('WAITING', 'OFFERED', 'BOOKED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReminderChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'APPLIED', 'PARTIALLY_APPLIED', 'DISMISSED');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "hold_expires_at" TIMESTAMPTZ,
ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "is_exception" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "no_show_risk" DOUBLE PRECISION,
ADD COLUMN     "occurrence_index" INTEGER,
ADD COLUMN     "series_id" UUID,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "resources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ResourceType" NOT NULL DEFAULT 'ROOM',
    "color" TEXT NOT NULL DEFAULT '#6b7280',
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_bookings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "resource_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_series" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "frequency" "RecurrenceFrequency" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "by_weekday" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "by_month_day" INTEGER,
    "starts_on" DATE NOT NULL,
    "start_time" TEXT NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "count" INTEGER,
    "until" DATE,
    "type" "AppointmentType" NOT NULL DEFAULT 'FOLLOW_UP',
    "reason" TEXT,
    "status" "SeriesStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "appointment_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "doctor_id" UUID,
    "specialty" TEXT,
    "duration_minutes" INTEGER NOT NULL DEFAULT 30,
    "priority" "WaitlistPriority" NOT NULL DEFAULT 'ROUTINE',
    "earliest_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latest_at" TIMESTAMPTZ,
    "preferred_windows" JSONB NOT NULL DEFAULT '[]',
    "type" "AppointmentType" NOT NULL DEFAULT 'CONSULTATION',
    "notes" TEXT,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "offered_appointment_id" UUID,
    "offer_expires_at" TIMESTAMPTZ,
    "offer_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "channel" "ReminderChannel" NOT NULL DEFAULT 'IN_APP',
    "scheduled_for" TIMESTAMPTZ NOT NULL,
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "no_show_models" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "parameters" JSONB NOT NULL,
    "sample_size" INTEGER NOT NULL,
    "metrics" JSONB,
    "trained_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "no_show_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reschedule_proposals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "cause" TEXT NOT NULL,
    "doctor_time_off_id" UUID,
    "items" JSONB NOT NULL,
    "unresolved_appointment_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "total_displacement_minutes" INTEGER NOT NULL DEFAULT 0,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING',
    "created_by_id" UUID,
    "applied_by_id" UUID,
    "applied_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reschedule_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "resources_clinic_id_name_key" ON "resources"("clinic_id", "name");

-- CreateIndex
CREATE INDEX "resource_bookings_clinic_id_resource_id_starts_at_idx" ON "resource_bookings"("clinic_id", "resource_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "resource_bookings_appointment_id_resource_id_key" ON "resource_bookings"("appointment_id", "resource_id");

-- CreateIndex
CREATE INDEX "appointment_series_clinic_id_patient_id_idx" ON "appointment_series"("clinic_id", "patient_id");

-- CreateIndex
CREATE INDEX "appointment_series_clinic_id_doctor_id_idx" ON "appointment_series"("clinic_id", "doctor_id");

-- CreateIndex
CREATE INDEX "waitlist_entries_clinic_id_status_priority_created_at_idx" ON "waitlist_entries"("clinic_id", "status", "priority", "created_at");

-- CreateIndex
CREATE INDEX "waitlist_entries_clinic_id_patient_id_idx" ON "waitlist_entries"("clinic_id", "patient_id");

-- CreateIndex
CREATE INDEX "reminders_status_scheduled_for_idx" ON "reminders"("status", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "reminders_appointment_id_channel_scheduled_for_key" ON "reminders"("appointment_id", "channel", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "no_show_models_clinic_id_key" ON "no_show_models"("clinic_id");

-- CreateIndex
CREATE INDEX "reschedule_proposals_clinic_id_status_created_at_idx" ON "reschedule_proposals"("clinic_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "appointments_clinic_id_series_id_idx" ON "appointments"("clinic_id", "series_id");

-- CreateIndex
CREATE INDEX "appointments_hold_expires_at_idx" ON "appointments"("hold_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_clinic_id_idempotency_key_key" ON "appointments"("clinic_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "appointment_series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_bookings" ADD CONSTRAINT "resource_bookings_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_bookings" ADD CONSTRAINT "resource_bookings_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_series" ADD CONSTRAINT "appointment_series_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_offered_appointment_id_fkey" FOREIGN KEY ("offered_appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════════
-- Scheduling engine: constraints, append-only guarantees and RLS for new tables
-- ═══════════════════════════════════════════════════════════════════════════════

-- A resource (room, device) can never be double-booked by active appointments.
ALTER TABLE "resource_bookings"
  ADD CONSTRAINT "resource_bookings_time_order_check" CHECK ("ends_at" > "starts_at"),
  ADD CONSTRAINT "resource_bookings_no_overlap"
  EXCLUDE USING gist (
    "resource_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("active");

ALTER TABLE "appointment_series"
  ADD CONSTRAINT "appointment_series_interval_check" CHECK ("interval" BETWEEN 1 AND 52),
  ADD CONSTRAINT "appointment_series_count_check" CHECK ("count" IS NULL OR "count" BETWEEN 1 AND 365),
  ADD CONSTRAINT "appointment_series_duration_check" CHECK ("duration_minutes" BETWEEN 5 AND 480);

ALTER TABLE "waitlist_entries"
  ADD CONSTRAINT "waitlist_entries_duration_check" CHECK ("duration_minutes" BETWEEN 5 AND 480),
  ADD CONSTRAINT "waitlist_entries_target_check" CHECK ("doctor_id" IS NOT NULL OR "specialty" IS NOT NULL);

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "appointments_no_show_risk_check" CHECK ("no_show_risk" IS NULL OR ("no_show_risk" >= 0 AND "no_show_risk" <= 1));

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'resources', 'resource_bookings', 'appointment_series', 'waitlist_entries',
    'reminders', 'no_show_models', 'reschedule_proposals'
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
