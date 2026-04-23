# Data Update Script Status Spec (Apr 2026)

## Goal

Provide a current status check on whether Bullseye has scripts that update live data, and define how we would implement updates if those scripts did not exist.

## Current Answer

Yes, there are currently scripts that update data.

## Existing Data Update Scripts

### 1) Score + tournament status updater

- File: `scripts/update-scores.js`
- Purpose:
  - Pulls tournament rounds/scores from PDGA Live API.
  - Pulls tournament stats from DGPT endpoint.
  - Upserts into Supabase tables:
    - `player_scores`
    - `player_stats`
  - Updates tournament `status` (`upcoming`, `active`, `completed`).
- Behavior:
  - Idempotent writes via upsert conflict keys.
  - Safe to run repeatedly.

### 2) Registration updater

- File: `scripts/update-registrations.js`
- Purpose:
  - Pulls player registration data from PDGA (API first, HTML fallback).
  - Refreshes Supabase registrations table (`tournament_entries` in current schema).
- Behavior:
  - Clears existing rows for tournament, then inserts latest matched registrations.
  - Safe for repeated refresh cycles.

## Existing Automation

- File: `.github/workflows/update-scores.yml`
- Schedule:
  - Cron every 4 hours.
  - Manual trigger via `workflow_dispatch`.
- Actions:
  - Runs `node scripts/update-scores.js`.
  - Runs `node scripts/update-registrations.js`.
- Secrets required:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_KEY`

## Operational Meaning

- Current state is not "missing scripts"; update plumbing already exists.
- Live scoring freshness is currently bounded by the 4-hour schedule unless manually triggered.
- If updates are stale, likely causes are workflow/secret failures, source API changes, or parsing drift.

## If Scripts Did Not Exist: Implementation Plan

This is the minimal plan we would use to add data updates from scratch.

### Phase A: Build one reusable Supabase write helper

- Inputs: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
- Features:
  - `GET`, `POST`, `PATCH`, `DELETE`.
  - Support `on_conflict`.
  - Throw readable errors with response text.

### Phase B: Build score ingestion script

- Pull active/completed tournaments from `tournaments`.
- For each tournament with `pdga_id`:
  - Fetch event metadata + completed rounds from PDGA Live.
  - Convert source payloads into normalized row objects.
  - Upsert `player_scores` by `(player_id, tournament_id, round)`.
  - If tournament completed, fetch stats and upsert `player_stats` by `(player_id, tournament_id)`.
  - Update tournament status from PDGA round completion signal.

### Phase C: Build registration ingestion script

- Pull upcoming/active tournaments with `pdga_id`.
- Fetch registrations from PDGA endpoint(s).
- Match PDGA numbers to local player IDs.
- Replace `tournament_registrations` rows per tournament with latest source snapshot.
- Replace registration rows per tournament with latest source snapshot.

### Phase D: Automate execution

- Add GitHub workflow with:
  - Cron cadence (start with every 4 hours).
  - Manual dispatch.
  - Node setup and script execution.
- Add alerting path (at minimum: failed workflow email/GitHub notification).

### Phase E: Runbook (manual fallback)

- For manual run from Windows PowerShell:
  - `$env:SUPABASE_URL="https://<project>.supabase.co"`
  - `$env:SUPABASE_SERVICE_KEY="<service_role_key>"`
  - `node .\scripts\update-scores.js`
  - `node .\scripts\update-registrations.js`

## Recommended Next Checks

- Confirm the scheduled workflow is succeeding on recent runs.
- Confirm secrets are present and valid in GitHub repo settings.
- Confirm the current 4-hour cadence is acceptable for "live" expectations.
- If near-real-time is desired, reduce cadence (for example, hourly) or add event-day manual trigger practice.

