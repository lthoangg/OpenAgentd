/*
 * OpenAgentd preview inspector.
 *
 * The preview listener adds this script to every HTML page it serves. It
 * talks to the review dock through postMessage and never touches the app:
 * the page runs on its own loopback origin.
 *
 * Page -> dock:  ready, location, select, console, mode, shortcut (Alt+C, Cmd/Ctrl+W)
 * Dock -> page:  hello, set-mode, pins, reload, navigate, history
 *
 * Every message carries { ns: 'openagentd-preview', v: 1 }. Messages are
 * accepted only from window.parent, and only when the parent is the top
 * window (the dock), so frames nested inside the page stay passive.
 *
 * Page -> dock also carries `agent` while the agent drives the page: the
 * script long-polls AGENT_PATH on its own origin for the agent's commands
 * (snapshot, click, fill, press, scroll, navigate, wait, inspect) and
 * posts each result back there. A virtual cursor in the overlay glides to
 * each element the agent acts on, so the user can follow along.
 */
(function () {
  'use strict';
  var NS = 'openagentd-preview';
  var VERSION = 1;
  var CONSOLE_PATH = '/__openagentd/console';
  var AGENT_PATH = '/__openagentd/agent';
  var MAX_ARG = 2000;
  var w = window;
  if (w.__openagentdPreview) return;
  w.__openagentdPreview = true;
  if (w.parent === w || w.parent !== w.top) return;

  var doc = document;
  var originalFetch = typeof w.fetch === 'function' ? w.fetch.bind(w) : null;

  function post(msg) {
    msg.ns = NS;
    msg.v = VERSION;
    try {
      w.parent.postMessage(msg, '*');
    } catch (_) {
      /* the dock went away */
    }
  }

  function pagePath() {
    return w.location.pathname + w.location.search + w.location.hash;
  }

  function reportLocation(type) {
    post({ type: type, path: pagePath(), title: doc.title || '' });
  }

  // ── Console capture ───────────────────────────────────────────────────

  function truncate(s, max) {
    s = String(s);
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  function format(arg) {
    if (typeof arg === 'string') return arg;
    // Duck-typed so errors from other realms (nested frames) keep their text.
    if (arg instanceof Error || (arg && typeof arg === 'object' && typeof arg.message === 'string' && typeof arg.name === 'string')) {
      return arg.stack || arg.name + ': ' + arg.message;
    }
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'function') return '[function ' + (arg.name || 'anonymous') + ']';
    if (typeof Element !== 'undefined' && arg instanceof Element) return '<' + arg.tagName.toLowerCase() + '>';
    try {
      var seen = [];
      return JSON.stringify(arg, function (_k, v) {
        if (typeof v === 'object' && v !== null) {
          if (seen.indexOf(v) >= 0) return '[circular]';
          seen.push(v);
        }
        if (typeof v === 'bigint') return v.toString() + 'n';
        return v;
      });
    } catch (_) {
      return String(arg);
    }
  }

  var queue = [];
  var flushTimer = null;

  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    var entries = queue.splice(0, 200);
    post({ type: 'console', entries: entries });
    if (!originalFetch) return;
    try {
      originalFetch(CONSOLE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: entries }),
        keepalive: true,
      }).catch(function () {});
    } catch (_) {
      /* never let reporting break the page */
    }
    if (queue.length) schedule();
  }

  function schedule() {
    if (flushTimer === null) flushTimer = setTimeout(flush, 500);
  }

  function record(level, message) {
    queue.push({ level: level, message: truncate(message, MAX_ARG), url: pagePath(), ts: Date.now() });
    if (queue.length > 500) queue.splice(0, queue.length - 500);
    schedule();
  }

  ['error', 'warn', 'info', 'log', 'debug'].forEach(function (level) {
    var original = w.console && w.console[level];
    if (typeof original !== 'function') return;
    w.console[level] = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(truncate(format(arguments[i]), MAX_ARG));
        record(level, parts.join(' '));
      } catch (_) {
        /* ignore */
      }
      return original.apply(this, arguments);
    };
  });

  w.addEventListener(
    'error',
    function (event) {
      var target = event.target;
      if (target && target !== w && target.tagName) {
        var src = target.src || target.href || '';
        record('error', 'Failed to load <' + target.tagName.toLowerCase() + '> ' + src);
        return;
      }
      var where = event.filename ? ' (' + event.filename + ':' + event.lineno + ':' + event.colno + ')' : '';
      var stack = event.error && event.error.stack ? '\n' + event.error.stack : '';
      record('error', 'Uncaught ' + (event.message || 'error') + where + stack);
    },
    true,
  );

  w.addEventListener('unhandledrejection', function (event) {
    record('error', 'Unhandled promise rejection: ' + format(event.reason));
  });

  w.addEventListener('pagehide', flush);

  // ── Element descriptors ───────────────────────────────────────────────

  function cssEscape(s) {
    if (w.CSS && typeof w.CSS.escape === 'function') return w.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
      return '\\' + c;
    });
  }

  function selectorFor(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      var tag = node.tagName.toLowerCase();
      var testId = node.getAttribute('data-testid');
      if (testId) {
        parts.unshift(tag + '[data-testid="' + testId.replace(/"/g, '\\"') + '"]');
        break;
      }
      if (node.id) {
        var idSel = '#' + cssEscape(node.id);
        var unique = false;
        try {
          unique = doc.querySelectorAll(idSel).length === 1;
        } catch (_) {
          unique = false;
        }
        if (unique) {
          parts.unshift(idSel);
          break;
        }
      }
      if (tag === 'html' || tag === 'body') {
        parts.unshift(tag);
        break;
      }
      var part = tag;
      var parent = node.parentElement;
      if (parent) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
        }
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function fiberName(fiber) {
    var t = fiber && fiber.type;
    if (!t || typeof t === 'string') return null;
    return t.displayName || t.name || null;
  }

  // Best effort: React <= 18 dev builds expose _debugSource; Vue and Svelte
  // dev builds tag elements with their component file.
  function sourceFor(el) {
    var component = null;
    for (var node = el, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        if (keys[k].indexOf('__reactFiber$') !== 0 && keys[k].indexOf('__reactInternalInstance$') !== 0) continue;
        var fiber = node[keys[k]];
        for (var hop = 0; fiber && hop < 30; hop++, fiber = fiber.return) {
          if (!component) component = fiberName(fiber);
          var s = fiber._debugSource;
          if (s && s.fileName) return { file: s.fileName, line: s.lineNumber || null, component: component };
        }
      }
      var vue = node.__vueParentComponent;
      if (vue && vue.type && vue.type.__file) return { file: vue.type.__file, line: null, component: vue.type.name || vue.type.__name || component };
      var svelte = node.__svelte_meta;
      if (svelte && svelte.loc && svelte.loc.file) return { file: svelte.loc.file, line: typeof svelte.loc.line === 'number' ? svelte.loc.line : null, component: component };
    }
    return component ? { file: null, line: null, component: component } : null;
  }

  // ── React 19 sources: _debugStack + the module's source map ────────────
  //
  // React 19 dropped _debugSource. Its dev builds instead keep, on every
  // element (and so fiber), the Error created where the JSX ran. The first
  // frame of that stack in the app's own code points into the module the dev
  // server served; its source map gives the original file and line.

  var SOURCE_TIMEOUT_MS = 1500;
  var MAX_MODULE_BYTES = 8 * 1024 * 1024;
  var DEP_PATH = /\/node_modules\/|\/\.vite\/deps\/|\/@vite\/|\/@react-refresh|\/@id\/__x00__/;
  var FRAME_RE = /(https?:\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/;
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var mapCache = {};

  /** Frames in the app's own modules (same origin, not a dependency). */
  function appFrame(stack) {
    var lines = String(stack || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = FRAME_RE.exec(lines[i]);
      if (!m) continue;
      var u;
      try {
        u = new URL(m[1]);
      } catch (_) {
        continue;
      }
      if (u.origin !== w.location.origin || DEP_PATH.test(u.pathname)) continue;
      return { url: u.href, path: decodeURIComponent(u.pathname), line: Number(m[2]), column: Number(m[3]) };
    }
    return null;
  }

  function stackSource(el) {
    var component = null;
    for (var node = el, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        if (keys[k].indexOf('__reactFiber$') !== 0) continue;
        var fiber = node[keys[k]];
        for (var hop = 0; fiber && hop < 30; hop++, fiber = fiber.return) {
          if (!component) component = fiberName(fiber);
          var frame = fiber._debugStack && appFrame(fiber._debugStack.stack);
          if (frame) return { frame: frame, component: component || null };
        }
        return null;
      }
    }
    return null;
  }

  function decodeVlq(segment) {
    var out = [];
    var value = 0;
    var shift = 0;
    for (var i = 0; i < segment.length; i++) {
      var digit = B64.indexOf(segment.charAt(i));
      if (digit < 0) return out;
      value += (digit & 31) << shift;
      if (digit & 32) {
        shift += 5;
      } else {
        out.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
    }
    return out;
  }

  /** Absolute segments per generated line: [column, source, line, sourceColumn]. */
  function parseMappings(mappings) {
    var lines = [];
    var src = 0;
    var line = 0;
    var col = 0;
    var rows = String(mappings || '').split(';');
    for (var r = 0; r < rows.length; r++) {
      var segs = [];
      var gen = 0;
      var parts = rows[r] ? rows[r].split(',') : [];
      for (var p = 0; p < parts.length; p++) {
        var v = decodeVlq(parts[p]);
        if (!v.length) continue;
        gen += v[0];
        if (v.length >= 4) {
          src += v[1];
          line += v[2];
          col += v[3];
          segs.push([gen, src, line, col]);
        }
      }
      lines.push(segs);
    }
    return lines;
  }

  function base64Text(data) {
    var bin = w.atob(data);
    if (typeof w.TextDecoder !== 'function') return bin;
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new w.TextDecoder().decode(bytes);
  }

  function sourcePath(source, root, base) {
    try {
      var u = new URL((root ? root.replace(/\/?$/, '/') : '') + source, base);
      return u.origin === w.location.origin ? decodeURIComponent(u.pathname) : source;
    } catch (_) {
      return source;
    }
  }

  function buildMap(json, base) {
    if (!json || !json.sources || typeof json.mappings !== 'string') return null;
    return {
      sources: json.sources.map(function (s) {
        return sourcePath(String(s), json.sourceRoot || '', base);
      }),
      lines: parseMappings(json.mappings),
    };
  }

  function sameOriginFetch(url) {
    var u = new URL(url, w.location.href);
    if (u.origin !== w.location.origin || !originalFetch) return Promise.reject(new Error('cross-origin'));
    return originalFetch(u.href, { cache: 'force-cache' });
  }

  function loadMap(moduleUrl) {
    if (mapCache[moduleUrl]) return mapCache[moduleUrl];
    var promise = sameOriginFetch(moduleUrl)
      .then(function (res) {
        return res.ok ? res.text() : '';
      })
      .then(function (code) {
        if (!code || code.length > MAX_MODULE_BYTES) return null;
        var at = code.lastIndexOf('sourceMappingURL=');
        if (at < 0) return null;
        var ref = code.slice(at + 'sourceMappingURL='.length).split(/\s/)[0];
        if (ref.indexOf('data:') === 0) {
          var comma = ref.indexOf(',');
          var head = ref.slice(0, comma);
          var body = ref.slice(comma + 1);
          return buildMap(JSON.parse(/;base64$/.test(head) ? base64Text(body) : decodeURIComponent(body)), moduleUrl);
        }
        var mapUrl = new URL(ref, moduleUrl).href;
        return sameOriginFetch(mapUrl)
          .then(function (res) {
            return res.json();
          })
          .then(function (json) {
            return buildMap(json, mapUrl);
          });
      })
      .catch(function () {
        return null;
      });
    mapCache[moduleUrl] = promise;
    return promise;
  }

  /** The original position of a generated one, or null. */
  function originalPosition(map, line, column) {
    var segs = map && map.lines[line - 1];
    if (!segs || !segs.length) return null;
    var best = segs[0];
    for (var i = 0; i < segs.length && segs[i][0] <= column - 1; i++) best = segs[i];
    var file = map.sources[best[1]];
    return file ? { file: file, line: best[2] + 1 } : null;
  }

  /** React 19's source for `el`, resolved through the source map; null if none. */
  function resolveStackSource(el) {
    var found = stackSource(el);
    if (!found) return Promise.resolve(null);
    var frame = found.frame;
    var mapped = loadMap(frame.url).then(function (map) {
      var pos = originalPosition(map, frame.line, frame.column);
      // Without a map the served file is still right; its line is not.
      return pos ? { file: pos.file, line: pos.line, component: found.component } : { file: frame.path, line: null, component: found.component };
    });
    var timeout = new Promise(function (resolve) {
      setTimeout(function () {
        resolve({ file: frame.path, line: null, component: found.component });
      }, SOURCE_TIMEOUT_MS);
    });
    return Promise.race([mapped, timeout]);
  }

  /** `describe`, with React 19 sources filled in when the sync lookup had no file. */
  function describeWithSource(el) {
    var d = describe(el);
    if (d.source && d.source.file) return Promise.resolve(d);
    return resolveStackSource(el).then(
      function (source) {
        if (source) d.source = { file: source.file, line: source.line, component: source.component || (d.source && d.source.component) || null };
        return d;
      },
      function () {
        return d;
      },
    );
  }

  var STYLE_KEYS = ['display', 'position', 'width', 'height', 'margin', 'padding', 'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border', 'border-radius', 'gap'];

  function openingTag(el) {
    var html = el.outerHTML || '';
    var end = html.indexOf('>');
    return truncate(end >= 0 ? html.slice(0, end + 1) : html, 300);
  }

  function describe(el) {
    var rect = el.getBoundingClientRect();
    var styles = {};
    try {
      var cs = w.getComputedStyle(el);
      STYLE_KEYS.forEach(function (key) {
        var v = cs.getPropertyValue(key);
        if (v) styles[key] = v;
      });
    } catch (_) {
      /* detached */
    }
    var classes = [];
    if (el.classList) for (var i = 0; i < el.classList.length && classes.length < 8; i++) classes.push(el.classList[i]);
    var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: classes,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      text: truncate(text, 160),
      html: openingTag(el),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      styles: styles,
      source: sourceFor(el),
      path: pagePath(),
    };
  }

  // ── Overlay (shadow DOM keeps page styles out) ───────────────────────

  var overlayHost = null;
  var overlayRoot = null;
  var box = null;
  var label = null;
  var pinLayer = null;
  var cursor = null;
  var cursorLabel = null;

  function ensureOverlay() {
    if (overlayHost && overlayHost.isConnected) return;
    overlayHost = doc.createElement('openagentd-overlay');
    overlayHost.setAttribute('style', 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;');
    var root = overlayHost.attachShadow ? overlayHost.attachShadow({ mode: 'open' }) : overlayHost;
    overlayRoot = root;
    var style = doc.createElement('style');
    style.textContent =
      // OpenAgentd Paper tokens: Signal Blue for interaction, Bark for pins.
      '.box{position:fixed;display:none;border:1.5px solid #5AA8E2;background:rgba(90,168,226,.12);border-radius:2px;box-sizing:border-box}' +
      '.label{position:fixed;display:none;font:11px/1.4 ui-monospace,monospace;color:#FFFDF7;background:#174A73;padding:1px 5px;border-radius:3px;white-space:nowrap}' +
      '.pin{position:fixed;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:#3F3429;color:#FFFDF7;font:600 11px/18px system-ui,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.3);transform:translate(-40%,-40%)}' +
      // The agent's cursor: its tip is the element's center.
      '.cursor{position:fixed;left:0;top:0;opacity:0;transition:opacity .2s ease;will-change:transform}' +
      '.cursor.on{opacity:1}' +
      '.cursor svg{display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}' +
      '.cursor-label{position:absolute;left:15px;top:19px;font:600 11px/1.4 system-ui,sans-serif;color:#FFFDF7;background:#174A73;padding:1px 7px;border-radius:9px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.25)}' +
      '.ripple{position:fixed;width:28px;height:28px;margin:-14px 0 0 -14px;box-sizing:border-box;border:2px solid #5AA8E2;border-radius:50%;animation:oad-ripple .4s ease-out forwards}' +
      '@keyframes oad-ripple{from{transform:scale(.3);opacity:.9}to{transform:scale(1.5);opacity:0}}' +
      '@media (prefers-reduced-motion: reduce){.cursor{transition:none!important}.ripple{display:none}}';
    box = doc.createElement('div');
    box.className = 'box';
    label = doc.createElement('div');
    label.className = 'label';
    pinLayer = doc.createElement('div');
    cursor = doc.createElement('div');
    cursor.className = 'cursor';
    cursor.innerHTML =
      '<svg width="18" height="22" viewBox="0 0 18 22" aria-hidden="true"><path d="M1.5 1.5v15.2l4-3.6 2.9 6.6 2.9-1.3-2.9-6.5h5.4z" fill="#5AA8E2" stroke="#FFFDF7" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    cursorLabel = doc.createElement('div');
    cursorLabel.className = 'cursor-label';
    cursor.appendChild(cursorLabel);
    // A new overlay starts without a cursor on screen.
    cursorShown = false;
    root.appendChild(style);
    root.appendChild(box);
    root.appendChild(label);
    root.appendChild(pinLayer);
    root.appendChild(cursor);
    (doc.documentElement || doc.body).appendChild(overlayHost);
  }

  function isOverlay(el) {
    return !!el && el === overlayHost;
  }

  function showBox(el) {
    ensureOverlay();
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    var name = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList && el.classList.length ? '.' + el.classList[0] : '');
    label.textContent = name + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    label.style.display = 'block';
    label.style.left = Math.max(0, r.left) + 'px';
    label.style.top = (r.top > 20 ? r.top - 19 : r.bottom + 2) + 'px';
  }

  function hideBox() {
    if (box) box.style.display = 'none';
    if (label) label.style.display = 'none';
  }

  // ── Agent cursor ──────────────────────────────────────────────────────

  var cursorMoveMs = 320;
  var cursorIdleMs = 4000;
  var cursorShown = false;
  var cursorPos = null;
  var cursorHideTimer = null;

  function reducedMotion() {
    try {
      return !!(w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) {
      return false;
    }
  }

  function placeCursor(x, y) {
    // The arrow's tip sits 1.5px into the SVG.
    cursor.style.transform = 'translate(' + (x - 1.5) + 'px,' + (y - 1.5) + 'px)';
  }

  function hideCursor() {
    cursorHideTimer = null;
    cursorShown = false;
    if (cursor) cursor.classList.remove('on');
  }

  function scheduleCursorHide() {
    if (cursorHideTimer !== null) clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(hideCursor, cursorIdleMs);
  }

  /** Glide the cursor to (x, y) with `text` beside it; resolves on arrival. */
  function moveCursor(x, y, text) {
    ensureOverlay();
    var ms = reducedMotion() ? 0 : cursorMoveMs;
    if (!cursorShown) {
      // Appear where it was last, or mid-screen the first time, then glide.
      var start = cursorPos || { x: w.innerWidth / 2, y: w.innerHeight / 2 };
      cursor.style.transition = 'none';
      placeCursor(start.x, start.y);
      void cursor.offsetWidth;
      cursorShown = true;
    }
    cursor.style.transition = 'transform ' + ms + 'ms cubic-bezier(.2,.7,.3,1), opacity .2s ease';
    cursor.classList.add('on');
    cursorLabel.textContent = text;
    placeCursor(x, y);
    cursorPos = { x: x, y: y };
    scheduleCursorHide();
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function rippleAt(x, y) {
    if (reducedMotion() || !overlayRoot) return;
    var ring = doc.createElement('div');
    ring.className = 'ripple';
    ring.style.left = x + 'px';
    ring.style.top = y + 'px';
    overlayRoot.appendChild(ring);
    setTimeout(function () {
      if (ring.parentNode) ring.parentNode.removeChild(ring);
    }, 450);
  }

  // ── Inspect mode ──────────────────────────────────────────────────────

  var mode = 'browse';

  function targetAt(event) {
    var el = doc.elementFromPoint(event.clientX, event.clientY);
    if (!el || isOverlay(el)) el = event.target;
    return el && el.nodeType === 1 && !isOverlay(el) ? el : null;
  }

  function onMove(event) {
    if (mode !== 'inspect') return;
    var el = targetAt(event);
    if (el) showBox(el);
  }

  function swallow(event) {
    if (mode !== 'inspect' || acting) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }

  function onClick(event) {
    if (mode !== 'inspect' || acting) return;
    swallow(event);
    var el = targetAt(event);
    if (!el) return;
    showBox(el);
    describeWithSource(el).then(function (element) {
      post({ type: 'select', element: element });
    });
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
  }

  var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

  // Key presses in the page never reach the dock. Once the dock sends its
  // keymap (the app's shortcuts), chords the page left alone are forwarded
  // after the page's own handlers, plus unhandled Escape; the dock replays
  // them as if pressed in the app. Before that (an older dock), only the
  // fixed Cmd/Ctrl+W and Alt+C below are forwarded.
  var KEYS_NS = 'openagentd-keys';
  var keymap = null;

  function setKeymap(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.chords)) return;
    keymap = {
      mac: value.mac === true,
      escape: value.escape === true,
      chords: value.chords.filter(function (c) { return c && typeof c.key === 'string'; }).slice(0, 64),
    };
  }

  function keymapHit(event) {
    var primary = keymap.mac ? event.metaKey : event.ctrlKey;
    var other = keymap.mac ? event.ctrlKey : event.metaKey;
    var key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    for (var i = 0; i < keymap.chords.length; i++) {
      var c = keymap.chords[i];
      // A `ctrl` chord is the Control key on every OS (⌃`, ⌃⌥←), with Cmd up.
      if (c.ctrl) {
        if (!event.ctrlKey || event.metaKey) continue;
      } else if (other || primary !== !!c.mod) continue;
      if (event.altKey !== !!c.alt || event.shiftKey !== !!c.shift) continue;
      // Like the dock: chords without Cmd/Ctrl are typing inside a field.
      if (!c.mod && !c.ctrl && isEditable(event.target)) continue;
      if (c.code ? event.code === c.code : key === c.key) return true;
    }
    return false;
  }

  function onKeyForward(event) {
    if (!keymap || event.defaultPrevented || event.isComposing) return;
    var escape = keymap.escape && event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (!escape && !keymapHit(event)) return;
    event.preventDefault();
    try {
      w.parent.postMessage({ ns: KEYS_NS, v: 1, type: 'key', key: event.key, code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey }, '*');
    } catch (_) {
      /* the dock went away */
    }
  }

  // Cmd+W (macOS) / Ctrl+W: without forwarding, the desktop app's native
  // Close Window would close the app.
  function isCloseTab(event) {
    var primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    return primary && !event.altKey && !event.shiftKey && event.code === 'KeyW';
  }

  function onKey(event) {
    if (mode === 'inspect' && event.key === 'Escape') {
      swallow(event);
      setMode('browse');
      post({ type: 'mode', mode: 'browse' });
      return;
    }
    if (keymap) return;
    if (isCloseTab(event)) {
      event.preventDefault();
      event.stopPropagation();
      post({ type: 'shortcut', name: 'close-tab' });
      return;
    }
    // Alt+C (⌥C) toggles Design picking in the dock, even while focus is in the page.
    if (event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyC' && !isEditable(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      post({ type: 'shortcut', name: 'toggle-design' });
    }
  }

  function setMode(next) {
    mode = next === 'inspect' ? 'inspect' : 'browse';
    if (doc.documentElement) doc.documentElement.style.cursor = mode === 'inspect' ? 'crosshair' : '';
    if (mode !== 'inspect') hideBox();
  }

  w.addEventListener('mousemove', onMove, true);
  w.addEventListener('click', onClick, true);
  ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'submit'].forEach(function (type) {
    w.addEventListener(type, swallow, true);
  });
  w.addEventListener('keydown', onKey, true);
  // Bubble phase: the page's own handlers run first.
  w.addEventListener('keydown', onKeyForward);

  // ── Pins ──────────────────────────────────────────────────────────────

  var pins = [];
  var pinTimer = null;

  function renderPins() {
    if (!pins.length) {
      if (pinLayer) pinLayer.textContent = '';
      return;
    }
    ensureOverlay();
    pinLayer.textContent = '';
    pins.forEach(function (pin) {
      var el = null;
      try {
        el = doc.querySelector(pin.selector);
      } catch (_) {
        el = null;
      }
      if (!el) return;
      var r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > w.innerHeight) return;
      var dot = doc.createElement('div');
      dot.className = 'pin';
      dot.textContent = String(pin.n);
      dot.style.left = r.left + 'px';
      dot.style.top = r.top + 'px';
      pinLayer.appendChild(dot);
    });
  }

  function setPins(next) {
    pins = Array.isArray(next)
      ? next.filter(function (p) {
          return p && typeof p.selector === 'string' && (typeof p.n === 'number' || typeof p.n === 'string');
        })
      : [];
    renderPins();
    if (pins.length && pinTimer === null) pinTimer = setInterval(renderPins, 300);
    if (!pins.length && pinTimer !== null) {
      clearInterval(pinTimer);
      pinTimer = null;
    }
  }

  w.addEventListener('scroll', renderPins, { capture: true, passive: true });
  w.addEventListener('resize', renderPins);

  // ── Navigation ────────────────────────────────────────────────────────

  ['pushState', 'replaceState'].forEach(function (name) {
    var original = w.history && w.history[name];
    if (typeof original !== 'function') return;
    w.history[name] = function () {
      var result = original.apply(this, arguments);
      reportLocation('location');
      return result;
    };
  });
  w.addEventListener('popstate', function () {
    reportLocation('location');
  });
  w.addEventListener('hashchange', function () {
    reportLocation('location');
  });

  // Names this document: the same on every `ready` it sends (the reply to
  // `hello` too), so the dock tells a new page from the same one answering.
  var DOC_ID = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  function sendReady() {
    var down = !!doc.querySelector('meta[name="openagentd-preview"][content="upstream-down"]');
    post({ type: 'ready', path: pagePath(), title: doc.title || '', status: down ? 'down' : 'ok', doc: DOC_ID });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', sendReady);
  else sendReady();
  w.addEventListener('load', function () {
    reportLocation('location');
  });
  // A full navigation is starting: the dock shows it loading until the next page's `load`.
  w.addEventListener('beforeunload', function () {
    post({ type: 'leaving' });
  });

  // ── Agent commands ────────────────────────────────────────────────────

  var MAX_SNAPSHOT_CHARS = 12000;
  var MAX_SNAPSHOT_LINES = 400;
  var MAX_WAIT_MS = 10000;
  // True while the agent's synthetic events run, so inspect mode lets them through.
  var acting = false;
  // Elements named by the last snapshot: refs[0] is e1.
  var refs = [];
  // A reply not yet posted; sent at once if the page unloads first.
  var pendingReply = null;

  var INTERACTIVE_ROLES = ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton'];

  function clean(s, max) {
    return truncate(String(s || '').replace(/\s+/g, ' ').trim(), max);
  }

  // Hidden subtrees are skipped. Box size is not checked: display:contents
  // wrappers have no box, and visually hidden controls still work.
  function isVisible(el) {
    if (isOverlay(el)) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    var cs;
    try {
      cs = w.getComputedStyle(el);
    } catch (_) {
      return false;
    }
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
  }

  function isInteractive(el) {
    var tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href');
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
    if (tag === 'INPUT') return (el.getAttribute('type') || '').toLowerCase() !== 'hidden';
    var role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.indexOf(role) >= 0) return true;
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return true;
    var tabindex = el.getAttribute('tabindex');
    return tabindex !== null && Number(tabindex) >= 0;
  }

  function accessibleName(el) {
    var label = el.getAttribute('aria-label');
    if (label) return clean(label, 100);
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var ref = doc.getElementById(by.split(/\s+/)[0]);
      if (ref) return clean(ref.textContent, 100);
    }
    if (el.labels && el.labels.length) return clean(el.labels[0].textContent, 100);
    if (el.tagName === 'IMG') return clean(el.getAttribute('alt'), 100);
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      return clean(el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name'), 100);
    }
    var text = clean(el.innerText || el.textContent, 100);
    if (text) return text;
    return clean(el.getAttribute('title') || el.getAttribute('placeholder'), 100);
  }

  function kindOf(el) {
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role');
    if (role) return role;
    if (tag === 'a') return 'link';
    if (tag === 'input') return 'input[' + ((el.getAttribute('type') || 'text').toLowerCase()) + ']';
    return tag;
  }

  function offscreen(el) {
    var r = el.getBoundingClientRect();
    return r.bottom < 0 || r.top > w.innerHeight || r.right < 0 || r.left > w.innerWidth;
  }

  function refLine(el) {
    refs.push(el);
    var parts = ['[e' + refs.length + ']', kindOf(el)];
    var name = accessibleName(el);
    if (name) parts.push(JSON.stringify(name));
    var tag = el.tagName;
    if (tag === 'A') {
      var href = el.getAttribute('href') || '';
      if (href) parts.push('-> ' + truncate(href, 120));
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') parts.push(el.checked ? 'checked' : 'unchecked');
      else if (type !== 'password' && el.value) parts.push('value=' + JSON.stringify(truncate(el.value, 100)));
      else if (type === 'password' && el.value) parts.push('value=(hidden)');
      var ph = el.getAttribute('placeholder');
      if (ph && name !== clean(ph, 100)) parts.push('placeholder=' + JSON.stringify(clean(ph, 60)));
    }
    if (tag === 'SELECT') {
      var opts = [];
      for (var i = 0; i < el.options.length && i < 12; i++) opts.push(JSON.stringify(clean(el.options[i].textContent, 40)));
      if (el.options.length > 12) opts.push('…');
      parts.push('options=[' + opts.join(', ') + ']');
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    var expanded = el.getAttribute('aria-expanded');
    if (expanded) parts.push('expanded=' + expanded);
    if (offscreen(el)) parts.push('(offscreen)');
    return parts.join(' ');
  }

  var TEXT_TAGS = ['P', 'LI', 'TD', 'TH', 'LABEL', 'DT', 'DD', 'FIGCAPTION', 'BLOCKQUOTE', 'CAPTION', 'LEGEND', 'PRE'];
  var NESTED = 'a[href],button,input,select,textarea,summary,[role],[contenteditable],[tabindex],h1,h2,h3,h4,h5,h6,p,li,img';

  function directText(el) {
    var out = '';
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) out += n.nodeValue;
    return out.replace(/\s+/g, ' ').trim();
  }

  /** A text outline of the page with refs on interactive elements. */
  function snapshot(root) {
    refs = [];
    var lines = [];
    var truncated = false;
    function add(line) {
      if (lines.length >= MAX_SNAPSHOT_LINES) {
        truncated = true;
        return false;
      }
      lines.push(line);
      return true;
    }
    function walk(el) {
      if (truncated || !el || el.nodeType !== 1) return;
      var tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG' || tag === 'svg') return;
      if (!isVisible(el)) return;
      if (isInteractive(el)) {
        add(refLine(el));
        // The line already covers the control's text (and a select's options).
        return;
      }
      if (/^H[1-6]$/.test(tag)) {
        var h = clean(el.innerText || el.textContent, 160);
        if (h) add('heading(' + tag.charAt(1) + ') ' + JSON.stringify(h));
        return;
      }
      if (tag === 'IMG') {
        var alt = clean(el.getAttribute('alt'), 100);
        add('img' + (alt ? ' ' + JSON.stringify(alt) : ''));
        return;
      }
      if (tag === 'OPTION') return;
      var own = directText(el);
      if ((own || TEXT_TAGS.indexOf(tag) >= 0) && !el.querySelector(NESTED)) {
        // A run of text, including inline children such as <b> or <span>.
        var t = clean(el.innerText || el.textContent, 200);
        if (t) add('text ' + JSON.stringify(t));
        return;
      }
      if (own) add('text ' + JSON.stringify(truncate(own, 200)));
      var children = el.children;
      for (var i = 0; i < children.length; i++) walk(children[i]);
    }
    walk(root);
    var scrollMax = Math.max(0, (doc.documentElement ? doc.documentElement.scrollHeight : 0) - w.innerHeight);
    var header = [
      'Page: ' + pagePath() + (doc.title ? ' — ' + JSON.stringify(doc.title) : ''),
      'Viewport ' + w.innerWidth + '×' + w.innerHeight + ', scrolled ' + Math.round(w.scrollY || 0) + ' of ' + Math.round(scrollMax) + 'px',
      '',
    ];
    var text = header.concat(lines).join('\n');
    if (truncated || text.length > MAX_SNAPSHOT_CHARS) {
      text = truncate(text, MAX_SNAPSHOT_CHARS) + '\n… (truncated; pass a selector to snapshot part of the page)';
    }
    return text;
  }

  function targetOf(cmd) {
    if (typeof cmd.ref === 'string' && cmd.ref) {
      var n = parseInt(cmd.ref.replace(/^e/, ''), 10);
      var el = n >= 1 ? refs[n - 1] : null;
      if (!el) throw new Error('No element ' + cmd.ref + ' in the last snapshot; take a new snapshot.');
      if (!el.isConnected) throw new Error('Element ' + cmd.ref + ' is no longer on the page; take a new snapshot.');
      return el;
    }
    if (typeof cmd.selector === 'string' && cmd.selector) {
      var found;
      try {
        found = doc.querySelector(cmd.selector);
      } catch (_) {
        throw new Error('Invalid selector: ' + cmd.selector);
      }
      if (!found) throw new Error('No element matches ' + cmd.selector + '.');
      return found;
    }
    throw new Error('Give a ref from the last snapshot or a selector.');
  }

  function named(el) {
    var name = accessibleName(el);
    return '<' + el.tagName.toLowerCase() + '>' + (name ? ' ' + JSON.stringify(name) : '');
  }

  var flashTimer = null;
  function flash(el) {
    try {
      showBox(el);
    } catch (_) {
      return;
    }
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      flashTimer = null;
      if (mode !== 'inspect') hideBox();
    }, 900);
  }

  function reveal(el) {
    if (el.scrollIntoView) {
      try {
        el.scrollIntoView({ block: 'center', inline: 'center' });
      } catch (_) {
        el.scrollIntoView();
      }
    }
    flash(el);
  }

  function center(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function mouse(el, type) {
    var c = center(el);
    var init = { bubbles: true, cancelable: true, composed: true, view: w, clientX: c.x, clientY: c.y, button: 0 };
    var Ctor = type.indexOf('pointer') === 0 && w.PointerEvent ? w.PointerEvent : w.MouseEvent;
    el.dispatchEvent(new Ctor(type, init));
  }

  /** Bring `el` into view and glide the cursor to it; resolves on arrival. */
  function approach(el, text) {
    reveal(el);
    var c = center(el);
    return moveCursor(c.x, c.y, text);
  }

  // Synthetic events after the glide must still get past inspect mode.
  function withActing(fn) {
    acting = true;
    try {
      return fn();
    } finally {
      acting = false;
    }
  }

  /** Run `act(el)` once the cursor reaches `el`; resolves to { text }. */
  function onElement(el, text, act) {
    return approach(el, text).then(function () {
      return { text: withActing(function () {
        return act(el);
      }) };
    });
  }

  function actClick(el) {
    if (el.disabled) throw new Error(named(el) + ' is disabled.');
    var c = center(el);
    rippleAt(c.x, c.y);
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) {
      mouse(el, t);
    });
    if (el.focus) el.focus();
    el.click();
    return 'Clicked ' + named(el) + '.';
  }

  function setNativeValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? w.HTMLSelectElement.prototype : w.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    // The prototype setter bypasses React's value tracker, so onChange fires.
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function actFill(el, value) {
    if (el.disabled || el.readOnly) throw new Error(named(el) + ' is not editable.');
    var tag = el.tagName;
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (el.focus) el.focus();
    if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
      var want = !/^(false|0|off|no|unchecked)$/i.test(value);
      if (el.checked !== want) el.click();
      return (want ? 'Checked ' : 'Unchecked ') + named(el) + '.';
    }
    if (tag === 'SELECT') {
      var match = null;
      for (var i = 0; i < el.options.length; i++) {
        var o = el.options[i];
        if (o.value === value || clean(o.textContent, 200) === value) {
          match = o;
          break;
        }
      }
      if (!match) throw new Error('No option ' + JSON.stringify(value) + ' in ' + named(el) + '.');
      setNativeValue(el, match.value);
    } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
      setNativeValue(el, value);
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else {
      throw new Error(named(el) + ' is not a form field.');
    }
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    el.dispatchEvent(new w.Event('change', { bubbles: true }));
    return 'Filled ' + named(el) + ' with ' + JSON.stringify(type === 'password' ? '(hidden)' : truncate(value, 100)) + '.';
  }

  function actPress(el, key) {
    if (el !== doc.body) flash(el);
    var init = { key: key, bubbles: true, cancelable: true, composed: true };
    if (key.length === 1) init.code = 'Key' + key.toUpperCase();
    var down = el.dispatchEvent(new w.KeyboardEvent('keydown', init));
    el.dispatchEvent(new w.KeyboardEvent('keyup', init));
    // Synthetic key events have no default action; do the common ones.
    if (down && key === 'Enter') {
      if (el.tagName === 'INPUT' && el.form) {
        if (el.form.requestSubmit) el.form.requestSubmit();
        else el.form.submit();
      } else if (el.tagName === 'BUTTON' || el.tagName === 'A') {
        el.click();
      }
    }
    return 'Pressed ' + key + (el === doc.body ? '' : ' on ' + named(el)) + '.';
  }

  function actScroll(cmd) {
    var dy = typeof cmd.dy === 'number' ? cmd.dy : w.innerHeight * 0.8;
    if (cmd.to === 'top') w.scrollTo(0, 0);
    else if (cmd.to === 'bottom') w.scrollTo(0, doc.documentElement ? doc.documentElement.scrollHeight : 0);
    else w.scrollBy(0, dy);
    return 'Scrolled to ' + Math.round(w.scrollY || 0) + 'px.';
  }

  function actNavigate(to) {
    if (to === 'back' || to === 'forward' || to === 'reload') {
      setTimeout(function () {
        if (to === 'back') w.history.back();
        else if (to === 'forward') w.history.forward();
        else w.location.reload();
      }, 0);
      return to === 'reload' ? 'Reloading.' : 'Going ' + to + '.';
    }
    var url;
    try {
      url = new URL(to, w.location.href);
    } catch (_) {
      throw new Error('Invalid address: ' + to);
    }
    if (url.origin !== w.location.origin) throw new Error('Navigate only within the preview (a path such as /pricing).');
    setTimeout(function () {
      w.location.assign(url.pathname + url.search + url.hash);
    }, 0);
    return 'Navigating to ' + url.pathname + url.search + url.hash + '.';
  }

  function actWait(cmd) {
    var limit = Math.min(Math.max(Number(cmd.timeout_ms) || 5000, 0), MAX_WAIT_MS);
    var text = typeof cmd.text === 'string' ? cmd.text : '';
    var selector = typeof cmd.selector === 'string' ? cmd.selector : '';
    var gone = !!cmd.gone;
    if (!text && !selector) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve('Waited ' + limit + ' ms.');
        }, limit);
      });
    }
    function met() {
      var present;
      if (selector) {
        try {
          present = !!doc.querySelector(selector);
        } catch (_) {
          throw new Error('Invalid selector: ' + selector);
        }
      } else {
        present = (doc.body ? doc.body.innerText || doc.body.textContent || '' : '').indexOf(text) >= 0;
      }
      return gone ? !present : present;
    }
    var what = (selector ? selector : JSON.stringify(text)) + (gone ? ' to disappear' : '');
    var start = Date.now();
    return new Promise(function (resolve, reject) {
      (function check() {
        try {
          if (met()) return resolve('Found ' + what + ' after ' + (Date.now() - start) + ' ms.');
        } catch (e) {
          return reject(e);
        }
        if (Date.now() - start >= limit) return reject(new Error('Timed out after ' + limit + ' ms waiting for ' + what + '.'));
        setTimeout(check, 100);
      })();
    });
  }

  function actInspect(el) {
    return describeWithSource(el).then(function (d) {
      d.outerHTML = truncate(el.outerHTML || '', 4000);
      return d;
    });
  }

  function execute(cmd) {
    var action = cmd.action;
    post({ type: 'agent', action: action });
    switch (action) {
      case 'snapshot': {
        var root = cmd.selector ? targetOf({ selector: cmd.selector }) : doc.body || doc.documentElement;
        return { text: snapshot(root) };
      }
      case 'click':
        return onElement(targetOf(cmd), 'Clicking', actClick);
      case 'fill':
        if (typeof cmd.value !== 'string') throw new Error('fill needs a value.');
        return onElement(targetOf(cmd), 'Typing', function (el) {
          return actFill(el, cmd.value);
        });
      case 'press':
        if (typeof cmd.key !== 'string' || !cmd.key) throw new Error('press needs a key, such as Enter or Escape.');
        if (cmd.ref || cmd.selector) {
          return onElement(targetOf(cmd), 'Pressing ' + truncate(cmd.key, 20), function (el) {
            return actPress(el, cmd.key);
          });
        }
        return { text: actPress(doc.activeElement || doc.body, cmd.key) };
      case 'scroll':
        if (cmd.ref || cmd.selector) {
          return onElement(targetOf(cmd), 'Scrolling', function (el) {
            return 'Scrolled ' + named(el) + ' into view.';
          });
        }
        return { text: actScroll(cmd) };
      case 'navigate':
        if (typeof cmd.to !== 'string' || !cmd.to) throw new Error('navigate needs a path, or back, forward, or reload.');
        return { text: actNavigate(cmd.to) };
      case 'wait':
        return actWait(cmd).then(function (text) {
          return { text: text };
        });
      case 'inspect': {
        var inspected = targetOf(cmd);
        return approach(inspected, 'Inspecting').then(function () {
          return actInspect(inspected);
        }).then(function (element) {
          return { element: element };
        });
      }
      default:
        throw new Error('Unknown action ' + action + '.');
    }
  }

  function sendReply(reply) {
    if (!originalFetch) return;
    var body = JSON.stringify(reply);
    try {
      // keepalive lets the result through a navigation the command started;
      // browsers cap keepalive bodies at 64 KB.
      originalFetch(AGENT_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, keepalive: body.length < 60000 }).catch(function () {});
    } catch (_) {
      /* ignore */
    }
  }

  function flushReply() {
    if (!pendingReply) return;
    var reply = pendingReply;
    pendingReply = null;
    sendReply(reply);
  }

  function runCommand(envelope) {
    var id = envelope && envelope.id;
    var cmd = (envelope && envelope.command) || {};
    if (typeof id !== 'string') return Promise.resolve();
    return new Promise(function (resolve) {
      acting = true;
      var result;
      try {
        result = execute(cmd);
      } catch (e) {
        result = Promise.reject(e);
      }
      acting = false;
      Promise.resolve(result).then(
        function (value) {
          // Let the page react (re-render, route change) before reporting.
          pendingReply = { id: id, ok: true, result: value };
          setTimeout(function () {
            if (pendingReply && value && typeof value.text === 'string' && cmd.action !== 'snapshot' && cmd.action !== 'wait') {
              pendingReply.result = { text: value.text + ' Page is now ' + pagePath() + '.' };
            }
            flushReply();
            resolve();
          }, cmd.action === 'snapshot' || cmd.action === 'inspect' ? 0 : 250);
        },
        function (error) {
          sendReply({ id: id, ok: false, error: error && error.message ? String(error.message) : String(error) });
          resolve();
        },
      );
    });
  }

  w.addEventListener('pagehide', flushReply);

  function pollAgent() {
    if (!originalFetch) return;
    var started = Date.now();
    originalFetch(AGENT_PATH, { cache: 'no-store' })
      .then(function (res) {
        if (res.status === 200) {
          return res.json().then(function (envelope) {
            return runCommand(envelope).then(function () {
              return 0;
            });
          });
        }
        // 204: nothing this time. Anything else (an older backend): back off.
        return res.status === 204 ? 0 : 10000;
      })
      .catch(function () {
        return 3000;
      })
      .then(function (delay) {
        // A poll that returns at once must not spin.
        var wait = Math.max(delay, Date.now() - started < 1000 ? 1000 : 0);
        setTimeout(pollAgent, wait);
      });
  }

  pollAgent();

  // ── Commands from the dock ────────────────────────────────────────────

  w.addEventListener('message', function (event) {
    if (event.source !== w.parent) return;
    var data = event.data;
    if (!data || data.ns !== NS || data.v !== VERSION) return;
    switch (data.type) {
      case 'hello':
        sendReady();
        break;
      case 'set-mode':
        setMode(data.mode);
        break;
      case 'pins':
        setPins(data.pins);
        break;
      case 'reload':
        w.location.reload();
        break;
      case 'navigate':
        if (typeof data.path === 'string' && data.path.charAt(0) === '/' && data.path.charAt(1) !== '/') w.location.assign(data.path);
        break;
      case 'history':
        if (data.dir === -1) w.history.back();
        else if (data.dir === 1) w.history.forward();
        break;
      case 'keymap':
        setKeymap(data.keymap);
        break;
    }
  });

  // Test hook: Happy DOM tests drive the runtime through these.
  w.__openagentdPreviewInternals = {
    selectorFor: selectorFor,
    describe: describe,
    flush: flush,
    setMode: setMode,
    setPins: setPins,
    getMode: function () { return mode; },
    runCommand: runCommand,
    cursorState: function () {
      return { visible: cursorShown, x: cursorPos ? cursorPos.x : null, y: cursorPos ? cursorPos.y : null, label: cursorLabel ? cursorLabel.textContent : '' };
    },
    setCursorTiming: function (timing) {
      if (timing && typeof timing.move === 'number') cursorMoveMs = timing.move;
      if (timing && typeof timing.idle === 'number') cursorIdleMs = timing.idle;
    },
  };
})();
