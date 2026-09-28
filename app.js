// app.js — view routing, rendering, and wiring every module together.
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const Storage = window.LocalDropStorage;
  const Clip = window.LocalDropClipboard;
  const Devices = window.LocalDropDevices;
  const Pairing = window.LocalDropPairing;
  const History = window.LocalDropHistory;
  const Transfer = window.LocalDropTransfer;

  let currentView = 'home';
  let latestClipboardId = null; // null = "cleared" locally
  let latestFallback = null; // { text, timestamp, originDeviceName } — used when History is turned off in Settings
  let pendingPairSession = null; // { sessionId } for QR/manual host flow
  let pendingIncoming = null; // { text, resolve } awaiting confirm modal

  // ================= Toasts =================

  function toast(message) {
    const region = $('#toast-region');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    region.appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 220);
    }, 2600);
  }

  // ================= Modal system =================

  const modalRoot = $('#modal-root');
  const modalPanel = $('#modal-panel');
  let modalCleanup = null;

  function openModal(templateId, setup) {
    closeModal();
    const tpl = $(templateId);
    modalPanel.innerHTML = '';
    modalPanel.appendChild(tpl.content.cloneNode(true));
    modalRoot.hidden = false;
    document.body.style.overflow = 'hidden';
    $$('[data-close-modal]', modalPanel).forEach((btn) => btn.addEventListener('click', closeModal));
    if (setup) modalCleanup = setup(modalPanel) || null;
    const first = modalPanel.querySelector('input, textarea, button');
    if (first) first.focus();
  }

  function closeModal() {
    if (modalRoot.hidden) return;
    if (modalCleanup) { try { modalCleanup(); } catch {} modalCleanup = null; }
    Pairing.stopScan();
    modalRoot.hidden = true;
    document.body.style.overflow = '';
    modalPanel.innerHTML = '';
  }

  $('#modal-backdrop').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  function confirmDialog(title, body) {
    return new Promise((resolve) => {
      openModal('#tpl-confirm', (panel) => {
        $('#confirm-title', panel).textContent = title;
        $('#confirm-body', panel).textContent = body;
        const yes = $('#btn-confirm-yes', panel);
        const onYes = () => { closeModal(); resolve(true); };
        yes.addEventListener('click', onYes);
        return () => resolve(false);
      });
    });
  }

  // ================= Routing =================

  function navigate(view) {
    if (!$(`.view[data-view="${view}"]`)) return;
    currentView = view;
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
    $$('.nav-item[data-nav]').forEach((btn) => {
      const match = btn.dataset.nav === view;
      if (match) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
    });
    const titleEl = $('#view-title');
    if (titleEl) titleEl.textContent = view.charAt(0).toUpperCase() + view.slice(1);
    if (view === 'history') renderHistory();
    if (view === 'devices') renderDevices();
    if (view === 'files') renderFiles();
    if (view === 'settings') renderSettings();
    if (view === 'home') { renderHomeDevices(); renderHomeRecent(); }
    if (view === 'clipboard') { renderQuickSendTargets(); updateQuickSendMeta(); }
    window.scrollTo(0, 0);
    $('#main').scrollTo?.(0, 0);
  }

  $$('[data-nav]').forEach((btn) => btn.addEventListener('click', () => navigate(btn.dataset.nav)));

  // ================= Status pill =================

  function refreshStatus() {
    const peers = Devices.listPeers().filter((p) => p.status === 'connected');
    const dot = $('#status-dot');
    const text = $('#status-text');
    dot.className = 'dot';
    if (!navigator.onLine && peers.length === 0) {
      dot.classList.add('offline'); text.textContent = 'Offline';
    } else if (peers.length > 0) {
      dot.classList.add('online'); text.textContent = `Connected · ${peers.length} device${peers.length > 1 ? 's' : ''}`;
    } else {
      dot.classList.add('waiting'); text.textContent = 'Waiting for devices';
    }
    const badge = $('#devices-nav-badge');
    if (peers.length > 0) { badge.hidden = false; badge.textContent = peers.length; } else badge.hidden = true;
  }

  window.addEventListener('online', refreshStatus);
  window.addEventListener('offline', refreshStatus);

  // ================= Device icon helper =================

  function deviceEmoji(type) {
    const t = (type || '').toLowerCase();
    if (t.includes('phone') || t.includes('android') || t.includes('iphone')) return '📱';
    if (t.includes('tablet') || t.includes('ipad')) return '📱';
    if (t.includes('mac') || t.includes('windows') || t.includes('linux') || t.includes('laptop') || t.includes('desktop')) return '💻';
    return '🔗';
  }

  // ================= Home view =================

  async function renderLatestClipboard() {
    const slot = $('#latest-clipboard-slot');
    if (latestClipboardId === null && latestFallback) {
      // History is turned off in Settings — show the most recent sync from memory only.
      const pseudo = {
        id: '__fallback__', text: latestFallback.text, preview: latestFallback.text.slice(0, 300),
        byteSize: new Blob([latestFallback.text]).size, charCount: latestFallback.text.length,
        isLarge: latestFallback.text.length > Storage.LARGE_TEXT_THRESHOLD,
        timestamp: latestFallback.timestamp, originDeviceName: latestFallback.originDeviceName, favorite: false,
      };
      slot.innerHTML = renderEntryHTML(pseudo, true);
      const el = slot.querySelector('[data-entry-id]');
      el.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        const res = await Clip.writeText(pseudo.text);
        toast(res.ok ? 'Copied to clipboard' : 'Could not copy — select and copy manually');
      });
      el.querySelector('[data-act="view"]').addEventListener('click', () => openViewText({ ...pseudo, id: null }));
      el.querySelector('[data-act="edit"]').remove();
      el.querySelector('[data-act="delete"]').addEventListener('click', () => { latestFallback = null; renderLatestClipboard(); });
      return;
    }
    const list = await History.list();
    const latest = latestClipboardId === null ? null : (list.find((e) => e.id === latestClipboardId) || list[0]);
    if (!latest) {
      slot.innerHTML = `<div class="empty-state"><p class="empty-title">Nothing synced yet</p><p class="muted">Tap <strong>Sync Clipboard</strong> or <strong>Paste &amp; Sync</strong> to share your first snippet.</p></div>`;
      return;
    }
    latestClipboardId = latest.id;
    slot.innerHTML = renderEntryHTML(latest, true);
    wireEntryActions(slot, latest);
  }

  function renderEntryHTML(entry, isLatest = false) {
    const sizeLine = entry.isLarge
      ? `<span class="large-badge">Large clipboard</span> ${History.formatBytes(entry.byteSize)} · ${History.formatCount(entry.charCount)} characters`
      : `${History.formatBytes(entry.byteSize)} · From ${escapeHtml(entry.originDeviceName || 'this device')}`;
    const body = entry.isLarge
      ? `<p class="muted small" style="margin-bottom:10px">${escapeHtml(entry.preview)}…</p>`
      : `<pre class="clip-entry-text">${escapeHtml(entry.text ?? entry.preview)}</pre>`;
    return `
      <div class="clip-entry" data-entry-id="${entry.id}">
        ${body}
        <div class="clip-entry-meta">${entry.favorite ? '⭐ ' : ''}${sizeLine} · ${History.formatTime(entry.timestamp)}</div>
        <div class="clip-entry-actions">
          <button class="btn btn-outline btn-sm" data-act="copy">Copy</button>
          <button class="btn btn-outline btn-sm" data-act="view">View</button>
          <button class="btn btn-outline btn-sm" data-act="edit">Edit</button>
          <button class="btn btn-ghost btn-sm btn-danger-ghost" data-act="delete">Delete</button>
        </div>
      </div>`;
  }

  function wireEntryActions(root, entry) {
    const el = root.querySelector(`[data-entry-id="${entry.id}"]`);
    if (!el) return;
    el.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      const text = await History.getFullText(entry.id);
      const res = await Clip.writeText(text ?? '');
      toast(res.ok ? 'Copied to clipboard' : 'Could not copy — select and copy manually');
    });
    el.querySelector('[data-act="view"]').addEventListener('click', () => openViewText(entry));
    el.querySelector('[data-act="edit"]').addEventListener('click', () => openEditText(entry));
    el.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      const ok = await confirmDialog('Delete this entry?', 'This clipboard entry will be removed from history.');
      if (!ok) return;
      await History.remove(entry.id);
      if (latestClipboardId === entry.id) latestClipboardId = null;
      toast('Deleted');
      renderLatestClipboard();
      if (currentView === 'history') renderHistory();
      renderHomeRecent();
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function renderHomeDevices() {
    const ul = $('#home-device-list');
    const peers = Devices.listPeers();
    if (peers.length === 0) {
      ul.innerHTML = `<li class="muted small" style="padding:8px 0">No devices connected yet.</li>`;
      return;
    }
    ul.innerHTML = peers.slice(0, 4).map((p) => `
      <li class="device-row">
        <span class="device-icon">${deviceEmoji(p.type)}</span>
        <div class="device-info">
          <div class="name">${escapeHtml(p.name)} ${p.transport === 'demo' ? '<span class="demo-tag">Demo</span>' : ''}</div>
          <div class="meta">${escapeHtml(p.type)} · Connected</div>
        </div>
        <span class="device-status-dot"></span>
      </li>`).join('');
  }

  async function renderHomeRecent() {
    const ul = $('#home-recent-list');
    const list = (await History.list()).slice(0, 5);
    if (list.length === 0) { ul.innerHTML = `<li class="muted">Nothing yet</li>`; return; }
    ul.innerHTML = list.map((e) => `<li>${escapeHtml(e.preview.slice(0, 80))}</li>`).join('');
  }

  // ---- Sync Clipboard / Paste & Sync / Copy Latest / Clear ----

  async function doSyncClipboard() {
    if (!Clip.isSupported()) {
      $('#clipboard-permission-hint').hidden = false;
      $('#clipboard-permission-hint').textContent = 'Clipboard access is restricted by your browser. Use Paste & Sync instead.';
      openPasteAndSync();
      return;
    }
    const res = await Clip.readText();
    if (!res.ok) {
      $('#clipboard-permission-hint').hidden = false;
      $('#clipboard-permission-hint').textContent = res.reason === 'denied'
        ? 'Clipboard access is restricted by your browser.'
        : 'Could not read the clipboard right now.';
      openPasteAndSync();
      return;
    }
    $('#clipboard-permission-hint').hidden = true;
    if (!res.text) { toast('Clipboard is empty'); return; }
    await commitClipboardText(res.text, true);
  }

  async function commitClipboardText(text, broadcast, originDeviceName) {
    const identity = Devices.identity;
    const entry = await Storage.addHistoryEntry({ text, originDeviceId: identity.id, originDeviceName: originDeviceName || identity.name + ' (you)' });
    latestClipboardId = entry ? entry.id : null;
    latestFallback = entry ? null : { text, timestamp: Date.now(), originDeviceName: originDeviceName || identity.name + ' (you)' };
    Clip.markSynced(text);
    if (broadcast && Storage.getSettings().clipboardSyncEnabled) {
      Devices.sendClipboardUpdate(text);
    }
    toast('Clipboard synced');
    renderLatestClipboard();
    renderHomeRecent();
    if (currentView === 'history') renderHistory();
  }

  function openPasteAndSync() {
    openModal('#tpl-edit-text', (panel) => {
      $('h2', panel).textContent = 'Paste & Sync';
      const area = $('#edit-text-body', panel);
      area.placeholder = 'Paste or type your text…';
      area.value = '';
      area.focus();
      $('#btn-edit-save', panel).remove();
      $('#btn-edit-cancel', panel).addEventListener('click', closeModal);
      $('#btn-edit-sync', panel).textContent = 'Sync';
      $('#btn-edit-sync', panel).addEventListener('click', async () => {
        if (!area.value.trim()) { toast('Nothing to sync'); return; }
        await commitClipboardText(area.value, true);
        closeModal();
      });
    });
  }

  async function doCopyLatest() {
    if (latestClipboardId === null && latestFallback) {
      const res = await Clip.writeText(latestFallback.text);
      toast(res.ok ? 'Copied to clipboard' : 'Could not copy — open it and copy manually');
      return;
    }
    const list = await History.list();
    const latest = list.find((e) => e.id === latestClipboardId) || list[0];
    if (!latest) { toast('Nothing to copy yet'); return; }
    const text = await History.getFullText(latest.id);
    const res = await Clip.writeText(text ?? '');
    toast(res.ok ? 'Copied to clipboard' : 'Could not copy — open it and copy manually');
  }

  function doClearLatest() {
    latestClipboardId = null;
    latestFallback = null;
    renderLatestClipboard();
    toast('Cleared');
  }

  $('#btn-sync-clipboard').addEventListener('click', doSyncClipboard);
  $('#btn-paste-sync').addEventListener('click', openPasteAndSync);
  $('#btn-copy-latest').addEventListener('click', doCopyLatest);
  $('#btn-clear-latest').addEventListener('click', doClearLatest);

  // ================= View text / Edit text modals =================

  function openViewText(entry) {
    openModal('#tpl-view-text', async (panel) => {
      const meta = $('#view-text-meta', panel);
      const body = $('#view-text-body', panel);
      meta.textContent = `${History.formatBytes(entry.byteSize)} · ${History.formatCount(entry.charCount)} characters · ${History.formatTime(entry.timestamp)}`;
      body.textContent = 'Loading…';
      const text = entry.id ? await History.getFullText(entry.id) : (entry.text ?? '');
      body.textContent = text ?? '';
      $('#btn-view-copy', panel).addEventListener('click', async () => {
        const res = await Clip.writeText(text ?? '');
        toast(res.ok ? 'Copied to clipboard' : 'Could not copy');
      });
      $('#btn-view-save', panel).addEventListener('click', () => {
        const blob = new Blob([text ?? ''], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `localdrop-${entry.id.slice(0, 8)}.txt`;
        a.click();
        URL.revokeObjectURL(a.href);
      });
    });
  }

  function openEditText(entry) {
    openModal('#tpl-edit-text', async (panel) => {
      const area = $('#edit-text-body', panel);
      area.value = 'Loading…';
      area.value = (await History.getFullText(entry.id)) ?? '';
      $('#btn-edit-cancel', panel).addEventListener('click', closeModal);
      $('#btn-edit-save', panel).addEventListener('click', async () => {
        await History.updateText(entry.id, area.value);
        toast('Saved');
        closeModal();
        renderLatestClipboard(); renderHistory(); renderHomeRecent();
      });
      $('#btn-edit-sync', panel).addEventListener('click', async () => {
        await History.updateText(entry.id, area.value);
        if (Storage.getSettings().clipboardSyncEnabled) Devices.sendClipboardUpdate(area.value);
        latestClipboardId = entry.id;
        toast('Saved & synced');
        closeModal();
        renderLatestClipboard(); renderHistory(); renderHomeRecent();
      });
    });
  }

  // ================= History view =================

  let historyTab = 'all';
  let historyQuery = '';

  async function renderHistory() {
    const container = $('#history-groups');
    const emptyState = $('#history-empty');
    let list = historyTab === 'favorites' ? await History.favorites() : await History.search(historyQuery);
    if (historyTab === 'favorites' && historyQuery) {
      const q = historyQuery.toLowerCase();
      list = list.filter((e) => e.preview.toLowerCase().includes(q));
    }
    if (list.length === 0) {
      container.innerHTML = '';
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;
    const groups = History.groupByDay(list);
    container.innerHTML = groups.map((g) => `
      <div class="history-group">
        <div class="history-group-label">${g.label}</div>
        ${g.items.map((e) => renderEntryHTML(e)).join('')}
      </div>`).join('');
    for (const e of list) wireEntryActions(container, e);
    // Favorite star toggle (added on top of the standard action row)
    $$('.clip-entry', container).forEach((el) => {
      const id = el.dataset.entryId;
      const entry = list.find((e) => e.id === id);
      const star = document.createElement('button');
      star.className = 'icon-btn';
      star.setAttribute('aria-label', entry.favorite ? 'Remove favorite' : 'Add to favorites');
      star.textContent = entry.favorite ? '⭐' : '☆';
      star.style.marginLeft = 'auto';
      star.addEventListener('click', async () => { await History.toggleFavorite(id); renderHistory(); });
      el.querySelector('.clip-entry-actions').appendChild(star);
    });
  }

  $('#history-search').addEventListener('input', (e) => { historyQuery = e.target.value.trim(); renderHistory(); });
  $$('.tabs [data-tab]').forEach((tab) => tab.addEventListener('click', () => {
    historyTab = tab.dataset.tab;
    $$('.tabs [data-tab]').forEach((t) => { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', t === tab); });
    renderHistory();
  }));

  // ================= Devices view =================

  async function renderDevices() {
    const ul = $('#devices-list');
    const empty = $('#devices-empty');
    const peers = Devices.listPeers();
    ul.hidden = peers.length === 0;
    empty.hidden = peers.length !== 0;
    ul.innerHTML = peers.map((p) => `
      <li class="device-row" data-id="${p.id}">
        <span class="device-icon">${deviceEmoji(p.type)}</span>
        <div class="device-info">
          <div class="name">${escapeHtml(p.name)} ${p.transport === 'demo' ? '<span class="demo-tag">Demo</span>' : ''}</div>
          <div class="meta">${escapeHtml(p.type)} · Connected · Clipboard sync on</div>
        </div>
        <span class="device-status-dot"></span>
        <div class="device-actions">
          <button class="icon-btn" data-act="rename" aria-label="Rename ${escapeHtml(p.name)}">✎</button>
          <button class="icon-btn" data-act="disconnect" aria-label="Disconnect ${escapeHtml(p.name)}">⏻</button>
        </div>
      </li>`).join('');
    ul.querySelectorAll('[data-act="rename"]').forEach((btn) => btn.addEventListener('click', (e) => {
      const id = e.target.closest('li').dataset.id;
      const peer = peers.find((p) => p.id === id);
      openRenameModal(peer.name, (name) => { Devices.renamePeer(id, name); renderDevices(); });
    }));
    ul.querySelectorAll('[data-act="disconnect"]').forEach((btn) => btn.addEventListener('click', async (e) => {
      const id = e.target.closest('li').dataset.id;
      const peer = peers.find((p) => p.id === id);
      const ok = await confirmDialog(`Disconnect ${peer.name}?`, 'You can reconnect it later.');
      if (ok) { Devices.disconnectPeer(id); renderDevices(); }
    }));

    $('#this-device-name').textContent = Devices.identity.name;
    $('#this-device-type').textContent = Devices.deviceType;
  }

  function openRenameModal(currentName, onSave) {
    openModal('#tpl-rename-device', (panel) => {
      const input = $('#rename-input', panel);
      input.value = currentName;
      input.focus(); input.select();
      $('#btn-rename-save', panel).addEventListener('click', () => {
        const val = input.value.trim();
        if (val) onSave(val);
        closeModal();
      });
    });
  }

  $('#btn-rename-device').addEventListener('click', () => {
    openRenameModal(Devices.identity.name, (name) => {
      Storage.setSettings({ deviceName: name });
      Devices.identity.name = name;
      $('#this-device-name').textContent = name;
      $('#settings-device-name').textContent = name;
      toast('Device renamed');
    });
  });

  // ================= Connect Device modal (QR / Manual / Demo) =================

  function openConnectModal() {
    openModal('#tpl-connect-device', (panel) => {
      const tabs = $$('.tabs [data-pair-tab]', panel);
      const panes = { qr: $('[data-pair-pane="qr"]', panel), manual: $('[data-pair-pane="manual"]', panel), demo: $('[data-pair-pane="demo"]', panel) };
      const initOnce = { manual: false, demo: false }; // avoid generating a second RTCPeerConnection until the tab is actually opened
      tabs.forEach((t) => t.addEventListener('click', () => {
        tabs.forEach((x) => x.classList.toggle('active', x === t));
        Object.entries(panes).forEach(([k, el]) => { el.hidden = k !== t.dataset.pairTab; });
        Pairing.stopScan();
        const key = t.dataset.pairTab;
        if (key === 'manual' && !initOnce.manual) { initOnce.manual = true; setupManualPane(panel); }
        if (key === 'demo' && !initOnce.demo) { initOnce.demo = true; setupDemoPane(panel); }
      }));

      setupQrPane(panel);

      const onConn = (e) => {
        Pairing.stopScan();
        panel.innerHTML = `<div class="connected-ok"><div class="ok-ring">✓</div><h2>Connected</h2><p class="muted">${escapeHtml(e.detail.name)} is linked. Anything you copy on one device now lands on the other.</p></div>`;
        setTimeout(closeModal, 1800);
      };
      Devices.on('device-connected', onConn);
      return () => { Devices.off('device-connected', onConn); Pairing.stopScan(); if (pendingPairSession) pendingPairSession = null; };
    });
  }

  $('#btn-connect-device').addEventListener('click', openConnectModal);
  $('#btn-connect-device-home').addEventListener('click', openConnectModal);
  $('#btn-connect-device-empty')?.addEventListener('click', openConnectModal);

  // ---- QR pane ----

  function setupQrPane(panel) {
    const hostBtn = $('[data-qr-mode="host"]', panel);
    const scanBtn = $('[data-qr-mode="scan"]', panel);
    const hostBox = $('[data-qr-host]', panel);
    const scanBox = $('[data-qr-scan]', panel);

    const showHost = async () => {
      hostBtn.classList.add('active'); scanBtn.classList.remove('active');
      hostBox.hidden = false; scanBox.hidden = true;
      Pairing.stopScan();
      await startQrHostFlow(panel);
    };
    const showScan = () => {
      scanBtn.classList.add('active'); hostBtn.classList.remove('active');
      hostBox.hidden = true; scanBox.hidden = false;
      startQrScanFlow(panel, 'offer');
    };
    hostBtn.addEventListener('click', showHost);
    scanBtn.addEventListener('click', showScan);
    $('#btn-cancel-scan', panel).addEventListener('click', showHost);
    showHost();
  }

  async function startQrHostFlow(panel) {
    const canvas = $('#qr-canvas', panel);
    const waitingEl = $('#qr-host-waiting', panel);
    canvas.style.opacity = '0.35';
    waitingEl.textContent = 'Generating your code…';
    $('[data-qr-host-answer-scan]', panel).hidden = true;
    const { sessionId, text } = await Devices.createOfferPackage();
    pendingPairSession = sessionId;
    await Pairing.renderQR(canvas, text);
    canvas.style.opacity = '1';
    startExpiry($('#qr-expiry', panel), 300);
    waitingEl.textContent = 'Waiting for the other device to scan and respond…';
    $('[data-qr-host-answer-scan]', panel).hidden = false;
    $('[data-open-scan-for="answer"]', panel).onclick = () => startQrScanFlow(panel, 'answer');
    $('#btn-submit-answer-paste', panel).onclick = async () => {
      const val = $('#qr-answer-paste', panel).value.trim();
      if (!val) return toast('Paste the reply code first');
      await tryCompletePairing(val);
    };
  }

  function startQrScanFlow(panel, kind) {
    const video = $('#qr-video', panel);
    const hint = $('#qr-scan-hint', panel);
    hint.textContent = kind === 'offer' ? "Point your camera at the other device's code." : 'Scan the reply code shown on the other device.';
    Pairing.startScan(video, async (decoded) => {
      if (kind === 'offer') await handleScannedOffer(decoded, panel);
      else await tryCompletePairing(decoded);
    }, (err) => {
      toast('Camera access denied or unavailable — try Manual Code instead');
    });
  }

  async function handleScannedOffer(offerText, panel) {
    const proceed = await requestPairingConfirmation(offerText);
    if (!proceed) { toast('Pairing rejected'); Pairing.stopScan(); return; }
    try {
      const { text, remoteDeviceName } = await Devices.acceptOfferPackage(offerText);
      Pairing.stopScan();
      await Pairing.renderQR($('#qr-canvas', panel), text);
      $('[data-qr-mode="host"]', panel).click();
      $('#qr-host-waiting', panel).textContent = `Reply code ready. Show it back to ${remoteDeviceName}, or they can scan it.`;
      $('[data-qr-host-answer-scan]', panel).hidden = true;
      toast('Reply code generated — show it to the other device');
    } catch (err) {
      toast('Could not read that code: ' + err.message);
    }
  }

  // ---- Manual pane ----

  function setupManualPane(panel) {
    const hostBtn = $('[data-manual-mode="host"]', panel);
    const joinBtn = $('[data-manual-mode="join"]', panel);
    const hostBox = $('[data-manual-host]', panel);
    const joinBox = $('[data-manual-join]', panel);

    const showHost = async () => {
      hostBtn.classList.add('active'); joinBtn.classList.remove('active');
      hostBox.hidden = false; joinBox.hidden = true;
      const codeEl = $('#manual-offer-code', panel);
      codeEl.value = 'Generating your code…';
      const { sessionId, text } = await Devices.createOfferPackage();
      pendingPairSession = sessionId;
      codeEl.value = Pairing.toManualCode(text);
      startExpiry($('#manual-expiry', panel), 300);
    };
    hostBtn.addEventListener('click', showHost);
    joinBtn.addEventListener('click', () => {
      joinBtn.classList.add('active'); hostBtn.classList.remove('active');
      joinBox.hidden = false; hostBox.hidden = true;
    });

    $('#btn-copy-manual-offer', panel).addEventListener('click', async () => {
      await Clip.writeText($('#manual-offer-code', panel).value);
      toast('Code copied');
    });
    $('#btn-submit-manual-answer', panel).addEventListener('click', async () => {
      const raw = $('#manual-answer-paste', panel).value.trim();
      if (!raw) return toast('Paste the reply code first');
      try { await tryCompletePairing(Pairing.fromManualCode(raw)); }
      catch { toast('That code looks invalid'); }
    });
    $('#btn-paste-clip-code', panel).addEventListener('click', async () => {
      const r = await Clip.readText();
      if (!r.ok || !r.text) return toast('Could not read the clipboard — paste into the box instead');
      $('#manual-offer-paste', panel).value = r.text;
      $('#btn-generate-manual-reply', panel).click();
    });
    $('#btn-share-manual-offer', panel).addEventListener('click', async () => {
      const code = $('#manual-offer-code', panel).value;
      if (navigator.share) { try { await navigator.share({ title: 'LocalDrop pairing code', text: code }); return; } catch { return; } }
      await Clip.writeText(code); toast('Code copied — send it to your other device');
    });
    $('#btn-generate-manual-reply', panel).addEventListener('click', async () => {
      const raw = $('#manual-offer-paste', panel).value.trim();
      if (!raw) return toast('Paste their code first');
      let offerText;
      try { offerText = Pairing.fromManualCode(raw); } catch { return toast('That code looks invalid'); }
      if (JSON.parse(offerText).kind === 'answer') return tryCompletePairing(offerText); // smart: a reply code finishes pairing
      const proceed = await requestPairingConfirmation(offerText);
      if (!proceed) return toast('Pairing rejected');
      try {
        const { text } = await Devices.acceptOfferPackage(offerText);
        $('#manual-reply-code', panel).value = Pairing.toManualCode(text);
        $('#manual-reply-wrap', panel).hidden = false;
        Clip.writeText($('#manual-reply-code', panel).value).then((r) => r.ok && toast('Reply code copied — send it back'));
      } catch (err) {
        toast('Could not use that code: ' + err.message);
      }
    });
    $('#btn-copy-manual-reply', panel).addEventListener('click', async () => {
      await Clip.writeText($('#manual-reply-code', panel).value);
      toast('Reply code copied');
    });

    showHost();
  }

  async function tryCompletePairing(text) {
    try {
      await Devices.completeWithAnswer(text);
      toast('Device paired');
      closeModal();
      renderDevices(); renderHomeDevices();
    } catch (err) {
      toast('Pairing failed: ' + err.message);
    }
  }

  // Shows an inline Accept/Reject overlay *within the currently open connect
  // modal* (rather than stacking a second modal, which would wipe out the
  // QR/manual pairing state underneath it).
  function requestPairingConfirmation(offerText) {
    if (!Storage.getSettings().requirePairingConfirmation) return Promise.resolve(true);
    let name = 'Unknown device';
    try { name = JSON.parse(offerText).deviceName || name; } catch {}
    return new Promise((resolve) => {
      const tpl = $('#tpl-pairing-confirm');
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.appendChild(tpl.content.cloneNode(true));
      modalPanel.appendChild(overlay);
      $('#pairing-confirm-name', overlay).textContent = name;
      const finish = (val) => { overlay.remove(); resolve(val); };
      $('#btn-accept-pair', overlay).addEventListener('click', () => finish(true));
      $('#btn-reject-pair', overlay).addEventListener('click', () => finish(false));
    });
  }

  function startExpiry(el, seconds) {
    let remaining = seconds;
    const tick = () => {
      const m = Math.floor(remaining / 60);
      const s = String(remaining % 60).padStart(2, '0');
      if (el.isConnected) el.textContent = `${m}:${s}`;
      remaining--;
      if (remaining < 0) { clearInterval(iv); if (el.isConnected) el.textContent = 'expired'; }
    };
    tick();
    const iv = setInterval(tick, 1000);
  }

  // ---- Demo pane ----

  function setupDemoPane(panel) {
    $('#btn-start-demo', panel).addEventListener('click', () => {
      const name = $('#demo-device-name', panel).value;
      if (Devices.isDemoActive()) { toast('Demo mode already running — open another tab to see it'); return; }
      Devices.startDemoMode(name);
      toast(`Demo mode started as "${name}" — open another tab to connect`);
      closeModal();
    });
  }

  // ================= Files view =================

  const activeTransfers = new Map(); // transferId -> row element

  async function renderFiles() {
    const list = await Storage.getFileList();
    const ul = $('#files-list');
    const empty = $('#files-empty');
    ul.hidden = list.length === 0;
    empty.hidden = list.length !== 0;
    ul.innerHTML = list.map((f) => `
      <li class="file-row" data-id="${f.id}">
        <div>
          <div class="name">${escapeHtml(f.name)}</div>
          <div class="muted small">${History.formatBytes(f.size)} · From ${escapeHtml(f.originDeviceName || 'unknown')}</div>
        </div>
        <div class="device-actions">
          <button class="btn btn-outline btn-sm" data-act="download">Download</button>
          <button class="icon-btn" data-act="delete" aria-label="Delete ${escapeHtml(f.name)}">🗑</button>
        </div>
      </li>`).join('');
    ul.querySelectorAll('[data-act="download"]').forEach((btn) => btn.addEventListener('click', async (e) => {
      const id = e.target.closest('li').dataset.id;
      const file = await Storage.getFile(id);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file.blob);
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(a.href);
    }));
    ul.querySelectorAll('[data-act="delete"]').forEach((btn) => btn.addEventListener('click', async (e) => {
      const id = e.target.closest('li').dataset.id;
      await Storage.deleteFile(id);
      renderFiles();
    }));
  }

  function ensureTransferRow(transferId, name) {
    if (activeTransfers.has(transferId)) return activeTransfers.get(transferId);
    $('#transfer-progress-card').hidden = false;
    const li = document.createElement('li');
    li.className = 'transfer-row';
    li.innerHTML = `<div class="name">${escapeHtml(name)}</div><div class="progress-track"><div class="progress-fill" style="width:0%"></div></div><div class="progress-meta"><span class="pct">0%</span><span class="rate"></span></div>`;
    $('#transfer-list').appendChild(li);
    activeTransfers.set(transferId, li);
    return li;
  }

  function updateTransferRow(transferId, fraction, metaText) {
    const row = activeTransfers.get(transferId);
    if (!row) return;
    row.querySelector('.progress-fill').style.width = `${Math.round(fraction * 100)}%`;
    row.querySelector('.pct').textContent = `${Math.round(fraction * 100)}%`;
    row.querySelector('.rate').textContent = metaText;
  }

  function finishTransferRow(transferId, label) {
    const row = activeTransfers.get(transferId);
    if (!row) return;
    updateTransferRow(transferId, 1, label);
    setTimeout(() => { row.remove(); activeTransfers.delete(transferId); }, 2500);
  }

  Transfer.on('send-progress', (e) => {
    const { transferId, name, sent, size } = e.detail;
    ensureTransferRow(transferId, `Sending ${name}`);
    updateTransferRow(transferId, size ? sent / size : 0, `${History.formatBytes(sent)} / ${History.formatBytes(size)}`);
  });
  Transfer.on('send-complete', (e) => { finishTransferRow(e.detail.transferId, 'Sent'); toast(`${e.detail.name} sent`); });
  Transfer.on('receive-start', (e) => { ensureTransferRow(e.detail.transferId, `Receiving ${e.detail.name}`); toast(`Receiving ${e.detail.name} from ${e.detail.originDeviceName}`); });
  Transfer.on('receive-progress', (e) => {
    const { transferId, received, size } = e.detail;
    updateTransferRow(transferId, size ? received / size : 0, `${History.formatBytes(received)} / ${History.formatBytes(size)}`);
  });
  Transfer.on('receive-complete', (e) => {
    finishTransferRow(e.detail.transferId, 'Received');
    toast(`${e.detail.name} received`);
    if (currentView === 'files') renderFiles();
  });

  function wireFileInput() {
    const input = $('#file-input');
    const zone = $('#file-dropzone');
    input.addEventListener('change', () => { if (input.files[0]) sendFile(input.files[0]); input.value = ''; });
    ['dragover', 'dragenter'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag-over'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag-over'); }));
    zone.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) sendFile(f); });
  }

  function sendFile(file) {
    if (!Storage.getSettings().fileTransferEnabled) { toast('File transfer is turned off in Settings'); return; }
    if (Devices.listPeers().filter((p) => p.status === 'connected').length === 0) { toast('Connect a device first'); return; }
    Transfer.sendFile(file, 'all');
  }

  // ================= Quick Send =================

  function updateQuickSendMeta() {
    const val = $('#quick-send-text').value;
    if (!val) { $('#quick-send-meta').textContent = ''; return; }
    $('#quick-send-meta').textContent = `${History.formatBytes(new Blob([val]).size)} · ${History.formatCount(val.length)} characters`;
  }
  $('#quick-send-text').addEventListener('input', updateQuickSendMeta);

  function renderQuickSendTargets() {
    const wrap = $('#quick-send-targets');
    const peers = Devices.listPeers().filter((p) => p.status === 'connected');
    wrap.innerHTML = `<label class="target-chip"><input type="checkbox" value="all" checked> All connected devices</label>` +
      peers.map((p) => `<label class="target-chip"><input type="checkbox" value="${p.id}" disabled> ${escapeHtml(p.name)}</label>`).join('');
    const all = wrap.querySelector('input[value="all"]');
    const others = () => $$('input[type="checkbox"]', wrap).filter((c) => c.value !== 'all');
    all.addEventListener('change', () => others().forEach((c) => { c.disabled = all.checked; if (all.checked) c.checked = false; }));
  }

  $('#btn-quick-send').addEventListener('click', async () => {
    const text = $('#quick-send-text').value;
    if (!text.trim()) return toast('Type something to send first');
    const wrap = $('#quick-send-targets');
    const all = wrap.querySelector('input[value="all"]');
    const targets = all.checked ? ['all'] : $$('input[type="checkbox"]:checked', wrap).map((c) => c.value);
    if (targets.length === 0) return toast('Choose at least one device');
    const identity = Devices.identity;
    const entry = await Storage.addHistoryEntry({ text, originDeviceId: identity.id, originDeviceName: identity.name + ' (you)' });
    if (targets.includes('all')) {
      Devices.sendClipboardUpdate(text);
    } else {
      const msg = { kind: 'clipboard', id: Storage.uuid(), text, timestamp: Date.now(), originDeviceId: identity.id, originDeviceName: identity.name };
      targets.forEach((id) => Devices.sendFileMessage(id, msg));
    }
    latestClipboardId = entry ? entry.id : latestClipboardId;
    toast('Sent');
    $('#quick-send-text').value = '';
    updateQuickSendMeta();
    renderHomeRecent();
  });

  // ================= Settings view =================

  function renderSettings() {
    const s = Storage.getSettings();
    $('#settings-device-name').textContent = s.deviceName || Devices.identity.name;
    $('#setting-clipboard-sync').checked = s.clipboardSyncEnabled;
    $('#setting-file-transfer').checked = s.fileTransferEnabled;
    $('#setting-history-enabled').checked = s.historyEnabled;
    $('#setting-max-history').value = String(s.maxHistoryItems || 0);
    $('#setting-auto-delete').value = String(s.autoDeleteHistoryDays || 0);
    $('#setting-show-network').checked = s.showOnNetwork;
    $('#setting-require-confirm').checked = s.requirePairingConfirmation;
    $$('.segmented [data-theme]').forEach((btn) => btn.setAttribute('aria-checked', btn.dataset.theme === s.theme ? 'true' : 'false'));
    $('#btn-demo-mode').textContent = Devices.isDemoActive() ? 'Stop Demo Mode' : 'Start Demo Mode';
  }

  $('#settings-device-name').addEventListener('click', () => {
    openRenameModal(Devices.identity.name, (name) => {
      Storage.setSettings({ deviceName: name });
      Devices.identity.name = name;
      renderSettings(); renderDevices();
      toast('Device renamed');
    });
  });
  $('#setting-clipboard-sync').addEventListener('change', (e) => Storage.setSettings({ clipboardSyncEnabled: e.target.checked }));
  $('#setting-file-transfer').addEventListener('change', (e) => Storage.setSettings({ fileTransferEnabled: e.target.checked }));
  $('#setting-history-enabled').addEventListener('change', (e) => Storage.setSettings({ historyEnabled: e.target.checked }));
  $('#setting-max-history').addEventListener('change', (e) => Storage.setSettings({ maxHistoryItems: Number(e.target.value) }));
  $('#setting-auto-delete').addEventListener('change', (e) => Storage.setSettings({ autoDeleteHistoryDays: Number(e.target.value) }));
  $('#setting-show-network').addEventListener('change', (e) => Storage.setSettings({ showOnNetwork: e.target.checked }));
  $('#setting-require-confirm').addEventListener('change', (e) => Storage.setSettings({ requirePairingConfirmation: e.target.checked }));

  $$('.segmented [data-theme]').forEach((btn) => btn.addEventListener('click', () => {
    const theme = btn.dataset.theme;
    Storage.setSettings({ theme });
    applyTheme(theme);
    renderSettings();
  }));

  function applyTheme(theme) {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }

  $('#btn-clear-history-settings').addEventListener('click', clearHistoryFlow);
  $('#btn-clear-history-privacy').addEventListener('click', clearHistoryFlow);
  async function clearHistoryFlow() {
    const ok = await confirmDialog('Clear clipboard history?', 'Favorited entries will be kept. This cannot be undone.');
    if (!ok) return;
    await History.clear({ keepFavorites: true });
    latestClipboardId = null;
    toast('History cleared');
    renderHistory(); renderLatestClipboard(); renderHomeRecent();
  }

  $('#btn-disconnect-all').addEventListener('click', async () => {
    const ok = await confirmDialog('Disconnect all devices?', 'You can reconnect them later.');
    if (!ok) return;
    Devices.disconnectAll();
    toast('All devices disconnected');
    renderDevices(); renderHomeDevices(); renderSettings();
  });

  $('#btn-demo-mode').addEventListener('click', () => {
    if (Devices.isDemoActive()) {
      Devices.stopDemoMode();
      toast('Demo mode stopped');
    } else {
      Devices.startDemoMode('Demo Device');
      toast('Demo mode started — open another tab to connect');
    }
    renderSettings();
  });

  // ================= Device events =================

  Devices.on('device-connected', () => { refreshStatus(); renderHomeDevices(); if (currentView === 'devices') renderDevices(); if (currentView === 'clipboard') renderQuickSendTargets(); });
  Devices.on('device-disconnected', () => { refreshStatus(); renderHomeDevices(); if (currentView === 'devices') renderDevices(); if (currentView === 'clipboard') renderQuickSendTargets(); });
  Devices.on('devices-changed', () => { refreshStatus(); });
  Devices.on('toast', (e) => toast(e.detail.message));
  Devices.on('clipboard-received', async (e) => {
    const data = e.detail;
    const entry = await Storage.addHistoryEntry({ text: data.text, originDeviceId: data.originDeviceId, originDeviceName: data.originDeviceName });
    latestClipboardId = entry ? entry.id : null;
    latestFallback = entry ? null : { text: data.text, timestamp: Date.now(), originDeviceName: data.originDeviceName };
    const copied = Storage.getSettings().clipboardSyncEnabled ? await Clip.applyRemote(data.text) : false;
    toast(copied ? `Copied from ${data.originDeviceName} — just paste` : Clip.hasPending() ? `From ${data.originDeviceName} — tap anywhere to copy it` : `Text received from ${data.originDeviceName}`);
    renderLatestClipboard(); renderHomeRecent();
    if (currentView === 'history') renderHistory();
  });

  // ================= Auto-delete-by-age sweep (Privacy setting) =================

  async function sweepAutoDelete() {
    const s = Storage.getSettings();
    if (!s.autoDeleteHistoryDays) return;
    const cutoff = Date.now() - s.autoDeleteHistoryDays * 86400000;
    const list = await History.list();
    for (const item of list) {
      if (!item.favorite && item.timestamp < cutoff) await History.remove(item.id);
    }
  }

  // ================= Init =================

  async function init() {
    const s = Storage.getSettings();
    applyTheme(s.theme);
    wireFileInput();
    await sweepAutoDelete();
    await renderLatestClipboard();
    renderHomeDevices();
    renderHomeRecent();
    renderQuickSendTargets();
    refreshStatus();
    await Clip.refreshPermissionState();
    Clip.onPendingApplied(() => toast('Copied to your clipboard — paste anywhere'));
    Clip.startWatcher((text) => {
      if (!Storage.getSettings().clipboardSyncEnabled) return;
      if (!Devices.listPeers().some((p) => p.status === 'connected')) return;
      commitClipboardText(text, true);
    });
    navigate('home');
  }

  init();
})();
