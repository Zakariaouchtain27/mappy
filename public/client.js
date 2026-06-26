/* Mappy client: pick a location on a 3D globe -> send a letter -> watch it fly -> chat. */
(function () {
  const socket = io();

  // Free vector style (CARTO dark); globe projection is applied on load.
  const STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

  // ---- Screen helpers ----
  const screens = {
    login: document.getElementById('login-screen'),
    lobby: document.getElementById('lobby-screen'),
    stage: document.getElementById('stage-screen'),
    chat: document.getElementById('chat-screen'),
  };
  function show(name) {
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('active', k === name));
    if (name === 'stage' && stageMap) setTimeout(() => stageMap.resize(), 60);
  }

  // ---- State ----
  let myId = null;
  let me = { name: '', lat: null, lng: null, place: '' };
  let currentRoom = null;

  socket.on('connect', () => { myId = socket.id; });

  // ---- Globe / geometry helpers --------------------------------------------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  // Central angle (radians) between two lat/lng points.
  function angularDist(a, b) {
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  // Great-circle path as [lng, lat] pairs (so the arc bends over the sphere).
  function greatCircle(a, b, steps) {
    const lat1 = toRad(a.lat), lon1 = toRad(a.lng), lat2 = toRad(b.lat), lon2 = toRad(b.lng);
    const d = angularDist(a, b);
    if (d === 0) return [[a.lng, a.lat], [b.lng, b.lat]];
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const A = Math.sin((1 - f) * d) / Math.sin(d);
      const B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
      const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
      const z = A * Math.sin(lat1) + B * Math.sin(lat2);
      pts.push([toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.hypot(x, y)))]);
    }
    return pts;
  }

  const lineFeature = (coords) => ({
    type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
  });

  function enableGlobe(map) {
    try { map.setProjection({ type: 'globe' }); } catch (_) {}
    try {
      map.setSky({
        'sky-color': '#0a0e1f',
        'horizon-color': '#222a52',
        'fog-color': '#0a0e1f',
        'sky-horizon-blend': 0.6,
        'horizon-fog-blend': 0.5,
        'fog-ground-blend': 0.4,
        'atmosphere-blend': 0.7,
      });
    } catch (_) {}
  }

  function pinElement(emoji, label) {
    const el = document.createElement('div');
    el.className = 'map-pin';
    el.innerHTML = `<div class="pin">${emoji}</div>` +
      (label ? `<div class="pin-label">${escapeHtml(label)}</div>` : '');
    return el;
  }
  function flyerElement() {
    const el = document.createElement('div');
    el.className = 'flyer';
    el.textContent = '✉️';
    return el;
  }

  // =========================================================================
  // LOGIN: pick a location on a 3D globe
  // =========================================================================
  const nameInput = document.getElementById('name');
  const placeInput = document.getElementById('place');
  const coordsEl = document.getElementById('coords');
  const enterBtn = document.getElementById('enter-btn');
  const locateBtn = document.getElementById('locate-btn');
  const loginHint = document.getElementById('login-hint');

  const loginMap = new maplibregl.Map({
    container: 'login-map',
    style: STYLE_URL,
    center: [0, 20],
    zoom: 1.1,
    pitch: 30,
    attributionControl: true,
  });
  loginMap.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  loginMap.on('load', () => enableGlobe(loginMap));
  loginMap.on('click', (e) => setMyLocation(e.lngLat.lat, e.lngLat.lng, { fly: false }));

  let myMarker = null;

  function setMyLocation(lat, lng, { fly = true } = {}) {
    me.lat = lat;
    me.lng = lng;
    coordsEl.textContent = `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
    if (!myMarker) {
      myMarker = new maplibregl.Marker({ element: pinElement('📍'), anchor: 'bottom', draggable: true })
        .setLngLat([lng, lat])
        .addTo(loginMap);
      myMarker.on('dragend', () => {
        const p = myMarker.getLngLat();
        setMyLocation(p.lat, p.lng, { fly: false });
      });
    } else {
      myMarker.setLngLat([lng, lat]);
    }
    if (fly) loginMap.flyTo({ center: [lng, lat], zoom: Math.max(loginMap.getZoom(), 5), pitch: 30, duration: 1200 });
    reverseGeocode(lat, lng);
    refreshEnter();
  }

  locateBtn.addEventListener('click', () => {
    if (!navigator.geolocation) {
      loginHint.textContent = 'Geolocation unavailable — click the globe instead.';
      return;
    }
    loginHint.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMyLocation(pos.coords.latitude, pos.coords.longitude);
        loginHint.textContent = 'Pin set! Drag it to fine-tune if needed.';
      },
      () => { loginHint.textContent = 'Could not get your location — click the globe to drop a pin.'; },
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
  // STAGE: the 3D globe fly-across animation
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
  let stageReady = null;
  let flyerMarker = null;
  let endpointMarkers = [];

  function ensureStage() {
    if (stageReady) return stageReady;
    stageMap = new maplibregl.Map({
      container: 'stage-map',
      style: STYLE_URL,
      center: [0, 20],
      zoom: 1.2,
      pitch: 40,
      attributionControl: true,
      antialias: true,
    });
    stageMap.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    stageReady = new Promise((resolve) => {
      stageMap.on('load', () => {
        enableGlobe(stageMap);
        stageMap.addSource('arc', { type: 'geojson', data: lineFeature([]) });
        stageMap.addLayer({
          id: 'arc-glow', type: 'line', source: 'arc',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#00cec9', 'line-width': 9, 'line-opacity': 0.18, 'line-blur': 6 },
        });
        stageMap.addLayer({
          id: 'arc-line', type: 'line', source: 'arc',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#00cec9', 'line-width': 3, 'line-opacity': 0.95, 'line-dasharray': [1.6, 1.4] },
        });
        resolve();
      });
    });
    return stageReady;
  }

  function clearStageMarkers() {
    endpointMarkers.forEach((m) => m.remove());
    endpointMarkers = [];
    if (flyerMarker) { flyerMarker.remove(); flyerMarker = null; }
    if (stageMap.getSource('arc')) stageMap.getSource('arc').setData(lineFeature([]));
  }

  function addPin(emoji, label, p) {
    const m = new maplibregl.Marker({ element: pinElement(emoji, label), anchor: 'bottom' })
      .setLngLat([p.lng, p.lat]).addTo(stageMap);
    endpointMarkers.push(m);
    return m;
  }

  /** Fly a letter from `a` to `b` along a great-circle arc over the globe. */
  async function playArc(a, b, { fromLabel, toLabel } = {}) {
    await ensureStage();
    stageMap.resize();
    clearStageMarkers();

    addPin('🟢', fromLabel, a);
    addPin('📍', toLabel, b);
    flyerMarker = new maplibregl.Marker({ element: flyerElement(), anchor: 'center' })
      .setLngLat([a.lng, a.lat]).addTo(stageMap);

    const coords = greatCircle(a, b, 180);
    const mid = coords[Math.floor(coords.length / 2)];
    const d = angularDist(a, b);
    const zoom = clamp(3.4 - d * 1.7, 0.7, 4.2);

    // Cinematic camera move to frame the journey in 3D.
    stageMap.flyTo({ center: mid, zoom, pitch: 38, bearing: 0, duration: 1500, essential: true });

    return new Promise((resolve) => {
      const duration = 2800;
      let start = null;
      function frame(ts) {
        if (start == null) start = ts;
        const p = Math.min(1, (ts - start) / duration);
        const idx = Math.max(1, Math.floor(easeInOut(p) * (coords.length - 1)));
        stageMap.getSource('arc').setData(lineFeature(coords.slice(0, idx + 1)));
        flyerMarker.setLngLat(coords[idx]);
        if (p < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  // ---- Sender side ----
  async function openStageAsSender(status) {
    show('stage');
    await ensureStage();
    stageMap.resize();
    clearStageMarkers();
    letterPanel.classList.add('hidden');
    waitingPanel.classList.remove('hidden');

    if (me.lat != null) {
      addPin('🟢', 'You', me);
      stageMap.flyTo({ center: [me.lng, me.lat], zoom: 2.6, pitch: 35, duration: 1000 });
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
  socket.on('letter_received', async ({ from, to, text }) => {
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
