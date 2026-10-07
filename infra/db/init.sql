-- Bootstrap for a fresh PostgreSQL server (docker-compose and CI run this as the superuser).
--
-- The application role must NOT be a superuser and must NOT have BYPASSRLS: superusers ignore
-- Row-Level Security even with FORCE ROW LEVEL SECURITY, which would silently disable tenant
-- isolation. The app role owns the database (so Prisma migrations can create tables) but is
-- subject to RLS like any other role.
CREATE ROLE careflow LOGIN PASSWORD 'careflow' NOSUPERUSER NOBYPASSRLS CREATEDB;
CREATE DATABASE careflow OWNER careflow;

\connect careflow
-- `vector` is not a trusted extension, so the superuser installs it once; the migrations'
-- CREATE EXTENSION IF NOT EXISTS statements then become no-ops.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS btree_gist;
