// ============================================
// BULLSEYE - SUPABASE CLIENT
// ============================================

const SUPABASE_URL = 'https://priwbgrlmufrgdpfukoq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_h_3bzvq5-wZ8tcgU-HZ7qg_wPFz_WD_';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================
// AUTH HELPERS
// ============================================
async function getCurrentUser() {
  const { data: { user } } = await db.auth.getUser();
  return user;
}

async function requireAuth() {
  const user = await getCurrentUser();
  if (!user) {
    window.location.href = '/index.html';
    return null;
  }

  // Safety net: if display_name is missing, fix it from pending cache or email
  if (!user.user_metadata?.display_name) {
    const pendingName = localStorage.getItem('pending_display_name');
    const fixedName = pendingName || user.email?.split('@')[0] || 'Player';
    await db.auth.updateUser({ data: { display_name: fixedName } });
    localStorage.removeItem('pending_display_name');
    // Refresh user object with updated metadata
    const { data: { user: freshUser } } = await db.auth.getUser();
    if (freshUser) return freshUser;
  }

  return user;
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================
function showToast(message, type = 'info', duration = 3500) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toast-in 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ============================================
// SCORING ENGINE
// ============================================
const SCORING = {
  // Calculate a player's fantasy points for a tournament
  calcPlayerPoints(scores, stats, position, leagueSettings) {
    const cfg = leagueSettings?.scoring || {
      lead_card_multiplier: 1.5,
      podium_bonus: [15, 8, 3],
      eagle_bonus: 1,
      parked_bonus: 1
    };

    let totalRawScore = 0;
    let totalBonuses = 0;

    scores.forEach((round, i) => {
      const roundNum = round.round;
      let raw = round.score_relative_par || 0;
      if (raw > 10) raw = 10; // Cap DNF scores at +10 over par
      const isLeadCard = round.is_lead_card && roundNum > 1; // no lead card bonus R1

      const fantasyRaw = -raw; // negate: under par (negative) → positive fantasy pts
      let roundScore = fantasyRaw;
      if (isLeadCard) {
        roundScore = fantasyRaw * cfg.lead_card_multiplier;
      }
      totalRawScore += roundScore;
      totalBonuses += (round.eagles || 0) * cfg.eagle_bonus;
      totalBonuses += (round.parked_holes || 0) * cfg.parked_bonus;
    });

    // Podium bonus (on the final round)
    const lastRound = scores.find(r => r.finish_position != null);
    if (lastRound?.finish_position === 1) totalBonuses += cfg.podium_bonus[0];
    else if (lastRound?.finish_position === 2) totalBonuses += cfg.podium_bonus[1];
    else if (lastRound?.finish_position === 3) totalBonuses += cfg.podium_bonus[2];

    return {
      rawScore: totalRawScore,
      bonuses: totalBonuses,
      total: totalRawScore + totalBonuses
    };
  },

  // Calculate team standing points (4, 2, 1, 0, -1, -2...)
  calcLeaguePoints(place) {
    if (place === 1) return 4;
    if (place === 2) return 2;
    if (place === 3) return 1;
    return Math.max(-10, -(place - 3)); // 4th = 0, 5th = -1, etc.
  },

  // Position stat lookup
  getPositionStat(stats, position) {
    if (!stats) return 0;
    if (position === 'putter') return (stats.c1x_putting_pct || 0) + (stats.c2_putting_pct || 0);
    if (position === 'driver') return stats.fairway_hit_pct || 0;
    if (position === 'approacher') return stats.c1_in_reg_pct || 0;
    return 0;
  }
};

// ============================================
// DATE / FORMAT HELPERS
// ============================================
function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateRange(start, end) {
  if (!start) return '—';
  const s = new Date(start);
  const e = end ? new Date(end) : null;
  const opts = { month: 'short', day: 'numeric' };
  if (!e) return s.toLocaleDateString('en-US', opts);
  if (s.getMonth() === e.getMonth()) {
    return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${e.getDate()}`;
  }
  return `${s.toLocaleDateString('en-US', opts)} – ${e.toLocaleDateString('en-US', opts)}`;
}

function getInitials(name) {
  if (!name) return '??';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function scoreColor(score) {
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return '';
}

function scoreDisplay(score) {
  if (score == null) return '—';
  if (score === 0) return 'E';
  return score > 0 ? `+${score}` : `${score}`;
}

// ============================================
// SPOILER SHIELD
// ============================================
function applySpoilerShields() {
  document.querySelectorAll('[data-spoiler]').forEach(el => {
    el.classList.add('spoiler-shield');
    el.addEventListener('click', function() {
      this.classList.toggle('revealed');
    });
  });
}

// ============================================
// LEAGUE SELECTION
// ============================================
function getSelectedTeamId() {
  return localStorage.getItem('selected_team_id');
}

function setSelectedTeamId(teamId) {
  localStorage.setItem('selected_team_id', teamId);
}

function clearSelectedTeam() {
  localStorage.removeItem('selected_team_id');
}

// Returns the team matching localStorage selection, or first team, or null
async function getSelectedTeam(userId) {
  const { data: teams } = await db
    .from('teams')
    .select('*, leagues(*)')
    .eq('manager_id', userId);

  if (!teams || !teams.length) return null;

  const savedId = getSelectedTeamId();
  if (savedId) {
    const match = teams.find(t => t.id === savedId);
    if (match) return match;
  }

  // Fallback to first team & persist
  setSelectedTeamId(teams[0].id);
  return teams[0];
}

// Auto-add "My Leagues" link and mobile menu to sidebar on all pages
document.addEventListener('DOMContentLoaded', () => {
  const selector = document.querySelector('.league-selector');
  if (selector && !document.querySelector('.leagues-page')) {
    const link = document.createElement('a');
    link.href = 'leagues.html';
    link.style.cssText = 'font-size:0.68rem;color:var(--accent);text-decoration:none;margin-top:2px;display:inline-block;';
    link.textContent = 'My Leagues';
    selector.appendChild(link);
  }

  // Mobile menu: add hamburger button and overlay
  const sidebar = document.querySelector('.sidebar');
  const topbar = document.querySelector('.topbar');
  if (sidebar && topbar) {
    // Create hamburger button
    const menuBtn = document.createElement('button');
    menuBtn.className = 'mobile-menu-btn';
    menuBtn.setAttribute('aria-label', 'Open menu');
    menuBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
    topbar.insertBefore(menuBtn, topbar.firstChild);

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);

    function openMenu() {
      sidebar.classList.add('open');
      overlay.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
    function closeMenu() {
      sidebar.classList.remove('open');
      overlay.classList.remove('active');
      document.body.style.overflow = '';
    }

    menuBtn.addEventListener('click', () => {
      sidebar.classList.contains('open') ? closeMenu() : openMenu();
    });
    overlay.addEventListener('click', closeMenu);

    // Close menu when a nav link is clicked
    sidebar.querySelectorAll('.nav-item, a').forEach(link => {
      link.addEventListener('click', closeMenu);
    });
  }

  // Inject Settings nav link into sidebar if not already present
  const sidebarNav = document.querySelector('.sidebar-nav');
  if (sidebarNav && !sidebarNav.querySelector('a[href="leaderboard.html"]')) {
    const leaderboardLink = document.createElement('a');
    leaderboardLink.href = 'leaderboard.html';
    leaderboardLink.className = 'nav-item';
    leaderboardLink.innerHTML = `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Leaderboard`;
    const myTeamSection = Array.from(sidebarNav.querySelectorAll('.nav-section-label'))
      .find(label => label.textContent.trim() === 'My Team');
    if (myTeamSection) {
      sidebarNav.insertBefore(leaderboardLink, myTeamSection);
    } else {
      sidebarNav.appendChild(leaderboardLink);
    }
  }

  if (sidebarNav && !sidebarNav.querySelector('a[href="settings.html"]')) {
    const settingsLink = document.createElement('a');
    settingsLink.href = 'settings.html';
    settingsLink.className = 'nav-item';
    settingsLink.id = 'settings-nav-link';
    settingsLink.innerHTML = `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>Settings`;
    sidebarNav.appendChild(settingsLink);
  }
});

// ============================================
// LOCAL STATE
// ============================================
const AppState = {
  user: null,
  teams: [],
  currentLeague: null,
  currentTeam: null,
  spoilerShield: localStorage.getItem('spoiler_shield') !== 'false',

  set(key, val) {
    this[key] = val;
    if (key === 'spoilerShield') localStorage.setItem('spoiler_shield', val);
  }
};
