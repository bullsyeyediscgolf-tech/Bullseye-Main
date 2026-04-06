-- ============================================
-- ADD DRAFT RLS POLICIES
-- Fixes: commissioner can't start draft, players can't make picks
-- Run this in Supabase SQL Editor
-- ============================================

-- Drafts: commissioner can insert (create draft) and update (start/complete)
CREATE POLICY "drafts_insert" ON drafts FOR INSERT WITH CHECK (
  auth.uid() = (SELECT commissioner_id FROM leagues WHERE id = league_id)
);

CREATE POLICY "drafts_update" ON drafts FOR UPDATE USING (
  auth.uid() = (SELECT commissioner_id FROM leagues WHERE id = league_id)
);

-- Draft picks: any league member can insert a pick
-- (the application code validates it's actually their turn)
CREATE POLICY "draft_picks_insert" ON draft_picks FOR INSERT WITH CHECK (
  auth.uid() IN (SELECT manager_id FROM teams WHERE league_id = draft_picks.league_id)
);

-- Rosters: league members can insert (needed for draft roster additions)
CREATE POLICY "rosters_insert" ON rosters FOR INSERT WITH CHECK (
  auth.uid() IN (SELECT manager_id FROM teams WHERE league_id = rosters.league_id)
);
