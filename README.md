# 🏥 CareFlow

Multi-tenant clinic management platform: doctors, patients, appointments with
conflict-free scheduling, medical records, billing, real-time notifications,
fine-grained permissions, a full audit trail, and an AI assistant layer
(Claude or Gemini) for patient summaries and SOAP note drafting.

| Layer | Stack |
|---|---|
| API | NestJS 12 · Prisma 6 · PostgreSQL 16 (Row-Level Security) · Socket.IO |
| Web | Angular 21 (standalone, signals) |
| AI | `@anthropic-ai/sdk` (Claude) · `@google/genai` (Gemini) behind one provider interface |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/API.md](docs/API.md).

## Quick start

```bash
pnpm install
docker compose up -d db                 # or any PostgreSQL 16 at DATABASE_URL
cp apps/api/.env.example apps/api/.env  # edit secrets
pnpm db:migrate                         # applies migrations incl. RLS policies
pnpm db:seed                            # demo clinic + users (password: Password123)
pnpm dev                                # API on :3000 (/docs for Swagger), web on :4200
```

Demo logins: `owner@demo.clinic`, `admin@demo.clinic`, `dr.salem@demo.clinic`,
`dr.nour@demo.clinic`, `reception@demo.clinic`, `finance@demo.clinic`.

## Scripts

| Command | What it does |
|---|---|
| `pnpm --filter api start:dev` | API with watch mode |
| `pnpm --filter api test` / `test:e2e` | unit / end-to-end tests (e2e needs the database) |
| `pnpm --filter api lint` | oxlint |
| `pnpm --filter web start` | Angular dev server |
| `pnpm build` | build both apps |
