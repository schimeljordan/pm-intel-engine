const SALT = 'fire-intel-salt-2026';
const CORRECT_HASH = '72330a4264bab2517abc523751534a61b78da7988f23b45bd59bd6081faa4201';
const AUTH_KEY = 'fire_intel_auth';
const AUTH_EXPIRY_KEY = 'fire_intel_auth_expiry';
const SESSION_HOURS = 720; // re-login every 30 days

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const pw = document.getElementById('pw').value;
  const hash = await sha256(pw + ':' + SALT);
  if (hash === CORRECT_HASH) {
    localStorage.setItem(AUTH_KEY, hash);
    localStorage.setItem(AUTH_EXPIRY_KEY, String(Date.now() + SESSION_HOURS * 3600 * 1000));
    window.location.href = 'index.html';
  } else {
    document.getElementById('login-error').textContent = 'Incorrect password.';
    document.getElementById('pw').value = '';
  }
});

document.getElementById('pw').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-btn').click();
});
