-- Tournament Registrations table
-- Tracks which players are registered for upcoming tournaments
-- Populated by scripts/update-registrations.js

CREATE TABLE IF NOT EXISTS tournament_registrations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tournament_id, player_id)
);

-- Index for fast lookups by player
CREATE INDEX IF NOT EXISTS idx_tourn_reg_player ON tournament_registrations(player_id);
-- Index for fast lookups by tournament
CREATE INDEX IF NOT EXISTS idx_tourn_reg_tournament ON tournament_registrations(tournament_id);

-- Enable RLS
ALTER TABLE tournament_registrations ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read registrations
CREATE POLICY "Anyone can read registrations"
  ON tournament_registrations FOR SELECT
  USING (true);
