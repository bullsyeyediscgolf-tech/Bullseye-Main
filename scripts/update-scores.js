/**
 * Bullseye Fantasy Disc Golf — Automatic Score Updater
 *
 * Fetches tournament results from the PDGA Live API and player stats from
 * the DGPT website, then upserts them into Supabase.
 *
 * Data sources:
 *   Scores  → PDGA Live API  (public JSON, no auth)
 *   Stats   → DGPT admin-ajax  (returns HTML, parsed server-side)
 *
 * Usage:
 *   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node scripts/update-scores.js
 *
 * The script is idempotent — safe to re-run at any time.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service_role key for writes

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function supabaseRpc(path, { method = 'GET', body, query, onConflict } = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  const q = query ? { ...query } : {};
  if (onConflict) q.on_conflict = onConflict;
  if (Object.keys(q).length > 0) {
    const params = new URLSearchParams(q);
    url += `?${params}`;
  }
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${text}`);
  }
  if (method === 'GET') return res.json();
  return null;
}

// ---------------------------------------------------------------------------
// PDGA Live API
// ---------------------------------------------------------------------------

const PDGA_BASE = 'https://www.pdga.com/apps/tournament/live-api';

async function fetchPdgaEvent(tournId) {
  const res = await fetch(`${PDGA_BASE}/live_results_fetch_event?TournID=${tournId}`);
  if (!res.ok) throw new Error(`PDGA event ${tournId}: ${res.status}`);
  return res.json();
}

/** Fetch full round leaderboard (all players) for a division */
async function fetchPdgaRound(tournId, division, round) {
  const res = await fetch(
    `${PDGA_BASE}/live_results_fetch_round?TournID=${tournId}&Division=${division}&Round=${round}`
  );
  if (!res.ok) throw new Error(`PDGA round ${tournId} ${division} R${round}: ${res.status}`);
  return res.json();
}

/** Normalize completed rounds using configured tournament rounds when available. */
function getHighestRound(rawHighestRound, configuredRounds) {
  const highest = Number(rawHighestRound) || 0;
  const cap = Number(configuredRounds) || 0;
  if (cap > 0) return Math.min(highest, cap);
  return highest;
}

// ---------------------------------------------------------------------------
// DGPT Stats (HTML scrape — server-side)
// ---------------------------------------------------------------------------

async function fetchDgptStats(tournId, finalRound, division = 'MPO') {
  try {
    const form = new URLSearchParams();
    form.append('action', 'get_event_stats');
    form.append('id', String(tournId));
    form.append('division', division);
    form.append('round', String(finalRound || 1)); // tournament averages appear on final round page

    const res = await fetch('https://www.dgpt.com/wp-admin/admin-ajax.php', {
      method: 'POST',
      body: form,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Parse with a regex-based approach (no DOM in Node without extra deps)
    const rowRegex = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;

    const stats = {};
    let m;
    while ((m = rowRegex.exec(html)) !== null) {
      const name = m[2].replace(/<[^>]+>/g, '').trim();
      if (!name || name === 'Name' || name.includes('unavailable')) continue;
      stats[name] = {
        fwy: parseFloat(m[5].replace(/<[^>]+>/g, '').trim()) || 0,
        c1ir: parseFloat(m[7].replace(/<[^>]+>/g, '').trim()) || 0,
        c1x: parseFloat(m[10].replace(/<[^>]+>/g, '').trim()) || 0,
        c2put: parseFloat(m[11].replace(/<[^>]+>/g, '').trim()) || 0,
      };
    }
    return Object.keys(stats).length > 0 ? stats : null;
  } catch (err) {
    console.warn('DGPT stats fetch failed (non-fatal):', err.message);
    return null;
  }
}

/** Normalize names for loose matching across sources. */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Convert "72.3%" style strings to numeric percentages. */
function parsePct(value) {
  const n = parseFloat(String(value || '').replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

/** Load Playwright only when needed for PDGA stats scraping. */
async function getPlaywrightChromium() {
  try {
    const mod = await import('playwright');
    return mod.chromium;
  } catch {
    console.warn('Playwright not installed; skipping PDGA page scrape fallback.');
    return null;
  }
}

/** Find a stat value in a row using multiple possible column names. */
function pickStat(row, keys) {
  for (const key of keys) {
    if (row[key] != null && row[key] !== '') return row[key];
  }
  return null;
}

/** Scrape PDGA Live stats table using browser-rendered DOM. */
async function scrapePdgaStatsTable(pdgaId) {
  const chromium = await getPlaywrightChromium();
  if (!chromium) return null;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    const url = `https://www.pdga.com/live/event/${pdgaId}/MPO/stats?round=All`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('.stats-full-table .table-row', { timeout: 30000 });
    const rows = await page.evaluate(() => {
      const headerCells = Array.from(
        document.querySelectorAll('.stats-full-table .header-row .header-col')
      );
      const headers = headerCells.map((cell) => {
        const label = cell.querySelector('.label-2-bold');
        return (label?.textContent || '').trim();
      });
      const tableRows = Array.from(document.querySelectorAll('.stats-full-table .table-row'));
      return tableRows.map((row) => {
        const cells = Array.from(row.querySelectorAll('.cell-wrapper'));
        const obj = {};
        cells.forEach((cell, idx) => {
          const key = headers[idx] || `col_${idx}`;
          if (key === 'Player') {
            const first = cell.querySelector('.player-first-name')?.textContent?.trim() || '';
            const last = cell.querySelector('.player-last-name')?.textContent?.trim() || '';
            obj.Player = `${first} ${last}`.trim();
            return;
          }
          const spans = Array.from(cell.querySelectorAll('span')).map((s) => s.textContent?.trim() || '');
          if (spans.length > 1 && spans[1].includes('/')) {
            const [made, attempted] = spans[1].split('/');
            obj[`${key}_made`] = made;
            obj[`${key}_attempted`] = attempted;
          }
          obj[key] = spans[0] || '';
        });
        return obj;
      });
    });
    return rows?.length ? rows : null;
  } catch (err) {
    console.warn(`PDGA stats scrape failed (non-fatal): ${err.message}`);
    return null;
  } finally {
    await page.close();
    await browser.close();
  }
}

/** Map scraped PDGA rows into player_stats upsert rows. */
function buildStatRowsFromPdgaScrape(scrapedRows, players, tournamentId) {
  const byName = new Map(players.map((p) => [normalizeName(p.name), p]));
  const rows = [];
  for (const row of scrapedRows || []) {
    const name = row.Player || row.player || '';
    const player = byName.get(normalizeName(name));
    if (!player) continue;
    const c1x = pickStat(row, ['C1XPutting', 'C1X', 'C1X Putt']);
    const c2 = pickStat(row, ['C2Putting', 'C2', 'C2 Putt']);
    const fwy = pickStat(row, ['Fairway', 'FWH', 'Fairway Hits']);
    const c1ir = pickStat(row, ['C1Reg', 'C1 in Regulation', 'C1IR']);
    rows.push({
      player_id: player.id,
      tournament_id: tournamentId,
      c1x_putting_pct: parsePct(c1x),
      c2_putting_pct: parsePct(c2),
      fairway_hit_pct: parsePct(fwy),
      c1_in_reg_pct: parsePct(c1ir),
    });
  }
  return rows.filter((r) =>
    r.c1x_putting_pct != null || r.c2_putting_pct != null || r.fairway_hit_pct != null || r.c1_in_reg_pct != null
  );
}

// ---------------------------------------------------------------------------
// Main update flow
// ---------------------------------------------------------------------------

async function main() {
  console.log('Fetching tournaments from Supabase...');
  const tournaments = await supabaseRpc('tournaments', {
    query: { select: '*', season: 'eq.2026', order: 'start_date.asc' },
  });

  // Load player lookup (pdga_number → id)
  const players = await supabaseRpc('players', {
    query: { select: 'id,name,pdga_number', active: 'eq.true' },
  });
  const playerByPdga = {};
  const playerByName = {};
  for (const p of players) {
    if (p.pdga_number) playerByPdga[p.pdga_number] = p;
    playerByName[p.name] = p;
  }

  // Process each tournament that has a pdga_id
  for (const tourn of tournaments) {
    if (!tourn.pdga_id) {
      console.log(`Skipping ${tourn.name} — no pdga_id`);
      continue;
    }

    console.log(`\nProcessing: ${tourn.name} (PDGA ${tourn.pdga_id})...`);

    // Fetch event info from PDGA
    let eventData;
    try {
      eventData = await fetchPdgaEvent(tourn.pdga_id);
    } catch (err) {
      console.warn(`  Could not fetch PDGA event: ${err.message}`);
      continue;
    }

    const mpoDiv = eventData.data?.Divisions?.find((d) => d.Division === 'MPO');
    if (!mpoDiv) {
      console.warn('  No MPO division found');
      continue;
    }

    const configuredRounds = Number(tourn.rounds) || 0;
    const rawHighestRound = Number(eventData.data?.HighestCompletedRound) || 0;
    const highestRound = getHighestRound(rawHighestRound, configuredRounds);
    if (rawHighestRound !== highestRound) {
      console.log(`  Capping completed rounds: ${rawHighestRound} → ${highestRound}`);
    }

    // Update tournament status
    let newStatus = 'upcoming';
    if (highestRound > 0) newStatus = 'active';
    if (configuredRounds > 0 && highestRound >= configuredRounds) newStatus = 'completed';

    if (newStatus !== tourn.status) {
      console.log(`  Updating status: ${tourn.status} → ${newStatus}`);
      await supabaseRpc(`tournaments?id=eq.${tourn.id}`, {
        method: 'PATCH',
        body: { status: newStatus },
      });
    }

    if (highestRound === 0) {
      console.log(`  Skipping ${tourn.name} — no completed rounds yet`);
      continue;
    }

    // Fetch scores for each completed round using the full leaderboard endpoint
    for (let rd = 1; rd <= highestRound; rd++) {
      console.log(`  Round ${rd}...`);
      let roundData;
      try {
        roundData = await fetchPdgaRound(tourn.pdga_id, 'MPO', rd);
      } catch (err) {
        console.warn(`    Fetch error: ${err.message}`);
        continue;
      }

      const allScores = roundData.data?.scores;
      if (!allScores || allScores.length === 0) {
        console.warn(`    No scores returned`);
        continue;
      }

      console.log(`    Got ${allScores.length} players`);

      // Lead card: R1 = nobody. R2+ = top 4 from prior round standings.
      // The API gives us PreviousPlace on each player, but we can also
      // fetch the prior round and sort by RunningPlace.
      const leadCardPdgas = new Set();
      if (rd > 1) {
        try {
          const priorRound = await fetchPdgaRound(tourn.pdga_id, 'MPO', rd - 1);
          const priorScores = priorRound.data?.scores;
          if (priorScores) {
            // Sort by RunningPlace (cumulative standing after that round)
            const sorted = [...priorScores].sort(
              (a, b) => (a.RunningPlace || 999) - (b.RunningPlace || 999)
            );
            for (const p of sorted.slice(0, 4)) {
              leadCardPdgas.add(String(p.PDGANum));
            }
            console.log(
              `    Lead card: ${sorted
                .slice(0, 4)
                .map((p) => p.ShortName)
                .join(', ')}`
            );
          }
        } catch {
          // non-fatal
        }
      }

      // Build score rows
      const scoreRows = [];
      for (const ps of allScores) {
        const pdga = String(ps.PDGANum);
        const player = playerByPdga[pdga] || playerByName[ps.Name];
        if (!player) continue; // not in our player pool

        let scoreToPar = ps.RoundtoPar;

        // Cap DNF scores: PDGA API returns 999/930 for DNF players
        if (scoreToPar == null || scoreToPar > 10) {
          scoreToPar = 10; // DNF = +10 over par
        }

        // Eagle detection from HoleScores + Pars
        let eagles = 0;
        if (ps.HoleScores && ps.Pars) {
          const holes = Array.isArray(ps.HoleScores) ? ps.HoleScores : ps.HoleScores.split(',');
          const pars = ps.Pars.split(',');
          for (let i = 0; i < holes.length; i++) {
            const score = parseInt(holes[i], 10);
            const par = parseInt(pars[i], 10);
            if (score > 0 && par > 0 && score <= par - 2) eagles++;
          }
        }

        const isLeadCard = leadCardPdgas.has(pdga);

        // Finish position: only set on the final round of a completed tournament
        const isTournamentComplete = configuredRounds > 0 && highestRound >= configuredRounds;
        const finishPos = rd === highestRound && isTournamentComplete ? ps.RunningPlace : null;

        scoreRows.push({
          player_id: player.id,
          tournament_id: tourn.id,
          round: rd,
          score_relative_par: scoreToPar,
          is_lead_card: isLeadCard,
          eagles,
          parked_holes: 0, // PDGA API doesn't provide parked data
          finish_position: finishPos,
        });
      }

      if (scoreRows.length > 0) {
        console.log(`    Upserting ${scoreRows.length} scores...`);
        // Upsert in batches of 50
        for (let i = 0; i < scoreRows.length; i += 50) {
          await supabaseRpc('player_scores', {
            method: 'POST',
            body: scoreRows.slice(i, i + 50),
            onConflict: 'player_id,tournament_id,round',
          });
        }
      }
    }

    // Fetch stats from DGPT (only for completed tournaments)
    if (newStatus === 'completed') {
      console.log('  Fetching DGPT stats...');
      const finalRoundForStats = configuredRounds > 0 ? configuredRounds : highestRound;
      const dgptStats = await fetchDgptStats(tourn.pdga_id, finalRoundForStats);
      let statRows = [];
      if (dgptStats) {
        for (const [name, st] of Object.entries(dgptStats)) {
          const player = playerByName[name];
          if (!player) continue;
          statRows.push({
            player_id: player.id,
            tournament_id: tourn.id,
            c1x_putting_pct: st.c1x,
            c2_putting_pct: st.c2put,
            fairway_hit_pct: st.fwy,
            c1_in_reg_pct: st.c1ir,
          });
        }
      } else {
        console.log('    DGPT stats unavailable; trying PDGA stats page scrape...');
        const scraped = await scrapePdgaStatsTable(tourn.pdga_id);
        statRows = buildStatRowsFromPdgaScrape(scraped, players, tourn.id);
      }
      if (statRows.length > 0) {
        console.log(`    Upserting ${statRows.length} stat rows...`);
        for (let i = 0; i < statRows.length; i += 50) {
          await supabaseRpc('player_stats', {
            method: 'POST',
            body: statRows.slice(i, i + 50),
            onConflict: 'player_id,tournament_id',
          });
        }
      } else {
        console.log('    No stats rows parsed from DGPT or PDGA scrape');
      }
    }
  }

  console.log('\nDone!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
