// ============================================
// BULLSEYE - PLAYER PROFILE
// ============================================

let profileState = {
  user: null,
  player: null,
  scores: [],       // all player_scores rows
  stats: [],        // all player_stats rows
  tournaments: [],  // all tournaments with data
  rosterInfo: null,  // { teamId, teamName } or null
  myTeamId: null,
  leagueSettings: null,
};

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;
  profileState.user = user;

  const name = user.user_metadata?.display_name || user.email.split('@')[0];
  document.getElementById('user-avatar').textContent = getInitials(name);
  document.getElementById('user-display-name').textContent = name;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await db.auth.signOut(); window.location.href = '../index.html';
  });

  // Get player ID from URL
  const params = new URLSearchParams(window.location.search);
  const playerId = params.get('id');
  if (!playerId) {
    showNotFound();
    return;
  }

  await loadProfile(playerId);
});

function showNotFound() {
  document.getElementById('loading-state').classList.add('hidden');
  document.getElementById('not-found').classList.remove('hidden');
}

async function loadProfile(playerId) {
  // Load player, team info, and league settings in parallel
  const [playerRes, teamsRes] = await Promise.all([
    db.from('players').select('*').eq('id', playerId).single(),
    db.from('teams').select('*, leagues(*)').eq('manager_id', profileState.user.id),
  ]);

  if (playerRes.error || !playerRes.data) {
    showNotFound();
    return;
  }

  profileState.player = playerRes.data;

  if (teamsRes.data?.length) {
    const team = teamsRes.data[0];
    profileState.myTeamId = team.id;
    profileState.leagueSettings = team.leagues?.settings;
    document.getElementById('league-name-display').textContent = team.leagues?.name || '—';

    // Check if this player is on anyone's roster
    const { data: rosterRows } = await db
      .from('rosters').select('player_id, teams(id, name)')
      .eq('league_id', team.league_id || team.leagues?.id)
      .eq('player_id', playerId)
      .eq('is_active', true);

    if (rosterRows?.length) {
      profileState.rosterInfo = {
        teamId: rosterRows[0].teams?.id,
        teamName: rosterRows[0].teams?.name,
      };
    }
  }

  // Load scores, stats, and tournaments in parallel
  const [scoresRes, statsRes, tournamentsRes] = await Promise.all([
    db.from('player_scores').select('*').eq('player_id', playerId).order('round', { ascending: true }),
    db.from('player_stats').select('*').eq('player_id', playerId),
    db.from('tournaments').select('*').in('status', ['active', 'completed']).eq('season', 2026).order('start_date', { ascending: true }),
  ]);

  profileState.scores = scoresRes.data || [];
  profileState.stats = statsRes.data || [];
  profileState.tournaments = tournamentsRes.data || [];

  document.getElementById('loading-state').classList.add('hidden');
  document.getElementById('profile-content').classList.remove('hidden');

  renderHero();
  renderSeasonAverages();
  renderTournamentLog();
}

// ── HERO ──
function renderHero() {
  const p = profileState.player;
  document.getElementById('topbar-player-name').textContent = p.name;
  document.getElementById('profile-avatar').textContent = getInitials(p.name);
  document.getElementById('profile-name').textContent = p.name;
  document.getElementById('profile-nationality').textContent = p.nationality || '—';
  document.getElementById('profile-pdga').textContent = `PDGA #${p.pdga_number || '—'}`;
  document.getElementById('profile-rating-badge').textContent = `Rating: ${p.pdga_rating || '—'}`;

  // Owner row
  const ownerRow = document.getElementById('profile-owner-row');
  const ri = profileState.rosterInfo;
  if (ri) {
    const isMine = ri.teamId === profileState.myTeamId;
    ownerRow.innerHTML = `<span class="pool-owner ${isMine ? 'mine' : 'other'}">${isMine ? 'My Team' : ri.teamName}</span>`;
  } else {
    ownerRow.innerHTML = `<span class="pool-owner free">Free Agent</span>`;
  }

  // Compute season-level fantasy stats
  const tournamentFantasy = computeAllFantasyPoints();
  const tournsPlayed = tournamentFantasy.length;
  const totalFpts = tournamentFantasy.reduce((s, t) => s + t.fantasyPts, 0);
  const avgFpts = tournsPlayed > 0 ? totalFpts / tournsPlayed : 0;

  // Best finish
  let bestFinish = null;
  profileState.scores.forEach(s => {
    if (s.finish_position && (bestFinish === null || s.finish_position < bestFinish)) {
      bestFinish = s.finish_position;
    }
  });

  document.getElementById('stat-avg-fpts').textContent = tournsPlayed > 0 ? avgFpts.toFixed(1) : '—';
  document.getElementById('stat-total-fpts').textContent = tournsPlayed > 0 ? totalFpts.toFixed(1) : '—';
  document.getElementById('stat-tournaments').textContent = tournsPlayed || '0';
  document.getElementById('stat-best-finish').textContent = bestFinish ? ordinal(bestFinish) : '—';
}

// ── COMPUTE FANTASY POINTS (player-independent, no team context needed) ──
function computeAllFantasyPoints() {
  const cfg = profileState.leagueSettings?.scoring || {};
  const leadMult = cfg.lead_card_multiplier || 1.5;
  const podiumBonus = cfg.podium_bonus || [15, 8, 3];
  const eagleBonus = cfg.eagle_bonus ?? 1;
  const parkedBonus = cfg.parked_bonus ?? 1;

  // Group scores by tournament
  const byTournament = {};
  profileState.scores.forEach(s => {
    if (!byTournament[s.tournament_id]) byTournament[s.tournament_id] = [];
    byTournament[s.tournament_id].push(s);
  });

  const results = [];
  Object.entries(byTournament).forEach(([tournId, rounds]) => {
    const tournament = profileState.tournaments.find(t => t.id === tournId);
    if (!tournament) return;

    rounds.sort((a, b) => a.round - b.round);

    let totalFantasy = 0;
    let totalRaw = 0;
    const roundBreakdowns = [];

    rounds.forEach(r => {
      const raw = r.score_relative_par || 0;
      const fantasyRaw = -raw; // negate: under par (negative) → positive fantasy pts
      const isLead = r.is_lead_card && r.round > 1;
      const roundScore = isLead ? fantasyRaw * leadMult : fantasyRaw;
      const eaglePts = (r.eagles || 0) * eagleBonus;
      const parkedPts = (r.parked_holes || 0) * parkedBonus;

      totalFantasy += roundScore + eaglePts + parkedPts;
      totalRaw += raw;

      roundBreakdowns.push({
        round: r.round,
        raw,
        fantasyScore: roundScore + eaglePts + parkedPts,
        isLead,
        eagles: r.eagles || 0,
        parked: r.parked_holes || 0,
      });
    });

    // Podium bonus
    const lastRound = rounds.find(r => r.finish_position != null);
    let podiumPts = 0;
    let finishPosition = lastRound?.finish_position || null;
    if (finishPosition === 1) podiumPts = podiumBonus[0];
    else if (finishPosition === 2) podiumPts = podiumBonus[1];
    else if (finishPosition === 3) podiumPts = podiumBonus[2];

    totalFantasy += podiumPts;

    // Get stats for this tournament
    const stats = profileState.stats.find(s => s.tournament_id === tournId);

    results.push({
      tournamentId: tournId,
      tournament,
      fantasyPts: Math.round(totalFantasy * 10) / 10,
      rawScore: totalRaw,
      podiumPts,
      finishPosition,
      roundBreakdowns,
      stats,
    });
  });

  // Sort by tournament date
  results.sort((a, b) => new Date(a.tournament.start_date) - new Date(b.tournament.start_date));
  return results;
}

// ── SEASON AVERAGES ──
function renderSeasonAverages() {
  const container = document.getElementById('season-averages');
  const tournamentData = computeAllFantasyPoints();

  if (!tournamentData.length) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;">No tournament data yet this season.</div>';
    return;
  }

  // Compute averages
  const totalRounds = profileState.scores.length;
  const avgRaw = profileState.scores.reduce((s, r) => s + (r.score_relative_par || 0), 0) / totalRounds;
  const totalEagles = profileState.scores.reduce((s, r) => s + (r.eagles || 0), 0);
  const totalParked = profileState.scores.reduce((s, r) => s + (r.parked_holes || 0), 0);
  const leadCardRounds = profileState.scores.filter(r => r.is_lead_card).length;

  // Stat averages
  const statsWithData = profileState.stats.filter(s => s.c1x_putting_pct != null);
  const avgC1x = statsWithData.length ? statsWithData.reduce((s, st) => s + (st.c1x_putting_pct || 0), 0) / statsWithData.length : null;
  const avgC2 = statsWithData.length ? statsWithData.reduce((s, st) => s + (st.c2_putting_pct || 0), 0) / statsWithData.length : null;
  const avgFwy = statsWithData.length ? statsWithData.reduce((s, st) => s + (st.fairway_hit_pct || 0), 0) / statsWithData.length : null;
  const avgC1ir = statsWithData.length ? statsWithData.reduce((s, st) => s + (st.c1_in_reg_pct || 0), 0) / statsWithData.length : null;

  container.innerHTML = `
    <div class="stat-chip">
      <span class="stat-chip-label">Avg Score</span>
      <span class="stat-chip-value ${avgRaw < 0 ? 'positive' : ''}">${scoreDisplay(Math.round(avgRaw * 10) / 10)}</span>
    </div>
    <div class="stat-chip">
      <span class="stat-chip-label">Total Eagles</span>
      <span class="stat-chip-value">${totalEagles}</span>
    </div>
    <div class="stat-chip">
      <span class="stat-chip-label">Total Parked</span>
      <span class="stat-chip-value">${totalParked}</span>
    </div>
    <div class="stat-chip">
      <span class="stat-chip-label">Lead Card Rds</span>
      <span class="stat-chip-value accent">${leadCardRounds}</span>
    </div>
    ${avgC1x != null ? `
    <div class="stat-chip">
      <span class="stat-chip-label">Avg C1X Put%</span>
      <span class="stat-chip-value">${avgC1x.toFixed(1)}%</span>
    </div>
    <div class="stat-chip">
      <span class="stat-chip-label">Avg C2 Put%</span>
      <span class="stat-chip-value">${avgC2.toFixed(1)}%</span>
    </div>
    <div class="stat-chip">
      <span class="stat-chip-label">Avg Fairway%</span>
      <span class="stat-chip-value">${avgFwy.toFixed(1)}%</span>
    </div>
    <div class="stat-chip">
      <span class="stat-chip-label">Avg C1 in Reg%</span>
      <span class="stat-chip-value">${avgC1ir.toFixed(1)}%</span>
    </div>
    ` : ''}
  `;
}

// ── TOURNAMENT LOG ──
function renderTournamentLog() {
  const container = document.getElementById('tournament-log');
  const tournamentData = computeAllFantasyPoints();

  if (!tournamentData.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📊</div>
        <div class="empty-state-title">No Tournament Data</div>
        <div class="empty-state-desc">This player hasn't competed in any scored tournaments yet.</div>
      </div>`;
    return;
  }

  const html = tournamentData.map(td => {
    const t = td.tournament;
    const tierBadge = t.tier === 'Major'
      ? '<span class="badge badge-major">MAJOR</span>'
      : `<span class="badge badge-es">${t.tier}</span>`;
    const statusBadge = t.status === 'active'
      ? '<span class="badge badge-live">LIVE</span>'
      : '<span class="badge badge-completed">FINAL</span>';

    // Round rows
    const roundRows = td.roundBreakdowns.map(r => `
      <div class="tlog-round-row">
        <span class="tlog-round-label">R${r.round}</span>
        <span class="tlog-round-score ${r.raw < 0 ? 'under' : r.raw > 0 ? 'over' : ''}">${scoreDisplay(r.raw)}</span>
        ${r.isLead ? '<span class="tlog-lead-badge">LC ×1.5</span>' : '<span class="tlog-lead-badge" style="opacity:0;">—</span>'}
        <span class="tlog-round-eagles">${r.eagles ? `${r.eagles} 🦅` : ''}</span>
        <span class="tlog-round-parked">${r.parked ? `${r.parked} 🎯` : ''}</span>
        <span class="tlog-round-fpts ${r.fantasyScore >= 0 ? '' : 'negative'}">${r.fantasyScore > 0 ? '+' : ''}${r.fantasyScore.toFixed(1)}</span>
      </div>
    `).join('');

    // Stats row
    let statsRow = '';
    if (td.stats) {
      const s = td.stats;
      statsRow = `
        <div class="tlog-stats-row">
          ${s.c1x_putting_pct != null ? `<span class="tlog-stat">C1X: ${s.c1x_putting_pct.toFixed(1)}%</span>` : ''}
          ${s.c2_putting_pct != null ? `<span class="tlog-stat">C2: ${s.c2_putting_pct.toFixed(1)}%</span>` : ''}
          ${s.fairway_hit_pct != null ? `<span class="tlog-stat">FWY: ${s.fairway_hit_pct.toFixed(1)}%</span>` : ''}
          ${s.c1_in_reg_pct != null ? `<span class="tlog-stat">C1iR: ${s.c1_in_reg_pct.toFixed(1)}%</span>` : ''}
        </div>
      `;
    }

    return `
      <div class="tlog-card">
        <div class="tlog-header">
          <div class="tlog-header-left">
            <div class="tlog-tournament-name">${t.name}</div>
            <div class="tlog-tournament-meta">
              ${tierBadge} ${statusBadge}
              <span style="color:var(--text-muted);font-size:0.75rem;">
                📍 ${t.location || 'TBD'} · ${formatDateRange(t.start_date, t.end_date)}
              </span>
            </div>
          </div>
          <div class="tlog-header-right">
            ${td.finishPosition ? `<div class="tlog-finish">${ordinal(td.finishPosition)}</div>` : ''}
            <div class="tlog-total-fpts ${td.fantasyPts >= 0 ? 'positive' : 'negative'}">${td.fantasyPts > 0 ? '+' : ''}${td.fantasyPts.toFixed(1)} fpts</div>
            <div class="tlog-raw-score">Raw: ${scoreDisplay(td.rawScore)}</div>
          </div>
        </div>
        <div class="tlog-rounds">
          <div class="tlog-round-row tlog-round-header">
            <span class="tlog-round-label">Rd</span>
            <span class="tlog-round-score">Score</span>
            <span class="tlog-lead-badge">Card</span>
            <span class="tlog-round-eagles">Eagles</span>
            <span class="tlog-round-parked">Parked</span>
            <span class="tlog-round-fpts">Fpts</span>
          </div>
          ${roundRows}
        </div>
        ${td.podiumPts > 0 ? `<div class="tlog-bonus-row">🏆 Podium Bonus: +${td.podiumPts}</div>` : ''}
        ${statsRow}
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

// ── HELPERS ──
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
