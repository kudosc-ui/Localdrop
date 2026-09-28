// clipboard.js — Clipboard API access with graceful, honest fallbacks.
//
// Browsers do NOT provide a "clipboard changed" event, and most browsers block
// silent background reading of the clipboard for privacy reasons. So "automatic"
// sync here means: read the clipboard at well-defined, permitted moments
// (the user tapped Sync, or the tab just regained focus AND permission was
// already granted) — never silent polling in the background. When that is not
// permitted, we fall back to manual Paste & Sync. This module never pretends
// otherwise.

const LocalDropClipboard = (() => {
  let permissionState = 'unknown'; // 'granted' | 'denied' | 'prompt' | 'unsupported' | 'unknown'
  let lastReadText = null;

  const isSupported = () => !!(navigator.clipboard && navigator.clipboard.readText);

  async function refreshPermissionState() {
    if (!isSupported()) {
      permissionState = 'unsupported';
      return permissionState;
    }
    if (!navigator.permissions || !navigator.permissions.query) {
      // Permissions API for clipboard isn't available in every browser (e.g. Firefox,
      // Safari). We can't know ahead of time — we'll find out on first read attempt.
      permissionState = 'unknown';
      return permissionState;
    }
    try {
      const status = await navigator.permissions.query({ name: 'clipboard-read' });
      permissionState = status.state; // 'granted' | 'denied' | 'prompt'
      status.onchange = () => { permissionState = status.state; };
      return permissionState;
    } catch {
      permissionState = 'unknown';
      return permissionState;
    }
  }

  async function readText() {
    if (!isSupported()) {
      return { ok: false, reason: 'unsupported', text: null };
    }
    try {
      const text = await navigator.clipboard.readText();
      lastReadText = text;
      return { ok: true, text };
    } catch (err) {
      const reason = err && err.name === 'NotAllowedError' ? 'denied' : 'error';
      return { ok: false, reason, text: null, error: err };
    }
  }

  async function writeText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return { ok: true };
      } catch (err) {
        // fall through to legacy fallback below
      }
    }
    // Legacy fallback for very old/embedded browsers without Clipboard API write support.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const done = document.execCommand('copy');
      document.body.removeChild(ta);
      return done ? { ok: true } : { ok: false };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  // ---- Two-way OS clipboard sync ----
  // lastSynced = the last text we sent OR wrote, so nothing echoes back and forth.
  let lastSynced = null, pending = null, baselined = false, onPendingApplied = null;

  // Incoming text from another device -> the real clipboard of THIS device.
  // Browsers only allow writes while the page is focused / after a tap, so if it
  // is refused we keep it pending and write it on the very next tap, key or focus.
  async function applyRemote(text) {
    lastSynced = text;
    const r = await writeText(text);
    pending = r.ok ? null : text;
    return r.ok;
  }
  function flushPending() {
    if (pending === null) return;
    const t = pending;
    writeText(t).then((r) => { if (r.ok && pending === t) { pending = null; onPendingApplied && onPendingApplied(); } });
  }
  ['pointerdown', 'keydown', 'touchstart', 'focus'].forEach((ev) => window.addEventListener(ev, flushPending, true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flushPending(); });

  // Outgoing: watch this device's clipboard while the app is open and focused.
  function startWatcher(onChange) {
    const check = async () => {
      if (document.hidden || !document.hasFocus() || !isSupported()) return;
      if (permissionState !== 'granted') { await refreshPermissionState(); if (permissionState !== 'granted') return; }
      const r = await readText();
      if (!r.ok || !r.text) return;
      if (!baselined) { baselined = true; lastSynced = r.text; return; } // ignore what was copied before we started
      if (r.text === lastSynced) return;
      lastSynced = r.text;
      onChange(r.text);
    };
    setInterval(check, 1000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    ['copy', 'cut'].forEach((ev) => document.addEventListener(ev, () => setTimeout(check, 60)));
    // First tap asks for clipboard-read permission once (browsers require a gesture-time prompt).
    const ask = async () => {
      window.removeEventListener('pointerdown', ask, true);
      await refreshPermissionState();
      if (permissionState === 'prompt' || permissionState === 'unknown') await readText();
      check();
    };
    window.addEventListener('pointerdown', ask, true);
    check();
  }

  return {
    applyRemote, startWatcher, markSynced: (t) => { lastSynced = t; },
    hasPending: () => pending !== null, onPendingApplied: (fn) => { onPendingApplied = fn; },
    isSupported,
    refreshPermissionState,
    readText,
    writeText,
    getPermissionState: () => permissionState,
    getLastReadText: () => lastReadText,
    setLastReadText: (t) => { lastReadText = t; },
  };
})();

window.LocalDropClipboard = LocalDropClipboard;
