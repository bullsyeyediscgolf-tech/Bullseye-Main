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

async function fetchPdgaScores(tournId, round) {
  const res = await fetch(
    `${PDGA_BASE}/live_results_fetch_event_top_players?TournID=${tournId}&Round=${round}`
  );
  if (!res.ok) throw new Error(`PDGA scores ${tournId} R${round}: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// DGPT Stats (HTML scrape — server-side)
// ---------------------------------------------------------------------------

async function fetchDgptStats(tournId, division = 'MPO') {
  try {
    const form = new URLSearchParams();
    form.append('action', 'get_event_stats');
    form.append('id', String(tournId));
    form.append('division', division);
    form.append('round', '3'); // tournament averages appear on final round page

    const res = await fetch('https://www.dgpt.com/wp-admin/admin-ajax.php', {
      method: 'POST',
      body: form,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Parse with a regex-based approach (no DOM in Node without extra deps)
    // Each row: <tr>...<td>pos</td><td>name</td><td>total</td><td>scores</td>
    //   <td>fwy</td><td>parked</td><td>c1ir</td><td>c2ir</td><td>scramble</td>
    //   <td>c1x</td><td>c2put</td><td>ob</td></tr>
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

// ---------------------------------------------------------------------------
// Eagle detection from hole-by-hole scores
// ---------------------------------------------------------------------------

function countEagles(scoresStr, parLayout) {
  if (!scoresStr || !parLayout) return 0;
  const scores = scoresStr.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
  let eagles = 0;
  for (let i = 0; i < scores.length && i < parLayout.length; i++) {
    if (scores[i] <= parLayout[i] - 2) eagles++;
  }
  return eagles;
}

// ---------------------------------------------------------------------------
// Main update flow
// ---------------------------------------------------------------------------

async function main() {
  console.log('Fetching tournaments from Supabase...');
  const tournaments = await supabaseRpc('tournaments', {
    query: { select: '*', season: 'eq.2026', order: 'start_date.asc' },
  });

  // Also load player lookup (pdga_number → id)
  const players = await supabaseRpc('players', {
    query: { select: 'id,name,pdga_number', active: 'eq.true' },
  });
  const playerByPdga = {};
  const playerByName = {};
  for (const p of players) {
    if (p.pdga_number) playerByPdga[p.pdga_number] = p;
    playerByName[p.name] = p;
  }

  // Fetch PDGA layout info for eagle detection
  async function getParLayout(tournId) {
    try {
      const res = await fetch(
        `https://www.pdga.com/api/v1/live-tournaments/${tournId}/live-layouts?include=LiveLayoutDetails`
      );
      if (!res.ok) return null;
      const layouts = await res.json();
      // Find MPO layout (usually the one with more details)
      for (const layout of layouts) {
        if (layout.liveLayoutDetails && layout.liveLayoutDetails.length > 0) {
          return layout.liveLayoutDetails
            .sort((a, b) => a.holeOrdinal - b.holeOrdinal)
            .map((h) => h.par);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // Process each active or completed tournament that has a pdga_id
  for (const tourn of tournaments) {
    if (!tourn.pdga_id) {
      console.log(`Skipping ${tourn.name} — no pdga_id`);
      continue;
    }
    if (tourn.status === 'upcoming') {
      console.log(`Skipping ${tourn.name} — upcoming`);
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

    const totalRounds = mpoDiv.LatestRound || tourn.rounds;
    const parLayout = await getParLayout(tourn.pdga_id);

    // Update tournament status
    const highestRound = eventData.data?.HighestCompletedRound || 0;
    let newStatus = tourn.status;
    if (highestRound >= totalRounds) newStatus = 'completed';
    else if (highestRound > 0) newStatus = 'active';

    if (newStatus !== tourn.status) {
      console.log(`  Updating status: ${tourn.status} → ${newStatus}`);
      await supabaseRpc(`tournaments?id=eq.${tourn.id}`, {
        method: 'PATCH',
        body: { status: newStatus },
      });
    }

    // Fetch scores for each round
    for (let rd = 1; rd <= highestRound; rd++) {
      console.log(`  Round ${rd}...`);
      let roundData;
      try {
        roundData = await fetchPdgaScores(tourn.pdga_id, rd);
      } catch (err) {
        console.warn(`    Fetch error: ${err.message}`);
        continue;
      }

      const mpoStanding = roundData.data?.DivisionStandings?.find(
        (d) => d.division === 'MPO'
      );
      if (!mpoStanding || !mpoStanding.scores) continue;

      // Determine lead card for this round:
      // R1 = nobody. R2+ = top 4 from prior round cumulative standings.
      const leadCardPdgas = new Set();
      if (rd > 1) {
        // Fetch prior round to get top 4 cumulative
        try {
          const priorData = await fetchPdgaScores(tourn.pdga_id, rd - 1);
          const priorMpo = priorData.data?.DivisionStandings?.find(
            (d) => d.division === 'MPO'
          );
          if (priorMpo?.scores) {
            // scores are already sorted by RunningPlace
            const top4 = priorMpo.scores.slice(0, 4);
            for (const p of top4) {
              leadCardPdgas.add(String(p.PDGANum));
            }
          }
        } catch {
          // non-fatal
        }
      }

      const scoreRows = [];
      for (const ps of mpoStanding.scores) {
        const pdga = String(ps.PDGANum);
        const player = playerByPdga[pdga] || playerByName[ps.Name];
        if (!player) continue; // not in our player pool

        // Parse per-round score from the Rounds CSV
        const roundScores = ps.Rounds ? ps.Rounds.split(',').map(Number) : [];
        // RoundtoPar is relative to par for this specific round
        const scoreToPar = ps.RoundtoPar;

        // Eagle count from hole-by-hole Scores field
        let eagles = 0;
        if (ps.Scores && parLayout) {
          // Scores field has all rounds concatenated; extract this round's holes
          const allHoles = ps.Scores.split(',').filter((s) => s.trim() !== '');
          const holesPerRound = parLayout.length;
          const startIdx = (rd - 1) * holesPerRound;
          const roundHoles = allHoles.slice(startIdx, startIdx + holesPerRound).map(Number);
          for (let i = 0; i < roundHoles.length && i < parLayout.length; i++) {
            if (roundHoles[i] > 0 && roundHoles[i] <= parLayout[i] - 2) eagles++;
          }
        }

        const isLeadCard = leadCardPdgas.has(pdga);
        const finishPos = rd === highestRound && highestRound >= totalRounds
          ? ps.RunningPlace
          : null;

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
      const dgptStats = await fetchDgptStats(tourn.pdga_id);
      if (dgptStats) {
        const statRows = [];
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
        if (statRows.length > 0) {
          console.log(`    Upserting ${statRows.length} stat rows...`);
          for (let i = 0; i < statRows.length; i += 50) {
            await supabaseRpc('player_stats', {
              method: 'POST',
              body: statRows.slice(i, i + 50),
              onConflict: 'player_id,tournament_id',
            });
          }
        }
      } else {
        console.log('    No DGPT stats available (will use PDGA data only)');
      }
    }
  }

  console.log('\nDone!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
