-- ============================================
-- BULLSEYE FANTASY DISC GOLF - SUPABASE SCHEMA
-- Run this in your Supabase SQL Editor
-- ============================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ============================================
-- LEAGUES
-- ============================================
create table leagues (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  commissioner_id uuid references auth.users(id),
  season int not null default 2026,
  invite_code text unique default substring(md5(random()::text), 1, 8),
  settings jsonb not null default '{
    "team_size": 7,
    "starters": 4,
    "starting_faab": 100,
    "waiver_blackout_hours": 24,
    "scoring": {
      "positions": ["putter","driver","approacher","flex"],
      "place_points": [4,2,1,0,-1],
      "lead_card_multiplier": 1.5,
      "podium_bonus": [15,8,3],
      "position_best_bonus": 7,
      "position_second_bonus": 3,
      "eagle_bonus": 1,
      "parked_bonus": 1
    }
  }'::jsonb,
  created_at timestamptz default now()
);

-- ============================================
-- TEAMS
-- ============================================
create table teams (
  id uuid primary key default uuid_generate_v4(),
  league_id uuid references leagues(id) on delete cascade,
  manager_id uuid references auth.users(id),
  name text not null,
  faab_balance int not null default 100,
  draft_position int,
  created_at timestamptz default now(),
  unique(league_id, manager_id)
);

-- ============================================
-- PLAYERS (disc golfers)
-- ============================================
create table players (
  id uuid primary key default uuid_generate_v4(),
  pdga_number text unique,
  name text not null,
  pdga_rating int,
  nationality text,
  avatar_url text,
  active boolean default true,
  created_at timestamptz default now()
);

-- ============================================
-- ROSTERS (which players belong to which team)
-- ============================================
create table rosters (
  id uuid primary key default uuid_generate_v4(),
  team_id uuid references teams(id) on delete cascade,
  player_id uuid references players(id),
  league_id uuid references leagues(id),
  acquired_via text default 'draft', -- 'draft', 'waiver', 'trade', 'free_agent'
  acquired_at timestamptz default now(),
  dropped_at timestamptz,
  is_active boolean default true,
  unique(league_id, player_id, is_active) -- only one active roster spot per player per league
);

-- ============================================
-- TOURNAMENTS
-- ============================================
create table tournaments (
  id uuid primary key default uuid_generate_v4(),
  pdga_id text unique,
  name text not null,
  tier text not null, -- 'ES' (Elite Series), 'Major', 'Playoff', 'Champions Cup'
  start_date date,
  end_date date,
  location text,
  course text,
  par int,
  rounds int default 4,
  status text default 'upcoming', -- 'upcoming', 'active', 'completed'
  season int default 2026,
  created_at timestamptz default now()
);

-- ============================================
-- TOURNAMENT ENTRIES (who signed up to play)
-- ============================================
create table tournament_entries (
  id uuid primary key default uuid_generate_v4(),
  tournament_id uuid references tournaments(id) on delete cascade,
  player_id uuid references players(id),
  confirmed boolean default false,
  fetched_at timestamptz default now(),
  unique(tournament_id, player_id)
);

-- ============================================
-- LINEUPS (weekly declarations)
-- ============================================
create table lineups (
  id uuid primary key default uuid_generate_v4(),
  team_id uuid references teams(id) on delete cascade,
  tournament_id uuid references tournaments(id),
  player_id uuid references players(id),
  position text not null, -- 'putter', 'driver', 'approacher', 'flex'
  locked boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(team_id, tournament_id, player_id)
);

-- ============================================
-- PLAYER TOURNAMENT SCORES (per round)
-- ============================================
create table player_scores (
  id uuid primary key default uuid_generate_v4(),
  player_id uuid references players(id),
  tournament_id uuid references tournaments(id),
  round int not null, -- 1,2,3,4
  score_relative_par int, -- negative = under par
  is_lead_card boolean default false,
  eagles int default 0,
  parked_holes int default 0,
  finish_position int, -- final tournament finish (only on last round)
  updated_at timestamptz default now(),
  unique(player_id, tournament_id, round)
);

-- ============================================
-- PLAYER STATS (per tournament)
-- ============================================
create table player_stats (
  id uuid primary key default uuid_generate_v4(),
  player_id uuid references players(id),
  tournament_id uuid references tournaments(id),
  c1x_putting_pct float, -- C1X putting %
  c2_putting_pct float,  -- C2 putting %
  fairway_hit_pct float, -- Fairway hit %
  c1_in_reg_pct float,   -- C1 in regulation %
  updated_at timestamptz default now(),
  unique(player_id, tournament_id)
);

-- ============================================
-- FANTASY SCORES (computed per team per tournament)
-- ============================================
create table fantasy_scores (
  id uuid primary key default uuid_generate_v4(),
  team_id uuid references teams(id),
  tournament_id uuid references tournaments(id),
  total_points float default 0,
  raw_score float default 0, -- tiebreaker
  breakdown jsonb, -- per-player breakdown
  league_place int, -- 1st/2nd/3rd etc within league
  league_points float default 0, -- 4/2/1/0/-1 etc
  finalized boolean default false,
  updated_at timestamptz default now(),
  unique(team_id, tournament_id)
);

-- ============================================
-- TRADES
-- ============================================
create table trades (
  id uuid primary key default uuid_generate_v4(),
  league_id uuid references leagues(id),
  proposing_team_id uuid references teams(id),
  receiving_team_id uuid references teams(id),
  players_offered uuid[], -- player IDs from proposing team
  players_requested uuid[], -- player IDs from receiving team
  status text default 'pending', -- 'pending', 'accepted', 'rejected', 'cancelled'
  message text,
  created_at timestamptz default now(),
  resolved_at timestamptz
);

-- ============================================
-- WAIVER CLAIMS (FAAB)
-- ============================================
create table waiver_claims (
  id uuid primary key default uuid_generate_v4(),
  league_id uuid references leagues(id),
  team_id uuid references teams(id),
  player_id uuid references players(id), -- player to add
  drop_player_id uuid references players(id), -- player to drop (optional)
  bid_amount int not null default 0,
  tournament_id uuid references tournaments(id), -- which tournament triggered the window
  status text default 'pending', -- 'pending', 'won', 'lost', 'cancelled'
  created_at timestamptz default now(),
  processed_at timestamptz
);

-- ============================================
-- DRAFT
-- ============================================
create table drafts (
  id uuid primary key default uuid_generate_v4(),
  league_id uuid references leagues(id) unique,
  status text default 'pending', -- 'pending', 'active', 'completed'
  type text default 'snake', -- 'snake' or 'linear'
  current_pick int default 1,
  pick_timer_seconds int default 120,
  started_at timestamptz,
  completed_at timestamptz
);

create table draft_picks (
  id uuid primary key default uuid_generate_v4(),
  draft_id uuid references drafts(id) on delete cascade,
  league_id uuid references leagues(id),
  team_id uuid references teams(id),
  player_id uuid references players(id),
  pick_number int not null,
  round int not null,
  pick_in_round int not null,
  picked_at timestamptz default now(),
  unique(draft_id, pick_number)
);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

alter table leagues enable row level security;
alter table teams enable row level security;
alter table rosters enable row level security;
alter table lineups enable row level security;
alter table trades enable row level security;
alter table waiver_claims enable row level security;
alter table drafts enable row level security;
alter table draft_picks enable row level security;

-- Public read for tournaments, players, scores, stats
alter table tournaments enable row level security;
alter table players enable row level security;
alter table player_scores enable row level security;
alter table player_stats enable row level security;
alter table fantasy_scores enable row level security;
alter table tournament_entries enable row level security;

-- Leagues: anyone can read, only commissioner can update
create policy "leagues_read" on leagues for select using (true);
create policy "leagues_insert" on leagues for insert with check (auth.uid() = commissioner_id);
create policy "leagues_update" on leagues for update using (auth.uid() = commissioner_id);

-- Teams: readable by league members
create policy "teams_read" on teams for select using (true);
create policy "teams_insert" on teams for insert with check (auth.uid() = manager_id);
create policy "teams_update" on teams for update using (auth.uid() = manager_id);

-- Rosters: public read
create policy "rosters_read" on rosters for select using (true);

-- Lineups: public read, manager can edit own team
create policy "lineups_read" on lineups for select using (true);
create policy "lineups_write" on lineups for all using (
  auth.uid() = (select manager_id from teams where id = team_id)
);

-- Trades: league members can see
create policy "trades_read" on trades for select using (true);
create policy "trades_insert" on trades for insert with check (
  auth.uid() = (select manager_id from teams where id = proposing_team_id)
);

-- Waivers: own team only
create policy "waivers_read" on waiver_claims for select using (
  auth.uid() = (select manager_id from teams where id = team_id)
);
create policy "waivers_insert" on waiver_claims for insert with check (
  auth.uid() = (select manager_id from teams where id = team_id)
);

-- Public read for data tables
create policy "players_read" on players for select using (true);
create policy "tournaments_read" on tournaments for select using (true);
create policy "scores_read" on player_scores for select using (true);
create policy "stats_read" on player_stats for select using (true);
create policy "fantasy_scores_read" on fantasy_scores for select using (true);
create policy "entries_read" on tournament_entries for select using (true);
create policy "drafts_read" on drafts for select using (true);
create policy "draft_picks_read" on draft_picks for select using (true);

-- ============================================
-- REALTIME (enable for live updates)
-- ============================================
-- Run in Supabase dashboard: Realtime > Tables > enable for:
-- draft_picks, lineups, fantasy_scores, player_scores, trades, waiver_claims

-- ============================================
-- SEED: 2026 DGPT Elite Series Schedule
-- ============================================
insert into tournaments (name, tier, start_date, end_date, location, status, season) values
  ('Las Vegas Challenge', 'ES', '2026-03-05', '2026-03-08', 'Las Vegas, NV', 'completed', 2026),
  ('Jonesboro Open', 'ES', '2026-04-16', '2026-04-19', 'Jonesboro, AR', 'upcoming', 2026),
  ('Dynamic Discs Open', 'ES', '2026-04-23', '2026-04-26', 'Emporia, KS', 'upcoming', 2026),
  ('Texas State Championship', 'ES', '2026-05-07', '2026-05-10', 'Austin, TX', 'upcoming', 2026),
  ('Ledgestone Insurance Open', 'ES', '2026-07-09', '2026-07-12', 'Peoria, IL', 'upcoming', 2026),
  ('PDGA Champions Cup', 'Major', '2026-04-29', '2026-05-03', 'Austin, TX', 'upcoming', 2026),
  ('PDGA Pro World Championship', 'Major', '2026-08-01', '2026-08-08', 'TBD', 'upcoming', 2026);
