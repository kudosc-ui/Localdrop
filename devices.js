// LocalDrop (c) 2026 CodeZing. All rights reserved. Proprietary — see LICENSE.
// devices.js — device identity, transports (Demo/BroadcastChannel + real WebRTC),
// and the clipboard-update relay with loop prevention.
//
// Two transports are implemented, both honest about what they actually do:
//
//   "demo"   — uses BroadcastChannel. This only reaches other TABS/WINDOWS of
//              this same browser on this same device. It's real and useful for
//              developers testing multi-device flows (see Settings > Demo Mode),
//              but it is NOT a substitute for talking to another physical device.
//
//   "webrtc" — a real RTCPeerConnection + RTCDataChannel straight to another
//              device on the network. Because LocalDrop has no backend server,
//              there is no signaling server either — so the two devices must
//              exchange one short "offer" and one short "answer" blob directly
//              (via QR-code scan or manual copy/paste). Once that handshake is
//              done, all further clipboard/file traffic flows peer-to-peer with
//              no server involved at all.

const LocalDropDevices = (() => {
  const bus = new EventTarget();
  const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

  const identity = window.LocalDropStorage.getOrCreateDeviceIdentity();
  const deviceType = window.LocalDropStorage.detectDeviceType();

  /** @type {Map<string, PeerRecord>} */
  const peers = new Map();
  // Loop prevention: remember recently-applied update ids (FIFO cap).
  const seenUpdateIds = new Map(); // id -> true, insertion-ordered
  const SEEN_CAP = 500;

  function markSeen(id) {
    if (seenUpdateIds.has(id)) return false;
    seenUpdateIds.set(id, true);
    if (seenUpdateIds.size > SEEN_CAP) {
      const oldest = seenUpdateIds.keys().next().value;
      seenUpdateIds.delete(oldest);
    }
    return true;
  }

  // ---------------- Demo transport (BroadcastChannel) ----------------

  let demoChannel = null;
  let demoActive = false;
  const DEMO_CHANNEL_NAME = 'localdrop-demo-bus';

  function startDemoMode(simulatedName) {
    if (demoActive) return;
    demoActive = true;
    demoChannel = new BroadcastChannel(DEMO_CHANNEL_NAME);
    demoChannel.onmessage = (ev) => handleIncoming('demo', ev.data);
    // Announce presence, and ask existing tabs to announce back.
    demoChannel.postMessage({ kind: 'presence', id: identity.id, name: simulatedName || identity.name, type: deviceType, demo: true });
    demoChannel.postMessage({ kind: 'presence-request', id: identity.id });
  }

  function stopDemoMode() {
    if (!demoActive) return;
    demoChannel.postMessage({ kind: 'bye', id: identity.id });
    demoChannel.close();
    demoChannel = null;
    demoActive = false;
    for (const [id, peer] of [...peers]) {
      if (peer.transport === 'demo') removePeer(id, 'left demo mode');
    }
  }

  function demoSend(msg) {
    if (demoChannel) demoChannel.postMessage(msg);
  }

  // ---------------- Peer bookkeeping ----------------

  function upsertPeer({ id, name, type, transport, status, channel = null, pc = null }) {
    const existing = peers.get(id);
    const record = existing || { id };
    Object.assign(record, {
      name: name || record.name || 'Unknown device',
      type: type || record.type || 'Device',
      transport,
      status,
      lastActive: Date.now(),
      channel: channel || record.channel || null,
      pc: pc || record.pc || null,
    });
    peers.set(id, record);
    window.LocalDropStorage.saveDeviceRecord({ id: record.id, name: record.name, type: record.type, lastActive: record.lastActive });
    emit('devices-changed', { peers: listPeers() });
    return record;
  }

  function removePeer(id, reason) {
    const peer = peers.get(id);
    if (!peer) return;
    peers.delete(id);
    emit('device-disconnected', { id, name: peer.name, reason });
    emit('devices-changed', { peers: listPeers() });
  }

  function listPeers() {
    return [...peers.values()].map((p) => ({
      id: p.id, name: p.name, type: p.type, transport: p.transport, status: p.status, lastActive: p.lastActive,
    }));
  }

  function renamePeer(id, newName) {
    const p = peers.get(id);
    if (!p) return;
    p.name = newName;
    window.LocalDropStorage.saveDeviceRecord({ id: p.id, name: p.name, type: p.type, lastActive: p.lastActive });
    emit('devices-changed', { peers: listPeers() });
  }

  function disconnectPeer(id) {
    const p = peers.get(id);
    if (!p) return;
    try {
      if (p.transport === 'demo') demoSend({ kind: 'bye', id: identity.id, to: id });
      if (p.channel) p.channel.close();
      if (p.pc) p.pc.close();
    } catch { /* already gone */ }
    removePeer(id, 'disconnected by user');
  }

  function disconnectAll() {
    for (const id of [...peers.keys()]) disconnectPeer(id);
    stopDemoMode();
  }

  // ---------------- Sending ----------------

  function sendToPeer(peer, message) {
    try {
      if (peer.transport === 'demo') {
        demoSend({ ...message, to: peer.id, from: identity.id });
      } else if (peer.transport === 'webrtc' && peer.channel && peer.channel.readyState === 'open') {
        peer.channel.send(JSON.stringify(message));
      }
    } catch (err) {
      console.warn('send failed', err);
    }
  }

  function broadcast(message, excludeId = null) {
    for (const peer of peers.values()) {
      if (peer.id === excludeId) continue;
      if (peer.status !== 'connected') continue;
      sendToPeer(peer, message);
    }
  }

  function sendClipboardUpdate(text) {
    const msg = {
      kind: 'clipboard',
      id: window.LocalDropStorage.uuid(),
      text,
      timestamp: Date.now(),
      originDeviceId: identity.id,
      originDeviceName: identity.name,
    };
    markSeen(msg.id);
    broadcast(msg);
    return msg;
  }

  // ---------------- Receiving (shared by both transports) ----------------

  function handleIncoming(transport, data) {
    if (!data || data.id === identity.id) return; // ignore our own broadcasts
    if (data.to && data.to !== identity.id && data.kind !== 'presence' && data.kind !== 'presence-request') return;

    switch (data.kind) {
      case 'presence': {
        upsertPeer({ id: data.id, name: data.name, type: data.type, transport: 'demo', status: 'connected' });
        emit('device-connected', { id: data.id, name: data.name, type: data.type, transport: 'demo' });
        emit('toast', { message: `${data.name} connected` });
        break;
      }
      case 'presence-request': {
        demoSend({ kind: 'presence', id: identity.id, name: identity.name, type: deviceType, demo: true, to: data.id });
        break;
      }
      case 'bye': {
        if (peers.has(data.id)) {
          const name = peers.get(data.id).name;
          removePeer(data.id, 'peer disconnected');
          emit('toast', { message: `${name} disconnected` });
        }
        break;
      }
      case 'clipboard': {
        if (!markSeen(data.id)) return; // already applied — prevents sync loops
        emit('clipboard-received', data);
        broadcast(data, data.originDeviceId); // relay onward for multi-hop mesh, but never back to sender
        break;
      }
      case 'file-meta':
      case 'file-chunk':
      case 'file-complete': {
        if (data.id && data.kind === 'file-meta' && !markSeen('filemeta-' + data.transferId)) return;
        emit('file-message', data);
        if (data.kind !== 'file-chunk') broadcast(data, data.originDeviceId);
        break;
      }
      default:
        break;
    }
  }

  function sendFileMessage(peerIdOrAll, message) {
    if (peerIdOrAll === 'all') {
      broadcast(message);
    } else {
      const peer = peers.get(peerIdOrAll);
      if (peer) sendToPeer(peer, message);
    }
  }

  // ---------------- WebRTC pairing (no signaling server — manual/QR handshake) ----------------

  const RTC_CONFIG = { iceServers: [] }; // intentionally no STUN/TURN — local network only, no third-party cloud

  const pendingOffers = new Map(); // sessionId -> { pc, channel }

  function waitForIceGatheringComplete(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
      // Safety timeout — don't hang forever waiting for candidate gathering.
      setTimeout(resolve, 4000);
    });
  }

  function wireDataChannel(channel, remoteMeta) {
    channel.onopen = () => {
      upsertPeer({ id: remoteMeta.deviceId, name: remoteMeta.deviceName, type: remoteMeta.deviceType, transport: 'webrtc', status: 'connected', channel });
      emit('device-connected', { id: remoteMeta.deviceId, name: remoteMeta.deviceName, type: remoteMeta.deviceType, transport: 'webrtc' });
      emit('toast', { message: `${remoteMeta.deviceName} connected` });
    };
    channel.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try { handleIncoming('webrtc', JSON.parse(ev.data)); } catch { /* ignore malformed */ }
      }
    };
    channel.onclose = () => {
      if (peers.has(remoteMeta.deviceId)) {
        removePeer(remoteMeta.deviceId, 'connection closed');
        emit('toast', { message: `${remoteMeta.deviceName} disconnected` });
      }
    };
  }

  /** Host side: create an offer package to display as QR / text. */
  async function createOfferPackage() {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const channel = pc.createDataChannel('localdrop');
    const sessionId = window.LocalDropStorage.uuid();
    pendingOffers.set(sessionId, { pc, channel });

    wireDataChannel(channel, { deviceId: '(pending)', deviceName: '(pending)', deviceType: '(pending)' });
    // We don't know the remote identity until we get their answer; patch it in then.
    channel._pendingWire = (remoteMeta) => wireDataChannel(channel, remoteMeta);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    const pkg = {
      v: 1, kind: 'offer', sessionId,
      sdp: pc.localDescription.sdp,
      deviceId: identity.id, deviceName: identity.name, deviceType,
    };
    return { sessionId, text: JSON.stringify(pkg) };
  }

  /** Joining side: given a scanned/pasted offer package, produce an answer package. */
  async function acceptOfferPackage(offerText) {
    const offer = JSON.parse(offerText);
    if (offer.kind !== 'offer') throw new Error('Not a LocalDrop offer');

    const pc = new RTCPeerConnection(RTC_CONFIG);
    pc.ondatachannel = (ev) => {
      wireDataChannel(ev.channel, { deviceId: offer.deviceId, deviceName: offer.deviceName, deviceType: offer.deviceType });
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    const pkg = {
      v: 1, kind: 'answer', sessionId: offer.sessionId,
      sdp: pc.localDescription.sdp,
      deviceId: identity.id, deviceName: identity.name, deviceType,
    };
    return { text: JSON.stringify(pkg), remoteDeviceName: offer.deviceName };
  }

  /** Host side: complete the handshake once the joiner's answer package comes back. */
  async function completeWithAnswer(answerText) {
    const answer = JSON.parse(answerText);
    if (answer.kind !== 'answer') throw new Error('Not a LocalDrop answer');
    const pending = pendingOffers.get(answer.sessionId);
    if (!pending) throw new Error('No matching pairing session (it may have expired)');
    await pending.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    pending.channel._pendingWire({ deviceId: answer.deviceId, deviceName: answer.deviceName, deviceType: answer.deviceType });
    pendingOffers.delete(answer.sessionId);
  }

  return {
    identity, deviceType, bus,
    on: (name, fn) => bus.addEventListener(name, fn),
    off: (name, fn) => bus.removeEventListener(name, fn),
    startDemoMode, stopDemoMode, isDemoActive: () => demoActive,
    listPeers, renamePeer, disconnectPeer, disconnectAll,
    sendClipboardUpdate, sendFileMessage, broadcast: (m) => broadcast(m),
    createOfferPackage, acceptOfferPackage, completeWithAnswer,
  };
})();

window.LocalDropDevices = LocalDropDevices;
