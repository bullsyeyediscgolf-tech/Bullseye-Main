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
