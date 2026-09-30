// LocalDrop (c) 2026 CodeZing. All rights reserved. Proprietary — see LICENSE.
// transfer.js — chunked file transfer riding on devices.js's existing transports.
// Chunks are base64-encoded inside JSON messages so the exact same code path
// works whether the peer is a real WebRTC data channel or a Demo Mode tab.
// That's simpler than a binary-only fast path, at some throughput cost — fine
// for the file sizes this app targets (docs, images, zips, video clips).

const LocalDropTransfer = (() => {
  const bus = new EventTarget();
  const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

  const CHUNK_SIZE = 48 * 1024; // raw bytes per chunk before base64 (~64KB on the wire)

  const outgoing = new Map(); // transferId -> { cancelled }
  const incoming = new Map(); // transferId -> { meta, chunks: [], receivedCount }

  function arrayBufferToBase64(buf) {
    let binary = '';
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function base64ToUint8Array(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function sendFile(file, targetPeerId = 'all') {
    const transferId = window.LocalDropStorage.uuid();
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    const identity = window.LocalDropDevices.identity;
    outgoing.set(transferId, { cancelled: false });

    window.LocalDropDevices.sendFileMessage(targetPeerId, {
      kind: 'file-meta', transferId, name: file.name, mimeType: file.type || 'application/octet-stream',
      size: file.size, totalChunks, originDeviceId: identity.id, originDeviceName: identity.name, timestamp: Date.now(),
    });

    for (let index = 0; index < totalChunks; index++) {
      if (outgoing.get(transferId)?.cancelled) {
        emit('send-cancelled', { transferId, name: file.name });
        return;
      }
      const start = index * CHUNK_SIZE;
      const slice = file.slice(start, start + CHUNK_SIZE);
      const buf = await slice.arrayBuffer();
      const data = arrayBufferToBase64(buf);
      window.LocalDropDevices.sendFileMessage(targetPeerId, { kind: 'file-chunk', transferId, index, data });
      emit('send-progress', { transferId, name: file.name, size: file.size, sent: start + buf.byteLength, index, totalChunks });
      // Yield to the event loop so large files don't freeze the UI.
      await new Promise((r) => setTimeout(r, 0));
    }

    window.LocalDropDevices.sendFileMessage(targetPeerId, { kind: 'file-complete', transferId });
    outgoing.delete(transferId);
    emit('send-complete', { transferId, name: file.name });
  }

  function cancelSend(transferId) {
    const t = outgoing.get(transferId);
    if (t) t.cancelled = true;
  }

  function handleIncomingMessage(data) {
    if (data.kind === 'file-meta') {
      incoming.set(data.transferId, {
        meta: data, chunks: new Array(data.totalChunks), receivedCount: 0,
      });
      emit('receive-start', { transferId: data.transferId, name: data.name, size: data.size, originDeviceName: data.originDeviceName });
      return;
    }
    if (data.kind === 'file-chunk') {
      const t = incoming.get(data.transferId);
      if (!t) return; // meta arrived out of order or transfer unknown — drop silently
      const bytes = base64ToUint8Array(data.data);
      t.chunks[data.index] = bytes;
      t.receivedCount++;
      const receivedBytes = t.chunks.filter(Boolean).reduce((sum, c) => sum + c.length, 0);
      emit('receive-progress', {
        transferId: data.transferId, name: t.meta.name, size: t.meta.size,
        received: receivedBytes, totalChunks: t.meta.totalChunks, receivedChunks: t.receivedCount,
      });
      return;
    }
    if (data.kind === 'file-complete') {
      const t = incoming.get(data.transferId);
      if (!t) return;
      const blob = new Blob(t.chunks, { type: t.meta.mimeType });
      const fileId = window.LocalDropStorage.uuid();
      window.LocalDropStorage.saveFileBlob({
        id: fileId, name: t.meta.name, mimeType: t.meta.mimeType, blob,
        originDeviceId: t.meta.originDeviceId, originDeviceName: t.meta.originDeviceName,
      }).then(() => {
        emit('receive-complete', { fileId, name: t.meta.name, size: t.meta.size, originDeviceName: t.meta.originDeviceName });
      });
      incoming.delete(data.transferId);
    }
  }

  window.LocalDropDevices.on('file-message', (ev) => handleIncomingMessage(ev.detail));

  return { bus, on: (n, f) => bus.addEventListener(n, f), sendFile, cancelSend };
})();

window.LocalDropTransfer = LocalDropTransfer;
