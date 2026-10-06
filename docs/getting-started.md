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

## Configuration Notes

- `CLAIM_BASE_URL`: Base URL used for building recipient claim redemption links.
  - Required when `NODE_ENV=production` (must be a valid http or https URL without a trailing slash). In development/test environments, defaults to `https://claim.bridgelet.io` if not specified.
  - **Link format contract**: The SDK generates claim links matching `<CLAIM_BASE_URL>/c/<token>`. Frontend claim portals should route `/c/:token` to their claim redemption handler.
- `CORS_ORIGINS`: Comma-separated list of allowed origins for incoming cross-origin requests, or `*` to allow all origins. Defaults to `*` if unset.

## Next steps

See `README.md` for architecture notes and `docs/api-reference.md` for the
full API reference.
