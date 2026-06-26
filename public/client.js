/* Mappy client: pick a location -> send a letter -> watch it fly -> chat. */
(function () {
  const socket = io();

  // Tile layer (free CARTO dark tiles, OSM data).
  const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  const TILE_OPTS = {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  };

  // ---- Screen helpers ----
  const screens = {
    login: document.getElementById('login-screen'),
    lobby: document.getElementById('lobby-screen'),
    stage: document.getElementById('stage-screen'),
    chat: document.getElementById('chat-screen'),
  };
  function show(name) {
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('active', k === name));
    if (name === 'stage' && stageMap) setTimeout(() => stageMap.invalidateSize(), 60);
  }

  // ---- State ----
  let myId = null;
  let me = { name: '', lat: null, lng: null, place: '' };
  let currentRoom = null;

  socket.on('connect', () => { myId = socket.id; });

  // =========================================================================
  // LOGIN: pick a location on a real map
  // =========================================================================
  const nameInput = document.getElementById('name');
  const placeInput = document.getElementById('place');
  const coordsEl = document.getElementById('coords');
  const enterBtn = document.getElementById('enter-btn');
  const locateBtn = document.getElementById('locate-btn');
  const loginHint = document.getElementById('login-hint');

  const loginMap = L.map('login-map', { zoomControl: true }).setView([20, 0], 2);
  L.tileLayer(TILE_URL, TILE_OPTS).addTo(loginMap);
  let myMarker = null;

  function setMyLocation(lat, lng, { fly = true } = {}) {
    me.lat = lat;
    me.lng = lng;
    coordsEl.textContent = `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
    if (!myMarker) {
      myMarker = L.marker([lat, lng], { draggable: true, icon: pinIcon('📍') }).addTo(loginMap);
      myMarker.on('dragend', () => {
        const p = myMarker.getLatLng();
        setMyLocation(p.lat, p.lng, { fly: false });
      });
    } else {
      myMarker.setLatLng([lat, lng]);
    }
    if (fly) loginMap.flyTo([lat, lng], Math.max(loginMap.getZoom(), 10), { duration: 0.8 });
    reverseGeocode(lat, lng);
    refreshEnter();
  }

  loginMap.on('click', (e) => setMyLocation(e.latlng.lat, e.latlng.lng, { fly: false }));

  locateBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      loginHint.textContent = 'Geolocation unavailable — click the map instead.';
      return;
    }
    loginHint.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMyLocation(pos.coords.latitude, pos.coords.longitude);
        loginHint.textContent = 'Pin set! Adjust it by dragging if needed.';
      },
      () => { loginHint.textContent = 'Could not get your location — click the map to drop a pin.'; },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });

  // Best-effort place name; never blocks the flow if it fails.
  async function reverseGeocode(lat, lng) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      const a = data.address || {};
      const city = a.city || a.town || a.village || a.county || '';
      const label = [city, a.country].filter(Boolean).join(', ');
      if (label && !placeInput.value.trim()) placeInput.value = label;
    } catch (_) { /* offline or rate-limited — fine, label stays manual */ }
  }

  function refreshEnter() {
    enterBtn.disabled = !(me.lat != null && me.lng != null && nameInput.value.trim());
  }
  nameInput.addEventListener('input', refreshEnter);

  enterBtn.addEventListener('click', () => {
    me.name = nameInput.value.trim() || 'Anonymous';
    me.place = placeInput.value.trim();
    socket.emit('register', me, () => {
      document.getElementById('lobby-greeting').textContent = `Write a letter, ${me.name}`;
      show('lobby');
    });
  });

  // =========================================================================
  // LOBBY: write & send a letter
  // =========================================================================
  const letterText = document.getElementById('letter-text');
  const sendBtn = document.getElementById('send-letter-btn');
  const lobbyStatus = document.getElementById('lobby-status');

  sendBtn.addEventListener('click', () => {
    const text = letterText.value.trim();
    if (!text) { lobbyStatus.textContent = 'Write something first ✍️'; return; }

    socket.emit('send_letter', { text }, (res) => {
      if (!res || !res.ok) {
        lobbyStatus.textContent = res && res.error === 'busy' ? 'You are already in a conversation.' : 'Could not send.';
        return;
      }
      lobbyStatus.textContent = '';
      openStageAsSender(res.status); // 'delivered' | 'queued'
    });
  });

  // =========================================================================
  // STAGE: the real-map fly-across animation
  // =========================================================================
  const stageBanner = document.getElementById('stage-banner');
  const waitingPanel = document.getElementById('waiting-panel');
  const waitingText = document.getElementById('waiting-text');
  const cancelLetterBtn = document.getElementById('cancel-letter-btn');
  const letterPanel = document.getElementById('letter-panel');
  const letterSender = document.getElementById('letter-sender');
  const letterOrigin = document.getElementById('letter-origin');
  const letterBody = document.getElementById('letter-body');
  const acceptBtn = document.getElementById('accept-btn');
  const passBtn = document.getElementById('pass-btn');

  let stageMap = null;
  let stageLayers = [];

  function ensureStageMap() {
    if (stageMap) return stageMap;
    stageMap = L.map('stage-map', { zoomControl: true, attributionControl: true }).setView([20, 0], 2);
    L.tileLayer(TILE_URL, TILE_OPTS).addTo(stageMap);
    return stageMap;
  }
  function clearStage() {
    stageLayers.forEach((l) => stageMap.removeLayer(l));
    stageLayers = [];
  }
  function addLayer(layer) { layer.addTo(stageMap); stageLayers.push(layer); return layer; }

  function pinIcon(emoji) {
    return L.divIcon({ className: '', html: `<div class="pin">${emoji}</div>`, iconSize: [30, 30], iconAnchor: [15, 28] });
  }
  function labelIcon(text) {
    return L.divIcon({ className: '', html: `<div class="pin-label">${escapeHtml(text)}</div>`, iconSize: [0, 0] });
  }
  function flyerIcon() {
    return L.divIcon({ className: '', html: `<div class="flyer">✉️</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
  }

  // Quadratic-bezier arc points between two coords.
  function arcPoints(a, b, steps) {
    const dLat = b.lat - a.lat, dLng = b.lng - a.lng;
    const curve = 0.22;
    const cLat = (a.lat + b.lat) / 2 + -dLng * curve;
    const cLng = (a.lng + b.lng) / 2 + dLat * curve;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      pts.push([
        u * u * a.lat + 2 * u * t * cLat + t * t * b.lat,
        u * u * a.lng + 2 * u * t * cLng + t * t * b.lng,
      ]);
    }
    return pts;
  }

  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /** Animate a letter flying from `a` to `b`. Returns a promise that resolves when it lands. */
  function playArc(a, b, { fromLabel, toLabel } = {}) {
    ensureStageMap();
    clearStage();

    const A = L.latLng(a.lat, a.lng), B = L.latLng(b.lat, b.lng);
    addLayer(L.marker(A, { icon: pinIcon('🟢'), interactive: false }));
    addLayer(L.marker(B, { icon: pinIcon('📍'), interactive: false }));
    if (fromLabel) addLayer(L.marker(A, { icon: labelIcon(fromLabel), interactive: false }));
    if (toLabel) addLayer(L.marker(B, { icon: labelIcon(toLabel), interactive: false }));

    const steps = 140;
    const pts = arcPoints(A, B, steps);
    const trail = addLayer(L.polyline([pts[0]], { color: '#00cec9', weight: 3, opacity: 0.9, dashArray: '6 8' }));
    const flyer = addLayer(L.marker(pts[0], { icon: flyerIcon(), interactive: false }));

    // Frame the whole journey.
    if (A.distanceTo(B) < 1) {
      stageMap.setView(A, 11);
    } else {
      stageMap.fitBounds(L.latLngBounds(A, B).pad(0.45), { animate: true });
    }

    return new Promise((resolve) => {
      const duration = 2600;
      let start = null;
      function frame(ts) {
        if (start == null) start = ts;
        const p = Math.min(1, (ts - start) / duration);
        const idx = Math.floor(easeInOut(p) * steps);
        flyer.setLatLng(pts[idx]);
        trail.setLatLngs(pts.slice(0, idx + 1));
        if (p < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  // ---- Sender side ----
  function openStageAsSender(status) {
    show('stage');
    ensureStageMap();
    clearStage();
    letterPanel.classList.add('hidden');
    waitingPanel.classList.remove('hidden');

    if (me.lat != null) {
      addLayer(L.marker([me.lat, me.lng], { icon: pinIcon('🟢'), interactive: false }));
      stageMap.setView([me.lat, me.lng], 4);
    }
    if (status === 'queued') {
      stageBanner.textContent = '🕊️ Looking for someone online to receive your letter…';
      waitingText.textContent = 'Your letter is ready and waiting for someone to come online…';
    } else {
      stageBanner.textContent = '✉️ Delivering your letter…';
      waitingText.textContent = 'Delivered. Waiting for them to open your letter…';
    }
  }

  // A recipient was found — fly the letter from me to them.
  socket.on('letter_delivered', async ({ to }) => {
    stageBanner.textContent = '✉️ Your letter is on its way…';
    if (me.lat != null && to && to.lat != null) {
      await playArc(me, to, { fromLabel: 'You', toLabel: to.place || to.name });
    }
    stageBanner.textContent = '📬 Delivered. Waiting for them to open it…';
    waitingText.textContent = `Delivered to ${to && (to.place || to.name) ? (to.place || to.name) : 'a stranger'}. Waiting for them to open your letter…`;
    waitingPanel.classList.remove('hidden');
  });

  cancelLetterBtn.addEventListener('click', () => {
    socket.emit('cancel_letter');
    waitingPanel.classList.add('hidden');
    show('lobby');
    lobbyStatus.textContent = 'Letter cancelled.';
  });

  socket.on('letter_declined', () => {
    waitingPanel.classList.add('hidden');
    show('lobby');
    lobbyStatus.textContent = 'They passed on your letter 💌 — try sending another!';
  });

  // ---- Recipient side ----
  let incoming = null;

  socket.on('letter_received', async ({ from, to, text }) => {
    incoming = { from, text };
    show('stage');
    waitingPanel.classList.add('hidden');
    letterPanel.classList.add('hidden');
    stageBanner.textContent = `✉️ A letter is flying to you${from.place ? ' from ' + from.place : ''}…`;

    if (from.lat != null && to.lat != null) {
      await playArc(from, to, { fromLabel: from.place || from.name, toLabel: 'You' });
    }

    stageBanner.textContent = '📨 You have a letter!';
    letterSender.textContent = from.name || 'Someone';
    letterOrigin.textContent = from.place ? ` · ${from.place}` : '';
    letterBody.textContent = text;
    letterPanel.classList.remove('hidden');
  });

  acceptBtn.addEventListener('click', () => {
    letterPanel.classList.add('hidden');
    socket.emit('accept_letter');
  });
  passBtn.addEventListener('click', () => {
    letterPanel.classList.add('hidden');
    socket.emit('decline_letter');
    show('lobby');
    lobbyStatus.textContent = 'You passed on that letter. Write one of your own?';
  });

  socket.on('sender_gone', () => {
    letterPanel.classList.add('hidden');
    waitingPanel.classList.add('hidden');
    show('lobby');
    lobbyStatus.textContent = 'That letter was withdrawn.';
  });

  // =========================================================================
  // CHAT
  // =========================================================================
  const partnerName = document.getElementById('partner-name');
  const partnerMeta = document.getElementById('partner-meta');
  const messagesEl = document.getElementById('messages');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const leaveBtn = document.getElementById('leave-btn');

  socket.on('letter_accepted', ({ room, partner }) => {
    currentRoom = room;
    waitingPanel.classList.add('hidden');
    letterPanel.classList.add('hidden');

    partnerName.textContent = partner.name || 'Match';
    partnerMeta.textContent = partner.place ? `📍 ${partner.place}` : '';
    messagesEl.innerHTML = '';
    chatInput.disabled = false;
    addSystem(`You're connected with ${partner.name}. Say hello!`);
    show('chat');
    chatInput.focus();
  });

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !currentRoom) return;
    socket.emit('chat_message', { room: currentRoom, text });
    chatInput.value = '';
    chatInput.focus();
  });

  socket.on('chat_message', ({ from, name, text }) => {
    addBubble(text, from === myId ? 'me' : 'them', name);
  });

  socket.on('partner_left', ({ reason }) => {
    addSystem(reason === 'disconnected' ? 'Your match disconnected.' : 'Your match left the chat.');
    chatInput.disabled = true;
  });

  leaveBtn.addEventListener('click', () => {
    socket.emit('leave_chat');
    currentRoom = null;
    show('lobby');
    lobbyStatus.textContent = '';
    letterText.value = '';
  });

  // ---- Render helpers ----
  function addBubble(text, who, name) {
    const div = document.createElement('div');
    div.className = `bubble ${who}`;
    if (who === 'them' && name) {
      const span = document.createElement('span');
      span.className = 'who';
      span.textContent = name;
      div.appendChild(span);
    }
    div.appendChild(document.createTextNode(text));
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function addSystem(text) {
    const div = document.createElement('div');
    div.className = 'system';
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
