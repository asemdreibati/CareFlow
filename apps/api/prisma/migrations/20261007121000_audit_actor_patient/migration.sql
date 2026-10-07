-- Attribute portal actions to the patient who performed them.
ALTER TABLE "audit_logs" ADD COLUMN "actor_patient_id" UUID;
CREATE INDEX "audit_logs_actor_patient_id_created_at_idx" ON "audit_logs" ("actor_patient_id", "created_at");
