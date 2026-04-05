-- ============================================
-- ADD DELETE RLS POLICIES
-- Allows: team manager can leave (delete own team)
--         commissioner can remove any team from their league
-- Run this in Supabase SQL Editor
-- ============================================

-- Teams: manager can delete own team, OR commissioner can delete any team in their league
CREATE POLICY "teams_delete" ON teams FOR DELETE USING (
  auth.uid() = manager_id
  OR
  auth.uid() = (SELECT commissioner_id FROM leagues WHERE id = league_id)
);

-- Rosters: manager can delete own team's rosters, OR commissioner can delete any roster in their league
CREATE POLICY "rosters_delete" ON rosters FOR DELETE USING (
  auth.uid() = (SELECT manager_id FROM teams WHERE id = team_id)
  OR
  auth.uid() = (SELECT commissioner_id FROM leagues WHERE id = league_id)
);

-- Rosters: also need insert/update for roster management
-- (insert policy may already exist — this is safe because CREATE POLICY will error if duplicate)
-- If you get "policy already exists" errors, that's fine — skip those.

-- Lineups: manager can delete own, commissioner can delete any in their league
CREATE POLICY "lineups_delete" ON lineups FOR DELETE USING (
  auth.uid() = (SELECT manager_id FROM teams WHERE id = team_id)
  OR
  auth.uid() = (SELECT commissioner_id FROM leagues WHERE leagues.id = (SELECT league_id FROM teams WHERE teams.id = team_id))
);

-- Fantasy scores: commissioner can clean up removed team's scores
CREATE POLICY "fantasy_scores_delete" ON fantasy_scores FOR DELETE USING (
  auth.uid() = (SELECT commissioner_id FROM leagues WHERE leagues.id = (SELECT league_id FROM teams WHERE teams.id = team_id))
);

-- Draft picks: commissioner can clean up removed team's draft picks
CREATE POLICY "draft_picks_delete" ON draft_picks FOR DELETE USING (
  auth.uid() = (SELECT commissioner_id FROM leagues WHERE id = league_id)
);

-- Waiver claims: manager can delete own, commissioner can delete any in their league
CREATE POLICY "waivers_delete" ON waiver_claims FOR DELETE USING (
  auth.uid() = (SELECT manager_id FROM teams WHERE id = team_id)
  OR
  auth.uid() = (SELECT commissioner_id FROM leagues WHERE id = league_id)
);

-- Trades: commissioner can clean up trades involving removed teams
CREATE POLICY "trades_delete" ON trades FOR DELETE USING (
  auth.uid() = (SELECT commissioner_id FROM leagues WHERE id = league_id)
);
