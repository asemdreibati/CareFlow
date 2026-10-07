-- The backfill statements in 20261006090000 ran as the application role, which is subject
-- to FORCE ROW LEVEL SECURITY: with no tenant context they matched zero rows, so rows that
-- existed before that migration kept NULL search columns. Migrations run in one transaction,
-- so a transaction-local bypass is enough to backfill every clinic here.
SELECT set_config('app.bypass_rls', 'on', true);

UPDATE "patients"
   SET search_text = careflow_normalize(concat_ws(' ', first_name, last_name, mrn, phone, email))
 WHERE search_text IS NULL;

UPDATE "encounters"
   SET chief_complaint = chief_complaint   -- fires the search_vector trigger
 WHERE search_vector IS NULL;
