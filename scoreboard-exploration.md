# Scoreboard Exploration (Current `main`)

## 1) What does the scoreboard page look like now?

There are two relevant pages:

- `pages/leaderboard.html` (event-level, in-progress tournament view)
  - Top bar with a **Spoiler Shield** toggle.
  - Tournament tabs (if multiple active/completed tournaments exist).
  - A hero section with tournament name, location, date range, and LIVE/FINAL badge.
  - Main leaderboard table with:
    - Rank
    - Team
    - Fantasy points
    - Raw score
    - League points
    - Expand row control
  - Expandable row details for each team showing per-player round breakdowns and bonuses.
  - Right sidebar card for "My Team" player scoring and a "Scoring Rules" reference.
  - Commissioner-only controls for entering scores/stats and finalizing.

- `pages/standings.html` (season-level standings view)
  - "Season Standings" header with event count scored.
  - Podium display for top 3 teams.
  - Standings table with:
    - Rank
    - Team
    - Season points
    - Events
    - Results chips per event
  - Sidebar card showing points system (4/2/1/0/-1/-2...)
  - Sidebar list of all 2026 events with UPCOMING/LIVE/FINAL badges.

## 2) How are we getting data to calculate scores?

### Leaderboard (event calculation path)

Client-side calculation is done in `js/leaderboard.js`:

1. Load user team + league from Supabase (`teams`, `leagues`).
2. Load all teams in that league (`teams` table).
3. Load active/completed 2026 tournaments (`tournaments` table).
4. For selected tournament:
   - Load lineups for league teams (`lineups` + joined `players`).
   - Load round-level player scores (`player_scores`).
   - Load per-tournament player stats (`player_stats`).
5. Compute fantasy team totals in browser:
   - round score (negated relative-to-par)
   - lead card multiplier
   - eagle/parked bonuses
   - podium bonus
   - position stat bonuses
6. Rank teams and assign league points with tiebreak by raw score.

Realtime updates:

- `leaderboard.js` subscribes to Supabase Realtime on `player_scores`.
- On change, it reloads tournament data and recomputes in memory.

### Standings (season aggregate path)

`pages/standings.html` script does **not** recompute from raw rounds. It reads finalized data:

- Reads all `fantasy_scores` rows where `finalized = true` for league teams.
- Aggregates season totals (`league_points`, `raw_score`) across finalized tournaments.
- Renders season standings and result chips from those persisted rows.

### External data ingest

`scripts/update-scores.js` is an ingestion script (server-side run):

- Pulls score data from PDGA Live API.
- Pulls stats from DGPT endpoint (HTML parse).
- Upserts into Supabase `player_scores` and `player_stats`.
- Updates tournament status (`upcoming`/`active`/`completed`).

## 3) Are we re-saving data every time in a way that supports this idea?

Short answer: **mostly no on page view, yes on explicit update/finalize actions, and writes are idempotent via upsert constraints.**

### What is not re-saved on every page load

- Leaderboard viewing computes scores in memory and renders; it does not persist `fantasy_scores` continuously.
- Standings page reads `fantasy_scores` and aggregates in memory; it does not rewrite them.

### What does get saved

- Commissioner score entry writes to `player_scores` via `upsert` on `(player_id, tournament_id, round)`.
- Commissioner stats entry writes to `player_stats` via `upsert` on `(player_id, tournament_id)`.
- Finalize action writes `fantasy_scores` via `upsert` on `(team_id, tournament_id)` and sets tournament `status='completed'`.
- `scripts/update-scores.js` also upserts `player_scores` and `player_stats` (idempotent refresh behavior).

### Why this is promising for spoiler-safe "pace-controlled" standings

- Current architecture already separates:
  - granular round/player data (`player_scores`)
  - finalized season scoring snapshots (`fantasy_scores`)
- Because writes use unique keys + upsert, re-processing updates existing rows rather than duplicating data.
- This makes it feasible to support a user-controlled reveal pace by filtering which rounds/results are included in calculation at render time (or through a persisted per-user reveal cursor), without needing to duplicate the core tables.
