# 🥏 Bullseye Fantasy Disc Golf

Fantasy disc golf platform for the 2026 DGPT Elite Series & Majors.

## Tech Stack
- **Frontend**: Vanilla HTML/CSS/JS — hosted on GitHub Pages
- **Backend**: Supabase (Postgres + Realtime + Auth)

## Setup Instructions

### 1. Run the Database Schema
1. Go to your [Supabase project](https://app.supabase.com/project/priwbgrlmufrgdpfukoq)
2. Click **SQL Editor** in the left sidebar
3. Open `supabase_schema.sql` from this repo
4. Click **Run** — this creates all tables, policies, and seeds the 2026 schedule

### 2. Enable Realtime
1. In Supabase → **Database** → **Replication**
2. Enable realtime for these tables:
   - `draft_picks`
   - `lineups`
   - `fantasy_scores`
   - `player_scores`
   - `trades`
   - `waiver_claims`

### 3. Enable GitHub Pages
1. Go to your repo Settings → Pages
2. Source: `Deploy from branch`
3. Branch: `main`, Folder: `/ (root)`
4. Save

Your site will be live at: `https://bullsyeyediscgolf-tech.github.io/Bullseye-Main/`

### 4. Push to GitHub
```bash
git init
git add .
git commit -m "Phase 1: Foundation"
git branch -M main
git remote add origin https://github.com/bullsyeyediscgolf-tech/Bullseye-Main.git
git push -u origin main
```

## Project Structure
```
/
├── index.html              # Login/signup page
├── css/
│   └── main.css            # All styles
├── js/
│   ├── supabase.js         # Supabase client + helpers + scoring engine
│   ├── auth.js             # Login/signup/logout
│   └── dashboard.js        # Dashboard logic
├── pages/
│   ├── dashboard.html      # Main dashboard
│   ├── join.html           # League invite join flow
│   ├── draft.html          # (Phase 2)
│   ├── roster.html         # (Phase 2)
│   ├── lineup.html         # (Phase 3)
│   ├── leaderboard.html    # (Phase 4)
│   ├── standings.html      # (Phase 5)
│   ├── waivers.html        # (Phase 6)
│   └── trades.html         # (Phase 6)
└── supabase_schema.sql     # Full DB schema — run once in Supabase
```

## Phases
- [x] **Phase 1** — Foundation (auth, league creation, dashboard, schema)
- [ ] **Phase 2** — Draft Room (live draft, pick timer, snake draft)
- [ ] **Phase 3** — Roster & Lineup management
- [ ] **Phase 4** — Scoring engine + DGPT data integration
- [ ] **Phase 5** — Live leaderboard + tournament standings
- [ ] **Phase 6** — Trades + FAAB waiver wire

## Scoring Reference
| Event | Points |
|-------|--------|
| 1 stroke under par | +1 pt |
| Lead card (Rd 2+) | ×1.5 multiplier |
| Eagle | +1 bonus |
| Parked hole | +1 bonus |
| Tournament 1st | +15 bonus |
| Tournament 2nd | +8 bonus |
| Tournament 3rd | +3 bonus |
| Best putter stats | +7 bonus |
| 2nd best putter stats | +3 bonus |
| *(same for driver, approacher)* | |

**League standings points**: 1st=4, 2nd=2, 3rd=1, 4th=0, 5th=-1, etc.
Tiebreaker: raw score (total strokes under par).
