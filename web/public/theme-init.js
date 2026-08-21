// Pre-paint theme application. Keep in sync with web/src/lib/theme.ts.
(function () {
  try {
    var appId = new URLSearchParams(window.location.search).get('oa-app-id');
    var windowId = new URLSearchParams(window.location.search).get('oa-window-id');
    if (appId) document.documentElement.dataset.openagentdAppId = appId;
    if (windowId) document.documentElement.dataset.openagentdWindowId = windowId;
    var storageKey = appId && windowId
      ? 'oa-theme:' + appId + ':' + windowId
      : appId ? 'oa-theme:' + appId : 'oa-theme';
    var stored = localStorage.getItem(storageKey);
    var pref = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
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
})();
