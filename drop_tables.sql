-- ============================================
-- BULLSEYE - DROP ALL TABLES
-- Run this FIRST if you get "already exists" errors
-- Then run supabase_schema.sql after
-- ============================================

drop table if exists draft_picks cascade;
drop table if exists drafts cascade;
drop table if exists waiver_claims cascade;
drop table if exists trades cascade;
drop table if exists fantasy_scores cascade;
drop table if exists player_stats cascade;
drop table if exists player_scores cascade;
drop table if exists lineups cascade;
drop table if exists tournament_entries cascade;
drop table if exists tournaments cascade;
drop table if exists rosters cascade;
drop table if exists players cascade;
drop table if exists teams cascade;
drop table if exists leagues cascade;
