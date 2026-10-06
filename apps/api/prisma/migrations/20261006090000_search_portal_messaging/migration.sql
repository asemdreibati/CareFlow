-- Extensions: trigram fuzzy search, accent folding, vector similarity (pgvector).
-- `vector` is not a trusted extension: on a fresh server a superuser must run
-- `CREATE EXTENSION vector` once (the docker-compose/CI images ship it preinstalled).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('PORTAL_LOGIN');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('SMS', 'WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'RECEIVED');

-- AlterEnum
ALTER TYPE "ReminderChannel" ADD VALUE 'WHATSAPP';

-- AlterTable
ALTER TABLE "encounters" ADD COLUMN     "search_vector" tsvector;

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "locale" TEXT,
ADD COLUMN     "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "search_text" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "locale" TEXT;

-- CreateTable
CREATE TABLE "encounter_embeddings" (
    "encounter_id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "encounter_embeddings_pkey" PRIMARY KEY ("encounter_id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL DEFAULT 'PORTAL_LOGIN',
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_consents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "accepted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "patient_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clinic_id" UUID NOT NULL,
    "patient_id" UUID,
    "appointment_id" UUID,
    "channel" "MessageChannel" NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "address" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "template" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "provider_message_id" TEXT,
    "error" TEXT,
    "in_reply_to_id" UUID,
    "intent" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "encounter_embeddings_clinic_id_patient_id_idx" ON "encounter_embeddings"("clinic_id", "patient_id");

-- CreateIndex
CREATE INDEX "otp_codes_clinic_id_phone_created_at_idx" ON "otp_codes"("clinic_id", "phone", "created_at");

-- CreateIndex
CREATE INDEX "patient_consents_clinic_id_patient_id_idx" ON "patient_consents"("clinic_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_consents_patient_id_type_version_key" ON "patient_consents"("patient_id", "type", "version");

-- CreateIndex
CREATE INDEX "messages_clinic_id_patient_id_created_at_idx" ON "messages"("clinic_id", "patient_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_clinic_id_appointment_id_idx" ON "messages"("clinic_id", "appointment_id");

-- CreateIndex
CREATE INDEX "messages_provider_message_id_idx" ON "messages"("provider_message_id");

-- AddForeignKey
ALTER TABLE "encounter_embeddings" ADD CONSTRAINT "encounter_embeddings_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_consents" ADD CONSTRAINT "patient_consents_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════════
-- Text normalisation for Arabic + Latin search
--
-- careflow_normalize() folds text so that "محمّد", "محمد", "Mohammed" and "MOHAMMED"
-- compare predictably:
--   * strips Arabic diacritics (tashkeel) and tatweel
--   * unifies alef variants (أ إ آ ٱ → ا), taa marbuta (ة → ه), alef maqsura (ى → ي),
--     hamza carriers (ؤ → و, ئ → ي)
--   * converts Arabic-Indic and Persian digits to ASCII digits
--   * removes Latin accents (unaccent) and lower-cases
--   * collapses whitespace
-- Declared IMMUTABLE so it can back indexed columns. unaccent() itself is STABLE,
-- so it is wrapped with the explicit dictionary argument (standard practice).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION careflow_unaccent(text) RETURNS text AS $$
  SELECT public.unaccent('public.unaccent', $1)
$$ LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

CREATE OR REPLACE FUNCTION careflow_normalize(input text) RETURNS text AS $$
DECLARE
  t text := COALESCE(input, '');
BEGIN
  -- Arabic diacritics U+064B..U+0652, superscript alef U+0670, tatweel U+0640
  t := regexp_replace(t, '[' || chr(1611) || '-' || chr(1618) || chr(1648) || chr(1600) || ']', '', 'g');
  t := translate(t,
    'أإآٱةىؤئ' || '٠١٢٣٤٥٦٧٨٩' || '۰۱۲۳۴۵۶۷۸۹',
    'ااااهيوي' || '0123456789' || '0123456789');
  t := lower(careflow_unaccent(t));
  t := regexp_replace(t, '\s+', ' ', 'g');
  RETURN btrim(t);
END;
$$ LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE;

-- Patients: maintained search_text + trigram index (fuzzy, substring, Arabic-aware)
CREATE OR REPLACE FUNCTION careflow_patient_search_text() RETURNS trigger AS $$
BEGIN
  NEW.search_text := careflow_normalize(
    concat_ws(' ', NEW.first_name, NEW.last_name, NEW.mrn, NEW.phone, NEW.email)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER patients_search_text_trg
  BEFORE INSERT OR UPDATE OF first_name, last_name, mrn, phone, email ON "patients"
  FOR EACH ROW EXECUTE FUNCTION careflow_patient_search_text();

UPDATE "patients" SET search_text = careflow_normalize(concat_ws(' ', first_name, last_name, mrn, phone, email));

CREATE INDEX "patients_search_text_trgm_idx" ON "patients" USING gin ("search_text" gin_trgm_ops);

-- Encounters: full-text vector over SOAP fields (normalised text, 'simple' dictionary so
-- Arabic tokens are kept as-is; stemming is intentionally not applied to clinical text)
CREATE OR REPLACE FUNCTION careflow_encounter_search_vector() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
      setweight(to_tsvector('simple', careflow_normalize(COALESCE(NEW.chief_complaint, ''))), 'A')
   || setweight(to_tsvector('simple', careflow_normalize(COALESCE(NEW.assessment, ''))), 'A')
   || setweight(to_tsvector('simple', careflow_normalize(COALESCE(NEW.subjective, ''))), 'B')
   || setweight(to_tsvector('simple', careflow_normalize(COALESCE(NEW.objective, ''))), 'B')
   || setweight(to_tsvector('simple', careflow_normalize(COALESCE(NEW.plan, ''))), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER encounters_search_vector_trg
  BEFORE INSERT OR UPDATE OF chief_complaint, subjective, objective, assessment, plan ON "encounters"
  FOR EACH ROW EXECUTE FUNCTION careflow_encounter_search_vector();

UPDATE "encounters" SET chief_complaint = chief_complaint; -- backfill through the trigger

CREATE INDEX "encounters_search_vector_idx" ON "encounters" USING gin ("search_vector");

-- Diagnoses and invoices: trigram indexes for code / number lookups
CREATE INDEX "diagnoses_code_trgm_idx" ON "diagnoses" USING gin (lower("code") gin_trgm_ops);
CREATE INDEX "diagnoses_description_trgm_idx" ON "diagnoses" USING gin (careflow_normalize("description") gin_trgm_ops);
CREATE INDEX "invoices_number_trgm_idx" ON "invoices" USING gin (lower("number") gin_trgm_ops);

-- Embeddings: cosine HNSW index for semantic search within a patient's record
CREATE INDEX "encounter_embeddings_hnsw_idx" ON "encounter_embeddings" USING hnsw ("embedding" vector_cosine_ops);

CREATE INDEX "otp_codes_expires_at_idx" ON "otp_codes" ("expires_at");

-- ═══════════════════════════════════════════════════════════════════════════════
-- Row-Level Security for the new tenant tables
-- ═══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['encounter_embeddings', 'otp_codes', 'patient_consents', 'messages'] LOOP
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
