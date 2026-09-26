# Getting Started

This guide replaces `docs/getting-started.pdf`; keep it in sync with code
changes going forward since Markdown is easier to review and search.

## Prerequisites

- Node.js 18+
- PostgreSQL running locally (or reachable) with a database created —
  or run `docker compose up` from the repo root instead, which
  provisions Postgres and runs migrations for you (see
  `CONTRIBUTING.md`)
- A Stellar testnet funding account (secret key)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the environment template and fill in your values:
   ```bash
   cp .env.example .env
   ```
3. Run database migrations:
   ```bash
   npm run migration:run
   ```
4. Start the app in watch mode:
   ```bash
   npm run start:dev
   ```

## Verifying it works

- The app should boot without errors on the port set by `PORT` (default `3000`).
- `GET /health` (if enabled) should return a 200 response.

## Next steps

See `README.md` for architecture notes and `docs/api-reference.md` for the
full API reference.
