// Pre-paint theme application. Keep in sync with web/src/lib/theme.ts.
(function () {
  try {
    // Rust injects these as webview globals on every document load, so they
    // survive reloads even though the SPA router drops the query params. The
    // params remain the fallback for browser/dev builds.
    var appId = window.__OAD_APP_ID__
      || new URLSearchParams(window.location.search).get('oa-app-id');
    var windowId = window.__OAD_WINDOW_ID__
      || new URLSearchParams(window.location.search).get('oa-window-id');
    if (appId) document.documentElement.dataset.openagentdAppId = appId;
    if (windowId) document.documentElement.dataset.openagentdWindowId = windowId;
    var storageKey = appId && windowId
      ? 'oa-theme:' + appId + ':' + windowId
      : appId ? 'oa-theme:' + appId : 'oa-theme';
    var stored = localStorage.getItem(storageKey);
    // A new desktop window opens with the pick of the window it came from
    // (window.rs injects __OAD_OPENER_THEME__) until it has one of its own.
    var opener = window.__OAD_OPENER_THEME__;
    var pref = stored === 'light' || stored === 'dark' || stored === 'system'
      ? stored
      : opener === 'light' || opener === 'dark' ? opener : 'system';
    var resolved = pref === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : pref;
    var root = document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
    root.classList.toggle('light', resolved === 'light');
  } catch (_e) {
    // Fall back to light (the canonical default in index.css).
    document.documentElement.classList.add('light');
  }
  // Text size (stores/useDisplayPrefsStore.ts): set before paint so the first
  // frame already has the right type scale. Unknown values keep the default.
  try {
    var prefs = JSON.parse(localStorage.getItem('oa.display.v1') || 'null');
    var size = prefs && prefs.state && prefs.state.textSize;
    if (size === 'compact' || size === 'default' || size === 'large') {
      document.documentElement.dataset.textSize = size;
    }
  } catch (_e) {
    // Unreadable prefs: Default text size.
  }
})();
