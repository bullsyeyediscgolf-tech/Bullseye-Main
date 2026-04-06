// ============================================
// BULLSEYE - DASHBOARD
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;

  AppState.user = user;
  setupUserDisplay(user);
  setupLogout();
  setupSpoilerShield();
  await loadUserLeagues(user);
  setupCreateLeagueModal();
});

function setupUserDisplay(user) {
  const name = user.user_metadata?.display_name || user.email.split('@')[0];
  const initials = getInitials(name);
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-display-name').textContent = name;
}

function setupLogout() {
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await db.auth.signOut();
    window.location.href = '../index.html';
  });
}

function setupSpoilerShield() {
  const switchEl = document.getElementById('spoiler-switch');
  let shieldOn = AppState.spoilerShield;
  if (shieldOn) switchEl.classList.add('on');

  document.getElementById('spoiler-toggle').addEventListener('click', () => {
    shieldOn = !shieldOn;
    AppState.set('spoilerShield', shieldOn);
    switchEl.classList.toggle('on', shieldOn);
    // Re-render scores with shield state
    renderScoresWithShield();
  });
}

async function loadUserLeagues(user) {
  // Find teams this user manages
  const { data: userTeams, error } = await db
    .from('teams')
    .select(`
      *,
      leagues (*)
    `)
    .eq('manager_id', user.id);

  document.getElementById('loading-state').classList.add('hidden');

  if (error || !userTeams || userTeams.length === 0) {
    // Redirect to leagues page to create/join
    window.location.href = 'leagues.html';
    return;
  }

  // Use selected league from localStorage, or first
  const savedId = getSelectedTeamId();
  let team = savedId ? userTeams.find(t => t.id === savedId) : null;
  if (!team) {
    team = userTeams[0];
    setSelectedTeamId(team.id);
  }
  const league = team.leagues;

  AppState.currentTeam = team;
  AppState.currentLeague = league;

  // Check if commissioner
  if (league.commissioner_id === user.id) {
    document.getElementById('user-role').textContent = 'Commissioner';
    document.getElementById('commissioner-only').style.display = '';
  } else {
    document.getElementById('commissioner-only').style.display = 'none';
  }

  document.getElementById('league-name-display').textContent = league.name;
  document.getElementById('dashboard-content').classList.remove('hidden');

  // Show invite code for commissioner
  if (league.commissioner_id === user.id) {
    const selector = document.getElementById('league-selector');
    selector.innerHTML += `
      <div style="margin-top:6px;display:flex;align-items:center;gap:6px;">
        <span style="font-size:0.62rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:1px;">Invite Code</span>
        <span id="invite-code-display" style="font-family:var(--font-mono);font-size:0.78rem;color:var(--accent);letter-spacing:2px;cursor:pointer;" title="Click to copy" onclick="copyInviteCode('${league.invite_code}')">${league.invite_code}</span>
        <button onclick="copyInviteCode('${league.invite_code}')" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:0.7rem;padding:1px 4px;" title="Copy invite code">📋</button>
      </div>
    `;
  }

  // Load all dashboard data in parallel
  await Promise.all([
    loadStandings(league.id, team.id),
    loadNextTournament(team.id, league.id),
    loadSchedulePreview(),
    loadActivityFeed(league.id),
    loadTeamStats(team),
    loadMyRoster(team),
  ]);

  // Subscribe to realtime updates
  subscribeToLiveUpdates(league.id);
}

async function loadTeamStats(team) {
  // FAAB and roster size
  document.getElementById('stat-faab').textContent = `$${team.faab_balance}`;

  const { data: roster } = await db
    .from('rosters')
    .select('id')
    .eq('team_id', team.id)
    .eq('is_active', true);

  document.getElementById('stat-roster').textContent = `${roster?.length || 0} / ${team.leagues?.settings?.team_size || 7}`;

  // Season points
  const { data: fantasyScores } = await db
    .from('fantasy_scores')
    .select('league_points')
    .eq('team_id', team.id)
    .eq('finalized', true);

  const totalPts = fantasyScores?.reduce((sum, s) => sum + (s.league_points || 0), 0) || 0;
  document.getElementById('stat-season-pts').textContent = totalPts > 0 ? `+${totalPts}` : totalPts;
}

async function loadMyRoster(team) {
  const container = document.getElementById('my-roster-list');

  const { data: roster } = await db
    .from('rosters')
    .select('*, players(name, pdga_rating, position)')
    .eq('team_id', team.id)
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (!roster?.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:20px;">
        <div style="font-size:1.5rem;margin-bottom:8px;">👥</div>
        <div style="font-size:0.85rem;color:var(--text-muted);">No players on your roster yet.</div>
        <a href="players.html" style="font-size:0.8rem;color:var(--accent);margin-top:6px;display:inline-block;">Browse Player Pool →</a>
      </div>
    `;
    return;
  }

  const html = roster.map(r => {
    const p = r.players;
    const posLabel = p?.position || '—';
    const posClass = (p?.position || '').toLowerCase();
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-subtle);">
        <div class="user-avatar" style="width:32px;height:32px;font-size:0.65rem;flex-shrink:0;background:var(--bg-card-hover);color:var(--text-primary);display:flex;align-items:center;justify-content:center;border-radius:50%;">
          ${getInitials(p?.name || '??')}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p?.name || 'Unknown'}</div>
          <div style="font-size:0.72rem;color:var(--text-muted);">${p?.pdga_rating || '—'} rating</div>
        </div>
        <span class="pos-badge pos-${posClass}" style="font-size:0.6rem;">${posLabel === 'approacher' ? 'APP' : posLabel.toUpperCase().slice(0, 3)}</span>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

async function loadStandings(leagueId, myTeamId) {
  const { data: teams } = await db
    .from('teams')
    .select('id, name, manager_id')
    .eq('league_id', leagueId);

  if (!teams) return;

  // Get season points for each team
  const { data: scores } = await db
    .from('fantasy_scores')
    .select('team_id, league_points')
    .eq('finalized', true)
    .in('team_id', teams.map(t => t.id));

  const teamPoints = {};
  (scores || []).forEach(s => {
    teamPoints[s.team_id] = (teamPoints[s.team_id] || 0) + s.league_points;
  });

  const sorted = teams.sort((a, b) => (teamPoints[b.id] || 0) - (teamPoints[a.id] || 0));

  // Find my rank
  const myRank = sorted.findIndex(t => t.id === myTeamId) + 1;
  document.getElementById('stat-rank').textContent = `#${myRank}`;

  const html = sorted.map((team, i) => {
    const pts = teamPoints[team.id] || 0;
    const isMe = team.id === myTeamId;
    const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    return `
      <div class="standings-row" style="${isMe ? 'background:var(--accent-dim);border-radius:6px;padding:10px 8px;margin:0 -8px;' : ''}">
        <span class="standings-rank ${rankClass}">${i + 1}</span>
        <div>
          <div style="font-weight:600;font-size:0.875rem;">${team.name}${isMe ? ' <span style="color:var(--accent);font-size:0.7rem;">(YOU)</span>' : ''}</div>
        </div>
        <span class="standings-pts">${pts > 0 ? '+' : ''}${pts}</span>
      </div>
    `;
  }).join('');

  document.getElementById('standings-list').innerHTML = html;
}

async function loadNextTournament(teamId, leagueId) {
  const today = new Date().toISOString().split('T')[0];

  // Get next upcoming or active tournament
  const { data: tournaments } = await db
    .from('tournaments')
    .select('*')
    .in('status', ['upcoming', 'active'])
    .gte('start_date', today)
    .order('start_date', { ascending: true })
    .limit(1);

  const tournament = tournaments?.[0];
  if (!tournament) {
    document.getElementById('next-tournament-card').innerHTML = `
      <div class="next-tournament-label">Season</div>
      <div class="next-tournament-name">No Upcoming Tournaments</div>
    `;
    return;
  }

  document.getElementById('next-tournament-name').textContent = tournament.name;
  document.getElementById('next-tournament-date').textContent =
    `${formatDateRange(tournament.start_date, tournament.end_date)} · ${tournament.location || ''}`;

  // Load current lineup for this tournament
  await loadLineupPreview(teamId, tournament.id);

  // If active, show live scores card
  if (tournament.status === 'active') {
    document.getElementById('live-scores-card').classList.remove('hidden');
    await loadLiveScores(teamId, tournament.id);
  }
}

async function loadLineupPreview(teamId, tournamentId) {
  // Read positions from league settings (fall back to defaults)
  const league = AppState.currentLeague;
  const scoring = league?.settings?.scoring || {};
  const positions = scoring.positions?.length
    ? scoring.positions
    : ['putter', 'driver', 'approacher', 'flex', 'flex'];

  const { data: lineup } = await db
    .from('lineups')
    .select(`
      position, player_id,
      players (name)
    `)
    .eq('team_id', teamId)
    .eq('tournament_id', tournamentId);

  const lineupMap = {};
  (lineup || []).forEach(l => {
    if (!lineupMap[l.position]) lineupMap[l.position] = [];
    lineupMap[l.position].push(l.players?.name || 'Unknown');
  });

  // Track flex index for multiple flex slots
  let flexIdx = 0;
  const slotsHtml = positions.map((pos) => {
    const players = lineupMap[pos] || [];
    let player;
    if (pos === 'flex') {
      player = players[flexIdx] || null;
      flexIdx++;
    } else {
      player = players[0] || null;
    }

    return `
      <div class="lineup-slot ${player ? 'filled' : ''}">
        <span class="lineup-slot-pos">
          <span class="pos-badge pos-${pos}">${pos === 'approacher' ? 'APP' : pos.toUpperCase().slice(0, 3)}</span>
        </span>
        ${player
          ? `<span class="lineup-slot-name">${player}</span>`
          : `<span class="lineup-slot-empty">Empty slot — tap to set</span>`}
      </div>
    `;
  }).join('');

  document.getElementById('lineup-preview').innerHTML = slotsHtml;
}

async function loadLiveScores(teamId, tournamentId) {
  const { data: lineup } = await db
    .from('lineups')
    .select('player_id, position, players(name)')
    .eq('team_id', teamId)
    .eq('tournament_id', tournamentId);

  if (!lineup?.length) return;

  const playerIds = lineup.map(l => l.player_id);

  const { data: scores } = await db
    .from('player_scores')
    .select('*')
    .eq('tournament_id', tournamentId)
    .in('player_id', playerIds)
    .order('round', { ascending: true });

  // Group scores by player
  const playerScores = {};
  (scores || []).forEach(s => {
    if (!playerScores[s.player_id]) playerScores[s.player_id] = [];
    playerScores[s.player_id].push(s);
  });

  const shieldOn = AppState.spoilerShield;

  const html = lineup.map(l => {
    const rounds = playerScores[l.player_id] || [];
    const totalRaw = rounds.reduce((sum, r) => sum + Math.min(r.score_relative_par || 0, 10), 0);
    const display = rounds.length ? scoreDisplay(totalRaw) : '—';

    return `
      <div class="player-card">
        <div class="player-avatar">${getInitials(l.players?.name)}</div>
        <div class="player-info">
          <div class="player-name">${l.players?.name || '—'}</div>
          <div class="player-meta">R${rounds.length} complete</div>
        </div>
        <span class="pos-badge pos-${l.position}">${l.position === 'approacher' ? 'APP' : l.position.toUpperCase().slice(0,3)}</span>
        <span class="player-score ${totalRaw <= 0 ? 'positive' : 'negative'} ${shieldOn ? 'spoiler-shield' : ''}" data-spoiler>
          ${display}
        </span>
      </div>
    `;
  }).join('');

  document.getElementById('live-scores-content').innerHTML = html;
  if (shieldOn) applySpoilerShields();
}

async function loadSchedulePreview() {
  const today = new Date().toISOString().split('T')[0];

  const { data: tournaments } = await db
    .from('tournaments')
    .select('*')
    .gte('end_date', today)
    .order('start_date', { ascending: true })
    .limit(4);

  if (!tournaments?.length) {
    document.getElementById('schedule-preview').innerHTML =
      '<div class="text-sm text-muted" style="padding:8px 0;">No upcoming tournaments</div>';
    return;
  }

  const html = tournaments.map(t => {
    const statusBadge = t.status === 'active'
      ? '<span class="badge badge-live">LIVE</span>'
      : t.tier === 'Major' || t.tier === 'Champions Cup'
        ? '<span class="badge badge-major">MAJOR</span>'
        : '<span class="badge badge-es">ES</span>';

    const d = new Date(t.start_date);
    return `
      <div class="tournament-card">
        <div class="tournament-dates">
          <div class="tournament-month">${d.toLocaleDateString('en-US',{month:'short'})}</div>
          <div class="tournament-day">${d.getDate()}</div>
        </div>
        <div class="tournament-info">
          <div class="tournament-name">${t.name}</div>
          <div class="tournament-location">${t.location || '—'}</div>
        </div>
        ${statusBadge}
      </div>
    `;
  }).join('');

  document.getElementById('schedule-preview').innerHTML = html;
}

async function loadActivityFeed(leagueId) {
  // Load recent trades
  const { data: trades } = await db
    .from('trades')
    .select(`
      *,
      proposing_team:teams!proposing_team_id(name),
      receiving_team:teams!receiving_team_id(name)
    `)
    .eq('league_id', leagueId)
    .in('status', ['accepted', 'pending'])
    .order('created_at', { ascending: false })
    .limit(5);

  if (!trades?.length) return;

  const html = trades.map(trade => {
    const statusColor = trade.status === 'accepted' ? 'var(--green)' : 'var(--accent)';
    const label = trade.status === 'accepted' ? '🔄 Trade accepted' : '📤 Trade proposed';
    return `
      <div class="activity-item">
        <div style="flex:1;">
          <span>${label}: </span>
          <strong>${trade.proposing_team?.name}</strong>
          <span> ↔ </span>
          <strong>${trade.receiving_team?.name}</strong>
        </div>
        <span class="activity-time">${formatDate(trade.created_at)}</span>
      </div>
    `;
  }).join('');

  document.getElementById('activity-feed').innerHTML = html;

  // Badge for pending trades involving my team
  const myTeamId = AppState.currentTeam?.id;
  const pendingCount = trades.filter(t =>
    t.status === 'pending' && t.receiving_team_id === myTeamId
  ).length;

  if (pendingCount > 0) {
    const badge = document.getElementById('trade-badge');
    badge.textContent = pendingCount;
    badge.classList.remove('hidden');
  }
}

function subscribeToLiveUpdates(leagueId) {
  // Subscribe to player_scores for live updates
  db.channel('live-scores')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'player_scores'
    }, payload => {
      // Refresh live scores on any update
      if (AppState.currentTeam) {
        const tournamentId = payload.new?.tournament_id;
        if (tournamentId) {
          loadLiveScores(AppState.currentTeam.id, tournamentId);
        }
      }
    })
    .subscribe();

  // Subscribe to trades for badge updates
  db.channel('trades-watch')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'trades',
      filter: `league_id=eq.${leagueId}`
    }, () => {
      loadActivityFeed(leagueId);
    })
    .subscribe();
}

function renderScoresWithShield() {
  // Re-apply shield state to all spoiler elements
  const shieldOn = AppState.spoilerShield;
  document.querySelectorAll('[data-spoiler]').forEach(el => {
    el.classList.toggle('spoiler-shield', shieldOn);
    if (shieldOn) el.classList.remove('revealed');
  });
}

// ============================================
// CREATE LEAGUE MODAL
// ============================================
function copyInviteCode(code) {
  navigator.clipboard.writeText(code).then(() => {
    showToast(`Invite code copied: ${code}`, 'success');
  }).catch(() => {
    showToast(`Invite code: ${code}`, 'info', 6000);
  });
}
function setupCreateLeagueModal() {
  const modal = document.getElementById('create-league-modal');
  const createBtn = document.getElementById('create-league-btn');
  const enterCodeBtn = document.getElementById('enter-code-btn');
  const closeBtn = document.getElementById('close-create-modal');
  const submitBtn = document.getElementById('create-league-submit');
  const errorEl = document.getElementById('create-league-error');

  if (createBtn) createBtn.addEventListener('click', () => modal.classList.remove('hidden'));
  if (enterCodeBtn) enterCodeBtn.addEventListener('click', () => {
    window.location.href = '../index.html';
  });
  if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));

  modal.addEventListener('click', e => {
    if (e.target === modal) modal.classList.add('hidden');
  });

  submitBtn.addEventListener('click', async () => {
    const leagueName = document.getElementById('new-league-name').value.trim();
    const teamName = document.getElementById('new-team-name').value.trim();

    if (!leagueName || !teamName) {
      errorEl.textContent = 'Please fill in all fields.';
      errorEl.classList.remove('hidden');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';
    errorEl.classList.add('hidden');

    // Create league
    const { data: league, error: leagueErr } = await db
      .from('leagues')
      .insert({
        name: leagueName,
        commissioner_id: AppState.user.id,
        season: 2026
      })
      .select()
      .single();

    if (leagueErr) {
      errorEl.textContent = leagueErr.message;
      errorEl.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create League & Get Invite Code';
      return;
    }

    // Create team for commissioner
    await db.from('teams').insert({
      league_id: league.id,
      manager_id: AppState.user.id,
      name: teamName,
      faab_balance: 100,
      draft_position: 1
    });

    showToast(`League created! Invite code: ${league.invite_code}`, 'success', 8000);
    modal.classList.add('hidden');

    // Reload
    window.location.reload();
  });
}
