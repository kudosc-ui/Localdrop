// pairing.js — QR code generation/scanning for the WebRTC handshake, plus the
// "Manual Code" text-relay fallback for when a camera isn't available or two
// devices aren't within scanning distance. Uses the vendored qrcode.js / jsQR.js
// (assets/vendor) — no CDN calls at runtime.

const LocalDropPairing = (() => {
  let scanStream = null;
  let scanRAF = null;

  async function renderQR(canvasEl, text) {
    // Offer/answer SDP blobs are small (we don't gather STUN/relay candidates —
    // see devices.js), so this comfortably fits in a scannable QR code.
    await QRCode.toCanvas(canvasEl, text, {
      errorCorrectionLevel: 'L',
      margin: 1,
      width: 260,
      color: { dark: '#e8ecf5', light: '#00000000' },
    });
  }

  async function startScan(videoEl, onDecoded, onError) {
    stopScan();
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (err) {
      onError && onError(err);
      return;
    }
    videoEl.srcObject = scanStream;
    await videoEl.play();

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = () => {
      if (!scanStream) return;
      if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
          onDecoded(code.data);
          return; // stop after first successful decode
        }
      }
      scanRAF = requestAnimationFrame(tick);
    };
    scanRAF = requestAnimationFrame(tick);
  }

  function stopScan() {
    if (scanRAF) cancelAnimationFrame(scanRAF);
    scanRAF = null;
    if (scanStream) {
      scanStream.getTracks().forEach((t) => t.stop());
      scanStream = null;
    }
  }

  // ---- Manual Code fallback: same offer/answer JSON, base64'd and grouped for
  // readability, copy/pasted (or read aloud / sent via any messaging app) between
  // devices instead of scanned. It is honestly longer than a 6-digit code because
  // it carries a real cryptographic handshake, not a lookup key on a server we
  // don't have — see Help for why.
  function toManualCode(jsonText) {
    const b64 = btoa(unescape(encodeURIComponent(jsonText)));
    return b64.match(/.{1,6}/g).join(' ');
  }

  function fromManualCode(code) {
    const b64 = code.replace(/\s+/g, '');
    return decodeURIComponent(escape(atob(b64)));
  }

  return { renderQR, startScan, stopScan, toManualCode, fromManualCode };
})();

window.LocalDropPairing = LocalDropPairing;
