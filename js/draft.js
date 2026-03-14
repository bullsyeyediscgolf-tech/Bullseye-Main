// ============================================
// BULLSEYE - DRAFT ROOM
// ============================================

// ── State ──
let draftState = {
  draft: null,
  league: null,
  teams: [],           // sorted by draft_position
  myTeam: null,
  picks: [],           // all picks so far
  players: [],         // all available players
  timerInterval: null,
  timerSeconds: 120,
  currentSeconds: 120,
  isCommissioner: false,
  ratingFilter: 'all',
  searchQuery: '',
};

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAuth();
  if (!user) return;

  AppState.user = user;
  const name = user.user_metadata?.display_name || user.email.split('@')[0];
  document.getElementById('user-avatar').textContent = getInitials(name);
  document.getElementById('user-display-name').textContent = name;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await db.auth.signOut();
    window.location.href = '../index.html';
  });

  await loadDraftRoom(user);
});

// ── MAIN LOADER ──
async function loadDraftRoom(user) {
  // Get user's team
  const { data: userTeams } = await db
    .from('teams')
    .select('*, leagues(*)')
    .eq('manager_id', user.id);

  if (!userTeams?.length) {
    window.location.href = 'dashboard.html';
    return;
  }

  const myTeam = userTeams[0];
  const league = myTeam.leagues;
  draftState.myTeam = myTeam;
  draftState.league = league;
  draftState.isCommissioner = league.commissioner_id === user.id;
  draftState.timerSeconds = league.settings?.pick_timer_seconds || 120;

  document.getElementById('league-name-display').textContent = league.name;
  document.getElementById('user-role').textContent = draftState.isCommissioner ? 'Commissioner' : 'Manager';

  // Load all teams in draft order
  const { data: teams } = await db
    .from('teams')
    .select('*')
    .eq('league_id', league.id)
    .order('draft_position', { ascending: true });

  draftState.teams = teams || [];

  // Load draft record
  const { data: draft } = await db
    .from('drafts')
    .select('*')
    .eq('league_id', league.id)
    .single();

  draftState.draft = draft;

  // Load all picks
  const { data: picks } = await db
    .from('draft_picks')
    .select('*, players(*), teams(*)')
    .eq('league_id', league.id)
    .order('pick_number', { ascending: true });

  draftState.picks = picks || [];

  // Load players
  await loadPlayers();

  // Hide loading
  document.getElementById('draft-loading').classList.add('hidden');

  // Show correct state
  if (!draft || draft.status === 'pending') {
    showPendingState();
  } else if (draft.status === 'completed') {
    showCompletedState();
  } else {
    showActiveState();
  }

  // Subscribe to realtime
  subscribeToDraft(league.id);
}

// ── LOAD PLAYERS ──
async function loadPlayers() {
  const { data: players } = await db
    .from('players')
    .select('*')
    .eq('active', true)
    .order('pdga_rating', { ascending: false });

  draftState.players = players || [];
}

// ── PENDING STATE ──
function showPendingState() {
  document.getElementById('draft-pending').classList.remove('hidden');

  // Show start button for commissioner
  if (draftState.isCommissioner) {
    document.getElementById('commissioner-start-area').classList.remove('hidden');
    document.getElementById('start-draft-btn').addEventListener('click', startDraft);
  }

  // Render draft order
  renderDraftOrder();
}

function renderDraftOrder() {
  const list = document.getElementById('draft-order-list');
  const html = draftState.teams.map((team, i) => {
    const isMe = team.id === draftState.myTeam.id;
    return `
      <div class="draft-order-item" style="${isMe ? 'border-color:var(--accent);' : ''}">
        <span class="draft-order-pick">#${i + 1}</span>
        <div class="user-avatar" style="width:28px;height:28px;font-size:0.65rem;flex-shrink:0;
          background:${isMe ? 'var(--accent)' : 'var(--bg-card-hover)'};
          color:${isMe ? '#0A0C0F' : 'var(--text-primary)'};
          display:flex;align-items:center;justify-content:center;border-radius:50%;">
          ${getInitials(team.name)}
        </div>
        <span style="font-weight:${isMe ? '700' : '500'};color:${isMe ? 'var(--accent)' : 'var(--text-primary)'};">
          ${team.name}${isMe ? ' (You)' : ''}
        </span>
      </div>
    `;
  }).join('');
  list.innerHTML = html;
}

// ── START DRAFT (commissioner only) ──
async function startDraft() {
  const btn = document.getElementById('start-draft-btn');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  const { error } = await db
    .from('drafts')
    .update({
      status: 'active',
      current_pick: 1,
      started_at: new Date().toISOString()
    })
    .eq('league_id', draftState.league.id);

  if (error) {
    showToast('Failed to start draft: ' + error.message, 'error');
    btn.disabled = false;
    btn.textContent = '🚀 Start Draft';
  }
  // Realtime will trigger state change for all users
}

// ── ACTIVE STATE ──
function showActiveState() {
  document.getElementById('draft-active').classList.remove('hidden');
  renderDraftBoard();
  renderPlayerList();
  renderRecentPicks();
  updateTicker();
  startTimer();
}

// ── COMPLETED STATE ──
function showCompletedState() {
  document.getElementById('draft-completed').classList.remove('hidden');
}

// ── DRAFT BOARD ──
function renderDraftBoard() {
  const { teams, picks, draft, league } = draftState;
  const teamSize = league.settings?.team_size || 7;
  const totalPicks = teams.length * teamSize;
  const currentPick = draft?.current_pick || 1;

  // Build grid: columns = teams, rows = rounds
  const board = document.getElementById('draft-board');
  const cols = teams.length;
  board.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  // Create pick map: pickNumber -> pick
  const pickMap = {};
  picks.forEach(p => { pickMap[p.pick_number] = p; });

  // Which pick number belongs to which team (snake)
  function teamForPick(pickNum) {
    const round = Math.ceil(pickNum / cols);
    const posInRound = pickNum - (round - 1) * cols;
    const isEvenRound = round % 2 === 0;
    const teamIdx = isEvenRound ? cols - posInRound : posInRound - 1;
    return teams[teamIdx];
  }

  let html = '';

  // Headers
  teams.forEach(team => {
    const isMe = team.id === draftState.myTeam.id;
    html += `<div class="board-team-header ${isMe ? 'my-col' : ''}">${team.name}${isMe ? ' ★' : ''}</div>`;
  });

  // Cells (by round, then team column)
  for (let round = 1; round <= teamSize; round++) {
    for (let col = 0; col < cols; col++) {
      const isEvenRound = round % 2 === 0;
      const teamIdx = isEvenRound ? cols - 1 - col : col;
      const team = teams[teamIdx];
      const pickNum = (round - 1) * cols + col + 1;
      const pick = pickMap[pickNum];
      const isMe = team.id === draftState.myTeam.id;
      const isOnClock = pickNum === currentPick;
      const isMyTurn = isOnClock && isMe;

      let cellClass = 'board-cell';
      if (isMe) cellClass += ' my-col';
      if (isOnClock) cellClass += ' on-clock-cell current-pick';

      let cellContent = `<span class="pick-number-label">${pickNum}</span>`;
      if (pick) {
        cellContent = `
          <div class="pick-chip">
            <div class="pick-chip-name">${pick.players?.name || '—'}</div>
            <div class="pick-chip-meta">Rd ${round} · Pick ${pickNum}</div>
          </div>
        `;
      } else if (isOnClock) {
        cellContent = `
          <div style="display:flex;align-items:center;gap:6px;">
            <div style="width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1s infinite;"></div>
            <span style="font-size:0.75rem;color:var(--accent);font-weight:600;">On Clock</span>
          </div>
        `;
      }

      html += `<div class="${cellClass}" data-pick="${pickNum}">${cellContent}</div>`;
    }
  }

  board.innerHTML = html;

  // Update my-turn-active on player panel
  const isMyTurnNow = teamForPick(currentPick)?.id === draftState.myTeam.id;
  document.getElementById('player-panel').classList.toggle('my-turn-active', isMyTurnNow);
  document.getElementById('my-turn-banner').classList.toggle('hidden', !isMyTurnNow);

  // Scroll current pick into view
  const onClockCell = board.querySelector('.on-clock-cell');
  if (onClockCell) {
    onClockCell.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }
}

// ── TICKER ──
function updateTicker() {
  const { draft, teams, league } = draftState;
  if (!draft) return;

  const cols = teams.length;
  const currentPick = draft.current_pick || 1;
  const round = Math.ceil(currentPick / cols);
  const teamSize = league.settings?.team_size || 7;
  const totalPicks = cols * teamSize;

  document.getElementById('ticker-round').textContent = `RD ${round}`;
  document.getElementById('ticker-pick-num').textContent = currentPick;
  document.getElementById('ticker-total-picks').textContent = totalPicks;

  // Who's on clock
  function teamForPick(pickNum) {
    const r = Math.ceil(pickNum / cols);
    const posInRound = pickNum - (r - 1) * cols;
    const isEven = r % 2 === 0;
    const idx = isEven ? cols - posInRound : posInRound - 1;
    return teams[idx];
  }

  const onClockTeam = teamForPick(currentPick);
  const isMe = onClockTeam?.id === draftState.myTeam.id;
  const nameEl = document.getElementById('on-clock-team');
  nameEl.textContent = isMe ? `${onClockTeam?.name} (YOU)` : (onClockTeam?.name || '—');
  nameEl.classList.toggle('my-turn', isMe);
}

// ── TIMER ──
function startTimer() {
  clearInterval(draftState.timerInterval);
  draftState.currentSeconds = draftState.timerSeconds;
  updateTimerUI(draftState.currentSeconds);

  draftState.timerInterval = setInterval(() => {
    draftState.currentSeconds--;
    updateTimerUI(draftState.currentSeconds);

    if (draftState.currentSeconds <= 0) {
      clearInterval(draftState.timerInterval);
      handleTimerExpiry();
    }
  }, 1000);
}

function updateTimerUI(seconds) {
  const total = draftState.timerSeconds;
  const pct = seconds / total;
  const circumference = 126; // 2 * PI * 20
  const offset = circumference * (1 - pct);

  const fill = document.getElementById('timer-ring-fill');
  const num = document.getElementById('timer-number');
  const isWarning = seconds <= 20;

  if (fill) {
    fill.style.strokeDashoffset = offset;
    fill.classList.toggle('warning', isWarning);
  }
  if (num) {
    num.textContent = seconds > 0 ? seconds : '0';
    num.classList.toggle('warning', isWarning);
  }
}

function handleTimerExpiry() {
  // Auto-pick: pick the highest rated available player for teams on clock
  const { teams, picks, players, draft, myTeam } = draftState;
  const cols = teams.length;
  const currentPick = draft?.current_pick || 1;

  function teamForPick(pickNum) {
    const r = Math.ceil(pickNum / cols);
    const pos = pickNum - (r - 1) * cols;
    const isEven = r % 2 === 0;
    const idx = isEven ? cols - pos : pos - 1;
    return teams[idx];
  }

  const onClockTeam = teamForPick(currentPick);

  // Only auto-pick if it's NOT my turn (let commissioner handle or wait)
  // If it IS my turn, just warn
  if (onClockTeam?.id === myTeam.id) {
    showToast('⏰ Time is up! Please make your pick.', 'error', 5000);
    return;
  }

  // If commissioner, auto-pick best available
  if (draftState.isCommissioner) {
    const draftedIds = new Set(picks.map(p => p.player_id));
    const best = players.find(p => !draftedIds.has(p.id));
    if (best) makePick(best.id, onClockTeam.id, true);
  }
}

// ── PLAYER LIST ──
function renderPlayerList() {
  const { players, picks, searchQuery, ratingFilter } = draftState;
  const draftedIds = new Set(picks.map(p => p.player_id));

  let filtered = players.filter(p => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!p.name.toLowerCase().includes(q)) return false;
    }
    if (ratingFilter !== 'all') {
      const minRating = parseInt(ratingFilter);
      if ((p.pdga_rating || 0) < minRating) return false;
    }
    return true;
  });

  const { draft, teams, myTeam } = draftState;
  const cols = teams.length;
  const currentPick = draft?.current_pick || 1;

  function teamForPick(pickNum) {
    const r = Math.ceil(pickNum / cols);
    const pos = pickNum - (r - 1) * cols;
    const isEven = r % 2 === 0;
    const idx = isEven ? cols - pos : pos - 1;
    return teams[idx];
  }

  const isMyTurn = teamForPick(currentPick)?.id === myTeam.id;

  if (!filtered.length) {
    document.getElementById('player-list').innerHTML = `
      <div class="empty-state" style="padding:24px;">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-title">No players found</div>
      </div>
    `;
    return;
  }

  const html = filtered.map(p => {
    const isDrafted = draftedIds.has(p.id);
    return `
      <div class="draft-player-row ${isDrafted ? 'drafted' : ''}"
           data-player-id="${p.id}" ${!isDrafted && isMyTurn ? 'onclick="pickPlayer(\'' + p.id + '\')"' : ''}>
        <div class="player-avatar" style="width:30px;height:30px;font-size:0.65rem;flex-shrink:0;">
          ${getInitials(p.name)}
        </div>
        <div class="player-info">
          <div class="player-name">${p.name}</div>
          <div class="player-meta">${isDrafted ? 'Drafted' : (p.pdga_number ? `#${p.pdga_number}` : 'Pro')}</div>
        </div>
        ${isDrafted
          ? '<span style="font-size:0.7rem;color:var(--text-muted);">—</span>'
          : `<span class="draft-player-rating">${p.pdga_rating || '—'}</span>
             <button class="pick-btn" onclick="pickPlayer('${p.id}')">PICK</button>`
        }
      </div>
    `;
  }).join('');

  document.getElementById('player-list').innerHTML = html;

  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      draftState.ratingFilter = btn.dataset.filter;
      renderPlayerList();
    });
  });

  // Search
  const searchEl = document.getElementById('player-search');
  if (searchEl && !searchEl._bound) {
    searchEl._bound = true;
    searchEl.addEventListener('input', e => {
      draftState.searchQuery = e.target.value.trim();
      renderPlayerList();
    });
  }
}

// ── MAKE A PICK ──
async function pickPlayer(playerId) {
  const { draft, teams, myTeam, picks, league } = draftState;
  if (!draft || draft.status !== 'active') return;

  const cols = teams.length;
  const currentPick = draft.current_pick || 1;
  const teamSize = league.settings?.team_size || 7;
  const totalPicks = cols * teamSize;

  function teamForPick(pickNum) {
    const r = Math.ceil(pickNum / cols);
    const pos = pickNum - (r - 1) * cols;
    const isEven = r % 2 === 0;
    const idx = isEven ? cols - pos : pos - 1;
    return teams[idx];
  }

  const onClockTeam = teamForPick(currentPick);

  // Validate it's actually your turn (or commissioner auto-pick)
  if (onClockTeam?.id !== myTeam.id && !draftState.isCommissioner) {
    showToast("It's not your turn!", 'error');
    return;
  }

  // Check not already drafted
  const draftedIds = new Set(picks.map(p => p.player_id));
  if (draftedIds.has(playerId)) {
    showToast('Player already drafted!', 'error');
    return;
  }

  const round = Math.ceil(currentPick / cols);
  const pickInRound = currentPick - (round - 1) * cols;

  // Insert pick
  const { error: pickErr } = await db.from('draft_picks').insert({
    draft_id: draft.id,
    league_id: league.id,
    team_id: onClockTeam.id,
    player_id: playerId,
    pick_number: currentPick,
    round,
    pick_in_round: pickInRound,
  });

  if (pickErr) {
    showToast('Pick failed: ' + pickErr.message, 'error');
    return;
  }

  // Add to roster
  await db.from('rosters').insert({
    team_id: onClockTeam.id,
    player_id: playerId,
    league_id: league.id,
    acquired_via: 'draft',
    is_active: true,
  });

  const nextPick = currentPick + 1;
  const isDraftDone = nextPick > totalPicks;

  // Advance or complete draft
  await db.from('drafts').update({
    current_pick: isDraftDone ? currentPick : nextPick,
    status: isDraftDone ? 'completed' : 'active',
    ...(isDraftDone ? { completed_at: new Date().toISOString() } : {})
  }).eq('id', draft.id);

  // Realtime handles the rest
}

// Alias for inline onclick
function makePick(playerId, teamId, isAuto = false) {
  pickPlayer(playerId);
}

// ── RECENT PICKS ──
function renderRecentPicks() {
  const recent = [...draftState.picks].reverse().slice(0, 8);
  if (!recent.length) {
    document.getElementById('recent-picks-list').innerHTML =
      '<div style="font-size:0.75rem;color:var(--text-muted);">No picks yet</div>';
    return;
  }

  const html = recent.map(pick => `
    <div class="recent-pick-item">
      <span class="pick-num-badge">#${pick.pick_number}</span>
      <span style="font-weight:600;font-size:0.8rem;">${pick.players?.name || '—'}</span>
      <span style="color:var(--text-muted);font-size:0.72rem;margin-left:auto;">${pick.teams?.name || '—'}</span>
    </div>
  `).join('');

  document.getElementById('recent-picks-list').innerHTML = html;
}

// ── REALTIME SUBSCRIPTIONS ──
function subscribeToDraft(leagueId) {
  // Listen for new picks
  db.channel('draft-picks-' + leagueId)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'draft_picks',
      filter: `league_id=eq.${leagueId}`
    }, async (payload) => {
      // Reload picks
      const { data: picks } = await db
        .from('draft_picks')
        .select('*, players(*), teams(*)')
        .eq('league_id', leagueId)
        .order('pick_number', { ascending: true });

      draftState.picks = picks || [];

      showToast(`Pick #${payload.new.pick_number} made!`, 'info', 2000);
      renderDraftBoard();
      renderPlayerList();
      renderRecentPicks();
    })
    .subscribe();

  // Listen for draft status changes (start/complete)
  db.channel('draft-status-' + leagueId)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'drafts',
      filter: `league_id=eq.${leagueId}`
    }, (payload) => {
      draftState.draft = payload.new;

      if (payload.new.status === 'active') {
        document.getElementById('draft-pending').classList.add('hidden');
        showActiveState();
      } else if (payload.new.status === 'completed') {
        clearInterval(draftState.timerInterval);
        document.getElementById('draft-active').classList.add('hidden');
        document.getElementById('draft-completed').classList.remove('hidden');
        showToast('🏆 Draft complete!', 'success', 5000);
      } else {
        updateTicker();
        startTimer(); // reset timer on each new pick
        renderDraftBoard();
      }
    })
    .subscribe();
}
