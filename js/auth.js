// ============================================
// BULLSEYE - AUTH
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
  // If already logged in, redirect to leagues hub
  const { data: { session } } = await db.auth.getSession();
  if (session) {
    window.location.href = 'pages/leagues.html';
    return;
  }

  setupTabs();
  setupLoginForm();
  setupSignupForm();
  setupJoinFlow();
  setupDemoMode();
});

function setupTabs() {
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${tab.dataset.tab}-panel`).classList.add('active');
    });
  });
}

function setupLoginForm() {
  const btn = document.getElementById('login-btn');
  const errorEl = document.getElementById('login-error');

  btn.addEventListener('click', async () => {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    if (!email || !password) {
      showAuthError(errorEl, 'Please fill in all fields.');
      return;
    }

    setLoading(btn, true);
    errorEl.classList.add('hidden');

    const { data, error } = await db.auth.signInWithPassword({ email, password });

    if (error) {
      showAuthError(errorEl, error.message);
      setLoading(btn, false);
      return;
    }

    // Check for pending invite code
    const pendingCode = sessionStorage.getItem('pending_invite');
    if (pendingCode) {
      sessionStorage.removeItem('pending_invite');
      window.location.href = `pages/join.html?code=${pendingCode}`;
    } else {
      window.location.href = 'pages/leagues.html';
    }
  });

  // Enter key
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') btn.click();
  });
}

function setupSignupForm() {
  const btn = document.getElementById('signup-btn');
  const errorEl = document.getElementById('signup-error');
  const successEl = document.getElementById('signup-success');

  btn.addEventListener('click', async () => {
    const name = document.getElementById('signup-name').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;

    if (!name || !email || !password) {
      showAuthError(errorEl, 'Please fill in all fields.');
      return;
    }
    if (password.length < 8) {
      showAuthError(errorEl, 'Password must be at least 8 characters.');
      return;
    }

    setLoading(btn, true);
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');

    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: name }
      }
    });

    setLoading(btn, false);

    if (error) {
      showAuthError(errorEl, error.message);
      return;
    }

    successEl.textContent = '✓ Account created! Check your email to confirm, then sign in.';
    successEl.classList.remove('hidden');
    btn.disabled = true;
  });
}

function setupJoinFlow() {
  const btn = document.getElementById('join-btn');
  const input = document.getElementById('invite-code');

  btn.addEventListener('click', async () => {
    const code = input.value.trim().toLowerCase();
    if (!code || code.length < 6) {
      showToast('Please enter a valid invite code', 'error');
      return;
    }

    // Check if code exists
    const { data, error } = await db
      .from('leagues')
      .select('id, name')
      .eq('invite_code', code)
      .single();

    if (error || !data) {
      showToast('Invalid invite code — league not found', 'error');
      return;
    }

    // Store code and redirect to auth/join
    sessionStorage.setItem('pending_invite', code);
    sessionStorage.setItem('pending_league_name', data.name);

    const { data: { session } } = await db.auth.getSession();
    if (session) {
      window.location.href = `pages/join.html?code=${code}`;
    } else {
      showToast(`Found league: ${data.name}. Sign in or create an account to join!`, 'info', 5000);
      // Switch to login tab
      document.querySelector('[data-tab="login"]').click();
    }
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') btn.click();
  });
}

function setupDemoMode() {
  const btn = document.getElementById('demo-btn');
  btn.addEventListener('click', () => {
    // Demo mode uses a pre-seeded demo account
    document.getElementById('login-email').value = 'demo@bullseye.gg';
    document.getElementById('login-password').value = 'demo1234';
    document.getElementById('login-btn').click();
  });
}

function showAuthError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function setLoading(btn, loading) {
  const span = btn.querySelector('span');
  const spinner = btn.querySelector('.btn-spinner');
  if (loading) {
    span.style.opacity = '0';
    spinner.classList.remove('hidden');
    btn.disabled = true;
  } else {
    span.style.opacity = '1';
    spinner.classList.add('hidden');
    btn.disabled = false;
  }
}
