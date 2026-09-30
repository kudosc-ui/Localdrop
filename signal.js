// signal.js - one-code pairing. The code never leaves the two devices: it is
// stretched with PBKDF2 into (a) a random-looking relay room name and (b) an
// AES-GCM key. Only encrypted handshake blobs pass through the public relay
// (ntfy.sh); after that, all data flows directly device-to-device over WebRTC.
const LocalDropSignal = (() => {
  const RELAY = 'https://ntfy.sh/';
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (u) => btoa(String.fromCharCode(...u));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const hex = (u) => [...u].map((x) => x.toString(16).padStart(2, '0')).join('');

  function newCode() {
    let out = '';
    while (out.length < 8) for (const b of crypto.getRandomValues(new Uint8Array(16))) if (b < 248 && out.length < 8) out += ALPHA[b % 31];
    return out;
  }
  const normalize = (c) => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pretty = (c) => c.slice(0, 4) + '-' + c.slice(4);

  async function derive(code) {
    const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('localdrop-pair-v2'), iterations: 250000 }, base, 384));
    const key = await crypto.subtle.importKey('raw', bits.slice(16, 48), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { room: 'ld' + hex(bits.slice(0, 16)), key };
  }
  async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
    const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
    return b64(all);
  }
  async function open(key, s) {
    const all = unb64(s);
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, key, all.slice(12))));
  }
  async function send(room, key, obj) {
    const r = await fetch(RELAY + room, { method: 'POST', body: await seal(key, obj) });
    if (!r.ok) throw new Error('Relay unreachable');
  }
  function listen(room, key, onMsg) {
    const es = new EventSource(RELAY + room + '/sse?since=all');
    es.onmessage = async (e) => {
      try { const j = JSON.parse(e.data); if (j.event === 'message') onMsg(await open(key, j.message)); } catch { /* not ours / tampered: ignore */ }
    };
    return () => es.close();
  }

  // Device A: show a code, wait for B.
  async function host() {
    const code = newCode();
    const { room, key } = await derive(code);
    const { text } = await window.LocalDropDevices.createOfferPackage();
    let stop = () => {}, used = false;
    stop = listen(room, key, async (m) => {
      if (m.t !== 'answer' || used) return;
      used = true;
      try { await window.LocalDropDevices.completeWithAnswer(m.p); stop(); } catch { used = false; }
    });
    await send(room, key, { t: 'offer', p: text });
    const timer = setTimeout(stop, 5 * 60 * 1000);
    return { code, display: pretty(code), cancel: () => { clearTimeout(timer); stop(); } };
  }

  // Device B: type/scan the code.
  async function join(raw) {
    const code = normalize(raw);
    if (code.length !== 8) throw new Error('Codes have 8 letters/numbers');
    const { room, key } = await derive(code);
    return new Promise((resolve, reject) => {
      let stop = () => {}, handled = false;
      const timer = setTimeout(() => { stop(); reject(new Error('Code not found or expired')); }, 20000);
      stop = listen(room, key, async (m) => {
        if (m.t !== 'offer' || handled) return;
        handled = true; clearTimeout(timer); stop();
        try {
          const { text, remoteDeviceName } = await window.LocalDropDevices.acceptOfferPackage(m.p);
          await send(room, key, { t: 'answer', p: text });
          resolve(remoteDeviceName);
        } catch (e) { reject(e); }
      });
    });
  }
  return { host, join, normalize };
})();
window.LocalDropSignal = LocalDropSignal;
