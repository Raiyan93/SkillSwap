/**
 * SkillSwap — Backend URL Configuration
 * ─────────────────────────────────────
 * Controls which backend the frontend talks to.
 *
 * LOCAL  → automatically uses http://localhost:5000
 * PROD   → uses RENDER_BACKEND_URL below
 *
 * ⚠️  After Render deploys, replace the placeholder with your real Render URL,
 *     then redeploy Firebase Hosting (firebase deploy --only hosting).
 */
(function () {
  var RENDER_BACKEND_URL = 'https://YOUR_APP_NAME.onrender.com'; // ← update after Render deploy

  var isLocal =
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    location.hostname === '';

  window.SkillSwapBackendBaseUrl = isLocal
    ? 'http://localhost:5000'
    : RENDER_BACKEND_URL;
})();
