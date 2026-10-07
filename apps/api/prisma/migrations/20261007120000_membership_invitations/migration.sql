-- Membership invitations: a membership created for an EXISTING account stays pending
-- (is_active = false, accepted_at = NULL) until the invited user accepts it.
ALTER TABLE "clinic_memberships" ADD COLUMN "accepted_at" TIMESTAMPTZ;
ALTER TABLE "clinic_memberships" ADD COLUMN "invited_by_id" UUID;

-- Migrations run as the application role under forced RLS: bypass for this transaction.
SELECT set_config('app.bypass_rls', 'on', true);

-- Every existing membership was created active: mark it accepted.
UPDATE "clinic_memberships" SET "accepted_at" = "created_at" WHERE "accepted_at" IS NULL;

-- Inbound webhook de-duplication: a provider message id may be processed only once.
-- Remove historical duplicates (keep the earliest row) before adding the index.
DELETE FROM "messages" m
 USING "messages" d
 WHERE m.direction = 'INBOUND' AND d.direction = 'INBOUND'
   AND m.provider_message_id IS NOT NULL
   AND m.provider_message_id = d.provider_message_id
   AND (m.created_at, m.id) > (d.created_at, d.id);

CREATE UNIQUE INDEX "messages_inbound_provider_message_id_key"
  ON "messages" ("provider_message_id")
  WHERE "direction" = 'INBOUND' AND "provider_message_id" IS NOT NULL;
