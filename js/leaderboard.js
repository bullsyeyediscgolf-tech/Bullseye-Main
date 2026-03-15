// ============================================
// BULLSEYE - LEADERBOARD & SCORING ENGINE
// ============================================

let lbState = {
  user: null,
  league: null,
  myTeam: null,
  teams: [],
  tournaments: [],
  currentTournament: null,
  allScores: {},      // player_id -> [round scores]
  allStats: {},       // player_id -> stats
  allLineups: {},     // team_id -> [lineup entries]
  fantasyScores: [],  // computed per team
  isCommissioner: false,
  spoilerOn: AppState.spoilerShield,
  revealed: false,
};

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;

  lbState.user = user;
  const name = user.user_metadata?.display_name || user.email.split('@')[0];
  document.getElementById('user-avatar').textContent = getInitials(name);
  document.getElementById('user-display-name').textContent = name;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await db.auth.signOut(); window.location.href = '../index.html';
  });

  setupSpoilerToggle();
  await loadLeaderboard(user);
});

// ── SPOILER SHIELD ──
function setupSpoilerToggle() {
  const sw = document.getElementById('spoiler-switch');
  if (lbState.spoilerOn) sw.classList.add('on');

  document.getElementById('spoiler-toggle-btn').addEventListener('click', () => {
    lbState.spoilerOn = !lbState.spoilerOn;
    lbState.revealed = false;
    AppState.set('spoilerShield', lbState.spoilerOn);
    sw.classList.toggle('on', lbState.spoilerOn);
    updateSpoilerState();
  });
}

function updateSpoilerState() {
  const overlay = document.getElementById('spoiler-overlay');
  if (lbState.spoilerOn && !lbState.revealed) {
    overlay.classList.remove('hidden');
  } else {
    overlay.classList.add('hidden');
  }
}

function revealScores() {
  lbState.revealed = true;
  document.getElementById('spoiler-overlay').classList.add('hidden');
}

// ── MAIN LOADER ──
async function loadLeaderboard(user) {
  const { data: teams } = await db
    .from('teams').select('*, leagues(*)')
    .eq('manager_id', user.id);

  if (!teams?.length) { window.location.href = 'dashboard.html'; return; }

  lbState.myTeam = teams[0];
  lbState.league = teams[0].leagues;
  lbState.isCommissioner = lbState.league.commissioner_id === user.id;

  document.getElementById('league-name-display').textContent = lbState.league.name;
  document.getElementById('user-role').textContent = lbState.isCommissioner ? 'Commissioner' : 'Manager';

  // Load all teams
  const { data: allTeams } = await db
    .from('teams').select('*')
    .eq('league_id', lbState.league.id)
    .order('draft_position', { ascending: true });
  lbState.teams = allTeams || [];

  // Load tournaments (active + completed)
  const { data: tournaments } = await db
    .from('tournaments').select('*')
    .in('status', ['active', 'completed'])
    .eq('season', 2026)
    .order('start_date', { ascending: false });

  lbState.tournaments = tournaments || [];
  document.getElementById('loading-state').classList.add('hidden');

  if (!lbState.tournaments.length) {
    document.getElementById('no-tournament').classList.remove('hidden');
    return;
  }

  document.getElementById('leaderboard-content').classList.remove('hidden');
  buildTournamentTabs();
  await selectTournament(lbState.tournaments[0]);

  // Commissioner toolbar
  if (lbState.isCommissioner) {
    const actions = document.getElementById('topbar-actions');
    actions.innerHTML = `
      <button class="btn-accent btn-sm" onclick="openScoreModal()">📊 Enter Scores</button>
      <button class="btn-secondary btn-sm" onclick="openStatsModal()">📈 Enter Stats</button>
      <button class="btn-secondary btn-sm" onclick="finalizeScores()">✓ Finalize</button>
    ` + actions.innerHTML;
  }

  subscribeToUpdates();
}

function buildTournamentTabs() {
  const tabs = document.getElementById('tournament-tabs');
  lbState.tournaments.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.className = i === 0 ? 'btn-accent btn-sm' : 'btn-secondary btn-sm';
    btn.textContent = t.name;
    btn.onclick = async () => {
      document.querySelectorAll('#tournament-tabs button').forEach(b => {
        b.className = 'btn-secondary btn-sm';
      });
      btn.className = 'btn-accent btn-sm';
      await selectTournament(t);
    };
    tabs.appendChild(btn);
  });
}

async function selectTournament(tournament) {
  lbState.currentTournament = tournament;
  lbState.revealed = false;

  // Update hero
  document.getElementById('hero-name').textContent = tournament.name;
  document.getElementById('hero-meta').innerHTML = `
    <span>📍 ${tournament.location || 'TBD'}</span>
    <span>📅 ${formatDateRange(tournament.start_date, tournament.end_date)}</span>
    <span>${tournament.status === 'active'
      ? '<span class="badge badge-live">LIVE</span>'
      : '<span class="badge badge-completed">FINAL</span>'}</span>
  `;

  await loadTournamentData(tournament);
  computeFantasyScores();
  renderLeaderboard();
  renderScoringPanel();
  updateSpoilerState();
  document.getElementById('last-updated').textContent = `Updated: ${new Date().toLocaleTimeString()}`;
}

// ── LOAD DATA ──
async function loadTournamentData(tournament) {
  const teamIds = lbState.teams.map(t => t.id);

  // All lineups for this tournament
  const { data: lineups } = await db
    .from('lineups').select('*, players(*)')
    .eq('tournament_id', tournament.id)
    .in('team_id', teamIds);

  lbState.allLineups = {};
  (lineups || []).forEach(l => {
    if (!lbState.allLineups[l.team_id]) lbState.allLineups[l.team_id] = [];
    lbState.allLineups[l.team_id].push(l);
  });

  // All player scores for this tournament
  const playerIds = [...new Set((lineups || []).map(l => l.player_id))];
  lbState.allScores = {};
  lbState.allStats = {};

  if (playerIds.length) {
    const { data: scores } = await db
      .from('player_scores').select('*')
      .eq('tournament_id', tournament.id)
      .in('player_id', playerIds);

    (scores || []).forEach(s => {
      if (!lbState.allScores[s.player_id]) lbState.allScores[s.player_id] = [];
      lbState.allScores[s.player_id].push(s);
    });

    const { data: stats } = await db
      .from('player_stats').select('*')
      .eq('tournament_id', tournament.id)
      .in('player_id', playerIds);

    (stats || []).forEach(s => { lbState.allStats[s.player_id] = s; });
  }
}

// ── SCORING ENGINE ──
function computeFantasyScores() {
  const cfg = lbState.league.settings?.scoring || {};
  const leadMult = cfg.lead_card_multiplier || 1.5;
  const podiumBonus = cfg.podium_bonus || [15, 8, 3];
  const eagleBonus = cfg.eagle_bonus ?? 1;
  const parkedBonus = cfg.parked_bonus ?? 1;
  const posBest = cfg.position_best_bonus ?? 7;
  const posSecond = cfg.position_second_bonus ?? 3;

  // Step 1: compute raw fantasy pts per player per lineup slot
  const teamScores = lbState.teams.map(team => {
    const lineup = lbState.allLineups[team.id] || [];
    let totalRaw = 0;
    let totalPts = 0;
    const playerBreakdowns = [];

    lineup.forEach(slot => {
      const rounds = lbState.allScores[slot.player_id] || [];
      let playerRaw = 0;
      let playerPts = 0;
      const roundDetails = [];

      rounds.sort((a, b) => a.round - b.round).forEach(r => {
        const raw = r.score_relative_par || 0;
        const isLead = r.is_lead_card && r.round > 1;
        const roundScore = isLead ? raw * leadMult : raw;
        roundDetails.push({ round: r.round, raw, roundScore, isLead });
        playerPts += roundScore;
        playerRaw += raw;
      });

      // Eagle + parked bonuses
      const totalEagles = rounds.reduce((s, r) => s + (r.eagles || 0), 0);
      const totalParked = rounds.reduce((s, r) => s + (r.parked_holes || 0), 0);
      const bonuses = totalEagles * eagleBonus + totalParked * parkedBonus;

      // Podium bonus (on final round)
      const finalRound = rounds.find(r => r.finish_position != null);
      let podiumPts = 0;
      if (finalRound?.finish_position === 1) podiumPts = podiumBonus[0];
      else if (finalRound?.finish_position === 2) podiumPts = podiumBonus[1];
      else if (finalRound?.finish_position === 3) podiumPts = podiumBonus[2];

      const slotTotal = playerPts + bonuses + podiumPts;
      totalPts += slotTotal;
      totalRaw += playerRaw;

      playerBreakdowns.push({
        player: slot.players,
        position: slot.position,
        player_id: slot.player_id,
        roundDetails,
        rawScore: playerRaw,
        fantasyPts: slotTotal,
        bonuses: bonuses + podiumPts,
        isOnLeadCard: rounds.some(r => r.is_lead_card),
      });
    });

    return {
      team,
      totalPts: Math.round(totalPts * 10) / 10,
      totalRaw,
      playerBreakdowns,
      leaguePts: 0, // filled in after ranking
    };
  });

  // Step 2: position stat bonuses
  // For each position type, find best + second best stat across all lineups
  ['putter', 'driver', 'approacher'].forEach(pos => {
    const entries = [];
    teamScores.forEach(ts => {
      const slot = ts.playerBreakdowns.find(p => p.position === pos);
      if (!slot) return;
      const stats = lbState.allStats[slot.player_id];
      const statVal = SCORING.getPositionStat(stats, pos);
      entries.push({ ts, slot, statVal });
    });
    entries.sort((a, b) => b.statVal - a.statVal);
    if (entries[0]) { entries[0].ts.totalPts += posBest; entries[0].slot.bonuses += posBest; entries[0].slot.posBonusLabel = `+${posBest} ${pos} best`; }
    if (entries[1]) { entries[1].ts.totalPts += posSecond; entries[1].slot.bonuses += posSecond; entries[1].slot.posBonusLabel = `+${posSecond} ${pos} 2nd`; }
  });

  // Step 3: rank teams, assign league points
  teamScores.sort((a, b) => {
    if (b.totalPts !== a.totalPts) return b.totalPts - a.totalPts;
    return a.totalRaw - b.totalRaw; // tiebreaker: raw score (fewer strokes better)
  });

  teamScores.forEach((ts, i) => {
    ts.rank = i + 1;
    ts.leaguePts = SCORING.calcLeaguePoints(i + 1);
  });

  lbState.fantasyScores = teamScores;
}

// ── RENDER LEADERBOARD ──
function renderLeaderboard() {
  const tbody = document.getElementById('lb-body');
  const rows = [];

  lbState.fantasyScores.forEach((ts, i) => {
    const isMe = ts.team.id === lbState.myTeam.id;
    const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const ptsClass = ts.totalPts >= 0 ? 'positive' : 'negative';
    const lPts = ts.leaguePts;
    const lPtsStr = lPts > 0 ? `+${lPts}` : `${lPts}`;
    const rowId = `lb-row-${ts.team.id}`;
    const bdId = `lb-bd-${ts.team.id}`;
    const hasData = ts.playerBreakdowns.some(p => p.roundDetails.length > 0);

    rows.push(`
      <tr class="lb-row ${isMe ? 'my-team' : ''}" id="${rowId}"
          onclick="toggleBreakdown('${ts.team.id}')">
        <td><div class="lb-rank ${rankClass}">${ts.rank}</div></td>
        <td>
          <div class="lb-team-name">${ts.team.name}${isMe ? ' <span style="color:var(--accent);font-size:0.7rem;">(YOU)</span>' : ''}</div>
        </td>
        <td><div class="lb-pts ${ptsClass}">${hasData ? ts.totalPts.toFixed(1) : '—'}</div></td>
        <td><div class="lb-raw">${hasData ? scoreDisplay(ts.totalRaw) : '—'}</div></td>
        <td><div class="lb-league-pts" style="color:${lPts>0?'var(--green)':lPts<0?'var(--red)':'var(--text-muted)'}">${hasData ? lPtsStr : '—'}</div></td>
        <td><div class="lb-move">▼</div></td>
      </tr>
      <tr class="lb-breakdown" id="${bdId}">
        <td colspan="6">
          <div class="breakdown-inner" id="bd-inner-${ts.team.id}"></div>
        </td>
      </tr>
    `);
  });

  tbody.innerHTML = rows.join('');
}

function toggleBreakdown(teamId) {
  const row = document.getElementById(`lb-row-${teamId}`);
  const bd = document.getElementById(`lb-bd-${teamId}`);
  const isOpen = bd.classList.contains('open');

  // Close all
  document.querySelectorAll('.lb-breakdown.open').forEach(el => el.classList.remove('open'));
  document.querySelectorAll('.lb-row.expanded').forEach(el => el.classList.remove('expanded'));

  if (!isOpen) {
    bd.classList.add('open');
    row.classList.add('expanded');
    renderBreakdown(teamId);
  }
}

function renderBreakdown(teamId) {
  const ts = lbState.fantasyScores.find(s => s.team.id === teamId);
  if (!ts) return;
  const inner = document.getElementById(`bd-inner-${teamId}`);

  if (!ts.playerBreakdowns.length) {
    inner.innerHTML = '<div class="breakdown-title">No lineup set for this tournament</div>';
    return;
  }

  inner.innerHTML = `
    <div class="breakdown-title">Player Breakdown · ${ts.team.name}</div>
    <div class="breakdown-players">
      ${ts.playerBreakdowns.map(bp => {
        const roundsHtml = [1,2,3,4].map(r => {
          const rd = bp.roundDetails.find(d => d.round === r);
          if (!rd) return `<span class="bp-round">R${r}: —</span>`;
          const cls = rd.raw < 0 ? 'under' : rd.isLead ? 'lead' : '';
          return `<span class="bp-round ${cls}" title="${rd.isLead ? 'Lead card ×1.5' : ''}">
            R${r}: ${scoreDisplay(rd.raw)}${rd.isLead ? '✦' : ''}
          </span>`;
        }).join('');

        const posLabel = bp.position === 'approacher' ? 'APP' : bp.position.toUpperCase().slice(0,3);
        const posCls = `pos-${bp.position === 'flex' ? 'flex' : bp.position}`;

        return `
          <div class="breakdown-player ${bp.isOnLeadCard ? 'lead-card' : ''}">
            <span class="pos-badge ${posCls}">${posLabel}</span>
            <div class="player-avatar" style="width:28px;height:28px;font-size:0.6rem;flex-shrink:0;">${getInitials(bp.player?.name)}</div>
            <span class="bp-name">${bp.player?.name || '—'}</span>
            <div class="bp-rounds">${roundsHtml}</div>
            ${bp.bonuses ? `<span class="bp-bonuses">+${bp.bonuses.toFixed(1)} bonus</span>` : ''}
            ${bp.posBonusLabel ? `<span class="bp-bonuses" style="color:var(--purple);">${bp.posBonusLabel}</span>` : ''}
            <span class="bp-total ${bp.fantasyPts >= 0 ? 'positive' : 'negative'}">${bp.roundDetails.length ? bp.fantasyPts.toFixed(1) : '—'}</span>
          </div>
        `;
      }).join('')}
    </div>
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-subtle);display:flex;justify-content:space-between;font-size:0.82rem;">
      <span style="color:var(--text-muted);">Total Fantasy Points</span>
      <span style="font-family:var(--font-mono);font-weight:700;color:${ts.totalPts>=0?'var(--green)':'var(--red)'};">${ts.totalPts.toFixed(1)}</span>
    </div>
  `;
}

// ── SCORING PANEL (right sidebar) ──
function renderScoringPanel() {
  const panel = document.getElementById('scoring-panel');

  // My team card
  const myScore = lbState.fantasyScores.find(s => s.team.id === lbState.myTeam.id);
  let myTeamHtml = '';
  if (myScore) {
    myTeamHtml = `
      <div class="player-score-card">
        <div class="psc-header">
          <div class="psc-title">My Team</div>
          <span style="font-family:var(--font-mono);font-weight:700;color:${myScore.totalPts>=0?'var(--green)':'var(--red)'};">${myScore.totalPts.toFixed(1)} pts</span>
        </div>
        <div class="psc-body">
          ${myScore.playerBreakdowns.map(bp => {
            const total = bp.roundDetails.reduce((s,r) => s + r.roundScore, 0) + bp.bonuses;
            const hasData = bp.roundDetails.length > 0;
            return `
              <div class="psc-player">
                <span class="psc-finish">
                  <span class="pos-badge pos-${bp.position === 'flex' ? 'flex' : bp.position}" style="width:auto;padding:1px 4px;font-size:0.58rem;">
                    ${bp.position === 'approacher' ? 'APP' : bp.position.toUpperCase().slice(0,3)}
                  </span>
                </span>
                <div class="player-avatar" style="width:26px;height:26px;font-size:0.6rem;flex-shrink:0;">${getInitials(bp.player?.name)}</div>
                <div style="flex:1;min-width:0;">
                  <div style="font-size:0.78rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${bp.player?.name || '—'}</div>
                </div>
                <span class="psc-score ${bp.rawScore < 0 ? 'positive' : bp.rawScore > 0 ? 'negative' : ''}">
                  ${hasData ? scoreDisplay(bp.rawScore) : '—'}
                </span>
                <span class="psc-pts">${hasData ? '+' + total.toFixed(1) : '—'}</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // Scoring reference card
  const refHtml = `
    <div class="player-score-card">
      <div class="psc-header"><div class="psc-title">Scoring Rules</div></div>
      <div style="padding:12px 14px;display:flex;flex-direction:column;gap:6px;font-size:0.78rem;color:var(--text-secondary);">
        <div style="display:flex;justify-content:space-between;"><span>1 stroke under par</span><span style="color:var(--accent);font-family:var(--font-mono);">+1 pt</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Lead card (Rd 2+)</span><span style="color:var(--accent);font-family:var(--font-mono);">×1.5</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Eagle</span><span style="color:var(--accent);font-family:var(--font-mono);">+1 bonus</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Parked hole</span><span style="color:var(--accent);font-family:var(--font-mono);">+1 bonus</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Tournament 1st</span><span style="color:var(--accent);font-family:var(--font-mono);">+15 bonus</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Tournament 2nd</span><span style="color:var(--accent);font-family:var(--font-mono);">+8 bonus</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Tournament 3rd</span><span style="color:var(--accent);font-family:var(--font-mono);">+3 bonus</span></div>
        <div style="height:1px;background:var(--border);margin:4px 0;"></div>
        <div style="display:flex;justify-content:space-between;"><span>Best putter stats</span><span style="color:var(--purple);font-family:var(--font-mono);">+7 bonus</span></div>
        <div style="display:flex;justify-content:space-between;"><span>2nd putter stats</span><span style="color:var(--purple);font-family:var(--font-mono);">+3 bonus</span></div>
        <div style="display:flex;justify-content:space-between;"><span>(same for driver, approacher)</span><span></span></div>
        <div style="height:1px;background:var(--border);margin:4px 0;"></div>
        <div style="color:var(--text-muted);font-size:0.72rem;">League: 1st=4pts, 2nd=2pts, 3rd=1pt, 4th=0, 5th=-1…</div>
      </div>
    </div>
  `;

  panel.innerHTML = myTeamHtml + refHtml;
}

// ── REALTIME ──
function subscribeToUpdates() {
  db.channel('lb-scores')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'player_scores' }, async () => {
      if (lbState.currentTournament) {
        await loadTournamentData(lbState.currentTournament);
        computeFantasyScores();
        renderLeaderboard();
        renderScoringPanel();
        document.getElementById('last-updated').textContent = `Updated: ${new Date().toLocaleTimeString()}`;
        showToast('Scores updated!', 'info', 2000);
      }
    })
    .subscribe();
}

// ── COMMISSIONER: SCORE ENTRY ──
function openScoreModal() {
  const modal = document.getElementById('score-modal');
  modal.classList.remove('hidden');
  buildScoreEntryRows();
}

function buildScoreEntryRows() {
  const t = lbState.currentTournament;
  if (!t) return;

  // Collect all unique players across all lineups
  const playerMap = {};
  Object.values(lbState.allLineups).forEach(slots => {
    slots.forEach(s => {
      if (s.player_id && s.players) playerMap[s.player_id] = s.players;
    });
  });

  const players = Object.entries(playerMap).sort((a,b) =>
    (a[1].name || '').localeCompare(b[1].name || ''));

  const html = players.map(([pid, p]) => `
    <div class="score-row" data-player-id="${pid}">
      <div class="score-row-name">${p.name}</div>
      <div class="score-row-inputs">
        <input class="score-input-small" type="number" placeholder="Score" data-field="score"
               title="Strokes relative to par (e.g. -5)" style="width:68px;">
        <input class="score-input-small" type="number" placeholder="🦅" data-field="eagles"
               title="Number of eagles" style="width:54px;" min="0" value="0">
        <input class="score-input-small" type="number" placeholder="🎯" data-field="parked"
               title="Parked holes" style="width:54px;" min="0" value="0">
        <label class="lead-card-toggle" title="On lead card this round?">
          <input type="checkbox" data-field="lead_card">
          Lead
        </label>
        <div style="display:flex;flex-direction:column;gap:2px;">
          <input class="score-input-small" type="number" placeholder="Fin" data-field="finish"
                 title="Final finish position (leave blank if not final round)" style="width:54px;" min="1">
        </div>
      </div>
    </div>
  `).join('');

  document.getElementById('score-entry-rows').innerHTML = html || '<div style="color:var(--text-muted);padding:16px;">No players in any lineup yet.</div>';
}

async function loadExistingScores() {
  const round = parseInt(document.getElementById('score-round').value);
  const t = lbState.currentTournament;
  if (!t) return;

  const playerIds = Object.keys(lbState.allLineups)
    .flatMap(tid => (lbState.allLineups[tid] || []).map(s => s.player_id));

  const { data: existing } = await db
    .from('player_scores')
    .select('*')
    .eq('tournament_id', t.id)
    .eq('round', round)
    .in('player_id', [...new Set(playerIds)]);

  if (!existing?.length) { showToast('No existing scores for this round', 'info'); return; }

  existing.forEach(s => {
    const row = document.querySelector(`.score-row[data-player-id="${s.player_id}"]`);
    if (!row) return;
    row.querySelector('[data-field="score"]').value = s.score_relative_par ?? '';
    row.querySelector('[data-field="eagles"]').value = s.eagles || 0;
    row.querySelector('[data-field="parked"]').value = s.parked_holes || 0;
    row.querySelector('[data-field="lead_card"]').checked = s.is_lead_card || false;
    if (s.finish_position) row.querySelector('[data-field="finish"]').value = s.finish_position;
  });

  showToast('Loaded existing scores', 'success');
}

async function submitScores() {
  const round = parseInt(document.getElementById('score-round').value);
  const t = lbState.currentTournament;
  if (!t) return;

  const rows = document.querySelectorAll('.score-row[data-player-id]');
  const toUpsert = [];

  rows.forEach(row => {
    const pid = row.dataset.playerId;
    const scoreVal = row.querySelector('[data-field="score"]').value;
    if (scoreVal === '' || scoreVal === null) return; // skip blank rows

    toUpsert.push({
      player_id: pid,
      tournament_id: t.id,
      round,
      score_relative_par: parseInt(scoreVal),
      eagles: parseInt(row.querySelector('[data-field="eagles"]').value) || 0,
      parked_holes: parseInt(row.querySelector('[data-field="parked"]').value) || 0,
      is_lead_card: row.querySelector('[data-field="lead_card"]').checked,
      finish_position: row.querySelector('[data-field="finish"]').value
        ? parseInt(row.querySelector('[data-field="finish"]').value) : null,
      updated_at: new Date().toISOString(),
    });
  });

  if (!toUpsert.length) {
    showToast('No scores to save — fill in at least one score', 'error');
    return;
  }

  // Upsert (insert or update)
  const { error } = await db.from('player_scores').upsert(toUpsert, {
    onConflict: 'player_id,tournament_id,round'
  });

  if (error) {
    document.getElementById('score-entry-error').textContent = error.message;
    document.getElementById('score-entry-error').classList.remove('hidden');
  } else {
    showToast(`✓ ${toUpsert.length} scores saved for Round ${round}`, 'success');
    document.getElementById('score-modal').classList.add('hidden');
  }
}

// ── COMMISSIONER: STATS ENTRY ──
function openStatsModal() {
  const modal = document.getElementById('stats-modal');
  modal.classList.remove('hidden');

  const playerMap = {};
  Object.values(lbState.allLineups).forEach(slots => {
    slots.forEach(s => {
      if (s.player_id && s.players) playerMap[s.player_id] = s.players;
    });
  });

  const html = Object.entries(playerMap)
    .sort((a,b) => a[1].name.localeCompare(b[1].name))
    .map(([pid, p]) => {
      const ex = lbState.allStats[pid] || {};
      return `
        <div class="score-row" data-player-id="${pid}">
          <div class="score-row-name">${p.name}</div>
          <div class="score-row-inputs" style="flex-wrap:wrap;gap:8px;">
            <div style="display:flex;flex-direction:column;gap:2px;align-items:center;">
              <span style="font-size:0.62rem;color:var(--text-muted);">C1X%</span>
              <input class="score-input-small" type="number" step="0.1" min="0" max="100"
                     placeholder="0" data-field="c1x" value="${ex.c1x_putting_pct || ''}" style="width:60px;">
            </div>
            <div style="display:flex;flex-direction:column;gap:2px;align-items:center;">
              <span style="font-size:0.62rem;color:var(--text-muted);">C2%</span>
              <input class="score-input-small" type="number" step="0.1" min="0" max="100"
                     placeholder="0" data-field="c2" value="${ex.c2_putting_pct || ''}" style="width:60px;">
            </div>
            <div style="display:flex;flex-direction:column;gap:2px;align-items:center;">
              <span style="font-size:0.62rem;color:var(--text-muted);">FWY%</span>
              <input class="score-input-small" type="number" step="0.1" min="0" max="100"
                     placeholder="0" data-field="fairway" value="${ex.fairway_hit_pct || ''}" style="width:60px;">
            </div>
            <div style="display:flex;flex-direction:column;gap:2px;align-items:center;">
              <span style="font-size:0.62rem;color:var(--text-muted);">C1IR%</span>
              <input class="score-input-small" type="number" step="0.1" min="0" max="100"
                     placeholder="0" data-field="c1ir" value="${ex.c1_in_reg_pct || ''}" style="width:60px;">
            </div>
          </div>
        </div>
      `;
    }).join('');

  document.getElementById('stats-entry-rows').innerHTML = html;
}

async function submitStats() {
  const t = lbState.currentTournament;
  if (!t) return;

  const rows = document.querySelectorAll('#stats-entry-rows .score-row[data-player-id]');
  const toUpsert = [];

  rows.forEach(row => {
    const pid = row.dataset.playerId;
    const c1x = row.querySelector('[data-field="c1x"]').value;
    if (c1x === '') return;
    toUpsert.push({
      player_id: pid,
      tournament_id: t.id,
      c1x_putting_pct: parseFloat(c1x) || null,
      c2_putting_pct: parseFloat(row.querySelector('[data-field="c2"]').value) || null,
      fairway_hit_pct: parseFloat(row.querySelector('[data-field="fairway"]').value) || null,
      c1_in_reg_pct: parseFloat(row.querySelector('[data-field="c1ir"]').value) || null,
      updated_at: new Date().toISOString(),
    });
  });

  const { error } = await db.from('player_stats').upsert(toUpsert, {
    onConflict: 'player_id,tournament_id'
  });

  if (error) { showToast(error.message, 'error'); return; }
  showToast(`✓ Stats saved for ${toUpsert.length} players`, 'success');
  document.getElementById('stats-modal').classList.add('hidden');
}

// ── FINALIZE SCORES ──
async function finalizeScores() {
  const t = lbState.currentTournament;
  if (!t) return;
  if (!confirm(`Finalize scores for ${t.name}? This will lock results and award league points.`)) return;

  // Write fantasy_scores to DB
  const upserts = lbState.fantasyScores.map(ts => ({
    team_id: ts.team.id,
    tournament_id: t.id,
    total_points: ts.totalPts,
    raw_score: ts.totalRaw,
    league_place: ts.rank,
    league_points: ts.leaguePts,
    finalized: true,
    breakdown: ts.playerBreakdowns,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await db.from('fantasy_scores').upsert(upserts, {
    onConflict: 'team_id,tournament_id'
  });

  if (error) { showToast(error.message, 'error'); return; }

  // Mark tournament completed
  await db.from('tournaments').update({ status: 'completed' }).eq('id', t.id);

  showToast('✓ Scores finalized! League points awarded.', 'success', 5000);
}
