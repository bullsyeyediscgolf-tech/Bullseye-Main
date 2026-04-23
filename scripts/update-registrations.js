/**
 * Bullseye Fantasy Disc Golf — Tournament Registration Scraper
 *
 * Scrapes the PDGA tournament pages for upcoming events to find
 * which players are registered. Stores results in Supabase so the
 * player profile page can show registration badges.
 *
 * Data source:
 *   PDGA event page → https://www.pdga.com/tour/event/{pdga_id}
 *   Registered players are listed with their PDGA numbers.
 *
 * Usage:
 *   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node scripts/update-registrations.js
 *
 * The script is idempotent — safe to re-run at any time.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

/** Detect which registrations table exists in this Supabase project. */
async function resolveRegistrationTable() {
  const candidates = ['tournament_registrations', 'tournament_entries'];
  for (const table of candidates) {
    try {
      await supabaseRpc(table, { query: { select: 'id', limit: '1' } });
      return table;
    } catch (err) {
      if (!String(err.message).includes('PGRST205')) throw err;
    }
  }
  throw new Error(
    `No registration table found. Expected one of: ${candidates.join(', ')}`
  );
}

// ---------------------------------------------------------------------------
// PDGA Registration Scraper
// ---------------------------------------------------------------------------

/**
 * Fetch the PDGA event page and extract registered player PDGA numbers.
 * The registration list is in HTML — we parse it for PDGA numbers.
 */
async function fetchRegisteredPlayers(pdgaId) {
  const url = `https://www.pdga.com/tour/event/${pdgaId}`;
  console.log(`  Fetching ${url}...`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; BullseyeFantasyDG/1.0)',
    },
  });

  if (!res.ok) {
    throw new Error(`PDGA event page ${pdgaId}: HTTP ${res.status}`);
  }

  const html = await res.text();

  // Extract PDGA numbers from the registered players section.
  // PDGA event pages list registered players with links like:
  //   /player/{pdga_number}
  // We look for these in the registration section of the page.
  const pdgaNumbers = new Set();

  // Method 1: Look for player profile links with PDGA numbers
  // Pattern: /player/12345 or href containing player PDGA numbers
  const playerLinkRegex = /\/player\/(\d{3,7})/g;
  let match;
  while ((match = playerLinkRegex.exec(html)) !== null) {
    pdgaNumbers.add(match[1]);
  }

  // Method 2: Also look for PDGA# patterns in table cells
  const pdgaNumRegex = /PDGA\s*#?\s*(\d{3,7})/gi;
  while ((match = pdgaNumRegex.exec(html)) !== null) {
    pdgaNumbers.add(match[1]);
  }

  return [...pdgaNumbers];
}

/**
 * Alternative: Try the PDGA Live API to get registered players.
 * Some events expose registration data through the live API even before starting.
 */
async function fetchRegisteredPlayersFromApi(pdgaId) {
  try {
    const url = `https://www.pdga.com/apps/tournament/live-api/live_results_fetch_event?TournID=${pdgaId}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const mpoDiv = data.data?.Divisions?.find(d => d.Division === 'MPO');
    if (!mpoDiv) return null;

    // If the event has player data before it starts, extract PDGA numbers
    // Try fetching round 0 or round 1 for pre-event registration data
    const roundUrl = `https://www.pdga.com/apps/tournament/live-api/live_results_fetch_round?TournID=${pdgaId}&Division=MPO&Round=1`;
    const roundRes = await fetch(roundUrl);
    if (!roundRes.ok) return null;

    const roundData = await roundRes.json();
    const scores = roundData.data?.scores;
    if (!scores || scores.length === 0) return null;

    return scores.map(s => String(s.PDGANum));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Fetching upcoming/active tournaments from Supabase...');
  const registrationTable = await resolveRegistrationTable();
  console.log(`Using registration table: ${registrationTable}`);

  // Get tournaments that are upcoming or active (within next 30 days or currently happening)
  const tournaments = await supabaseRpc('tournaments', {
    query: {
      select: '*',
      season: 'eq.2026',
      order: 'start_date.asc',
    },
  });

  // Filter to upcoming and active tournaments
  const now = new Date();
  const relevantTournaments = tournaments.filter(t => {
    if (!t.pdga_id) return false;
    if (t.status === 'upcoming' || t.status === 'active') return true;
    return false;
  });

  if (relevantTournaments.length === 0) {
    console.log('No upcoming/active tournaments to check registrations for.');
    return;
  }

  // Load player lookup (pdga_number → id)
  const players = await supabaseRpc('players', {
    query: { select: 'id,name,pdga_number', active: 'eq.true' },
  });
  const playerByPdga = {};
  for (const p of players) {
    if (p.pdga_number) playerByPdga[String(p.pdga_number)] = p;
  }
  console.log(`Loaded ${Object.keys(playerByPdga).length} players with PDGA numbers.`);

  for (const tourn of relevantTournaments) {
    console.log(`\nChecking registrations: ${tourn.name} (PDGA ${tourn.pdga_id})...`);

    let pdgaNumbers = null;

    // Try the live API first (faster, structured data)
    pdgaNumbers = await fetchRegisteredPlayersFromApi(tourn.pdga_id);
    if (pdgaNumbers && pdgaNumbers.length > 0) {
      console.log(`  Found ${pdgaNumbers.length} players via PDGA Live API`);
    } else {
      // Fall back to scraping the event page HTML
      try {
        pdgaNumbers = await fetchRegisteredPlayers(tourn.pdga_id);
        console.log(`  Found ${pdgaNumbers.length} PDGA numbers from event page`);
      } catch (err) {
        console.warn(`  Could not fetch registrations: ${err.message}`);
        continue;
      }
    }

    if (!pdgaNumbers || pdgaNumbers.length === 0) {
      console.log('  No registered players found');
      continue;
    }

    // Match PDGA numbers to our player pool
    const registrationRows = [];
    let matched = 0;
    for (const pdgaNum of pdgaNumbers) {
      const player = playerByPdga[pdgaNum];
      if (player) {
        registrationRows.push({
          tournament_id: tourn.id,
          player_id: player.id,
        });
        matched++;
      }
    }

    console.log(`  Matched ${matched} players in our pool`);

    if (registrationRows.length > 0) {
      // Clear old registrations for this tournament first, then insert fresh
      console.log(`  Clearing old registrations for ${tourn.name}...`);
      await supabaseRpc(`${registrationTable}?tournament_id=eq.${tourn.id}`, {
        method: 'DELETE',
      });

      console.log(`  Inserting ${registrationRows.length} registrations...`);
      for (let i = 0; i < registrationRows.length; i += 50) {
        await supabaseRpc(registrationTable, {
          method: 'POST',
          body: registrationRows.slice(i, i + 50),
          onConflict: 'tournament_id,player_id',
        });
      }
    }
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
