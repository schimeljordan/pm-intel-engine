(function () {
  const AUTH_KEY = 'fire_intel_auth';
  const AUTH_EXPIRY_KEY = 'fire_intel_auth_expiry';
  const token = localStorage.getItem(AUTH_KEY);
  const expiry = parseInt(localStorage.getItem(AUTH_EXPIRY_KEY) || '0', 10);
  if (!token || Date.now() > expiry) {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(AUTH_EXPIRY_KEY);
    window.location.replace('login.html');
  }
})();
