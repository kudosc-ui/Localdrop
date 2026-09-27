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
      document.execCommand('copy');
      document.body.removeChild(ta);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  return {
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
