# Finance Assistant Agents

**MVP 0 — Slip-based expense sync to Firefly III**

A personal web workflow that turns banking slip images into reviewed Firefly III expense transactions.

## Purpose

The user wants real spending in Firefly III without manual data entry. Android banking apps save slip images, and Resilio Sync already makes those images available on a Pi. This app bridges the gap: scan synced slip images, parse with Gemini vision, review and correct draft fields, and sync approved expenses to Firefly III.

## MVP 0 Scope

- Scan a selected date range from a Resilio-synced raw slip folder
- Parse slip images with Gemini vision (amount, date, currency, merchant)
- Review parsed drafts beside the original slip image
- Edit any draft field before sync
- Resolve duplicate-risk slips before they reach Firefly
- Confirm and sync approved expense transactions to Firefly III

**Not in MVP 0:**
- Dashboard or financial reporting
- Custom authentication (uses Cloudflare Access)
- Background / cron automation
- Transfers, refunds, salary, or deposits
- Manual receipt upload or paper receipt parsing
- Credit-card spending without a slip image
- Bidirectional Firefly sync

## Prerequisites

- [Bun](https://bun.sh) >= 1.2
- A running [Firefly III](https://www.firefly-iii.org/) instance with API access
- A Google Gemini API key
- (Optional) Cloudflare Access for public auth

## Setup

```bash
# Clone the repository
git clone <repo-url> finance-assistant-agents
cd finance-assistant-agents

# Copy environment variables and edit
cp .env.example .env
# Fill in: FIREFLY_BASE_URL, FIREFLY_TOKEN, GEMINI_API_KEY, SLIPS_RAW_DIR

# Install dependencies
bun install

# Run the dev server
bun dev
```

## Scripts

| Command           | Description                |
|-------------------|----------------------------|
| `bun dev`         | Start dev server with watch |
| `bun start`       | Start production server     |
| `bun test`        | Run tests                   |
| `bun run typecheck` | TypeScript type checking  |

## Docker on Raspberry Pi

```bash
cp .env.example .env
# Edit .env: set FIREFLY_BASE_URL, FIREFLY_TOKEN, GEMINI_API_KEY.
# Set SLIPS_RAW_DIR_HOST to the Resilio-synced raw slips path on the Pi.

docker compose up -d --build
```

Useful commands:

```bash
# View logs
docker compose logs -f app

# Update after pulling new code
docker compose up -d --build
```

Compose mounts the raw slips folder read-only at `/slips/raw`. SQLite data persists in the `app-data` named volume at `/app/data/app.sqlite`.

## Environment Variables

| Variable             | Required | Default                              | Description                          |
|----------------------|----------|--------------------------------------|--------------------------------------|
| `FIREFLY_BASE_URL`   | Yes      | —                                    | Firefly III instance base URL        |
| `FIREFLY_TOKEN`      | Yes      | —                                    | Firefly III personal access token    |
| `GEMINI_API_KEY`     | Yes      | —                                    | Google Gemini API key                |
| `SLIPS_RAW_DIR`      | Yes      | —                                    | Path to the synced raw slip folder   |
| `DB_PATH`            | No       | `./data/app.sqlite`                  | SQLite database file path            |
| `CF_ACCESS_HEADER`   | No       | `Cf-Access-Authenticated-User-Email` | HTTP header for Cloudflare Access    |
| `CF_ACCESS_DEV_BYPASS` | No     | `false`                              | Set to `true` to skip CF Access check |
| `PORT`               | No       | `3000`                               | HTTP server port                     |
