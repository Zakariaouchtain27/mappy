/* Mappy client: login -> find match -> chat. */
(function () {
  const socket = io();

  // Screens
  const loginScreen = document.getElementById('login-screen');
  const chatScreen = document.getElementById('chat-screen');

  // Login elements
  const loginForm = document.getElementById('login-form');
  const findBtn = document.getElementById('find-match-btn');
  const cancelBtn = document.getElementById('cancel-search-btn');
  const statusEl = document.getElementById('status');

  // Chat elements
  const partnerName = document.getElementById('partner-name');
  const partnerMeta = document.getElementById('partner-meta');
  const messagesEl = document.getElementById('messages');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const leaveBtn = document.getElementById('leave-btn');

  let registered = false;
  let currentRoom = null;
  let myId = null;

  socket.on('connect', () => { myId = socket.id; });

  function show(screen) {
    loginScreen.classList.toggle('active', screen === 'login');
    chatScreen.classList.toggle('active', screen === 'chat');
  }

  function setSearching(isSearching) {
    findBtn.disabled = isSearching;
    findBtn.textContent = isSearching ? 'Searching…' : 'Find Match';
    cancelBtn.classList.toggle('hidden', !isSearching);
  }

  // ---- Login -> register + find match ----
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const profile = {
      name: document.getElementById('name').value.trim(),
      gender: document.getElementById('gender').value,
      age: document.getElementById('age').value,
      lookingFor: document.getElementById('lookingFor').value,
      minAge: document.getElementById('minAge').value,
      maxAge: document.getElementById('maxAge').value,
    };

    if (!profile.name || !profile.gender || !profile.age) {
      statusEl.textContent = 'Please fill in name, gender and age.';
      return;
    }

    // Store preferences on the server, then start searching.
    socket.emit('register', profile, () => {
      registered = true;
      setSearching(true);
      statusEl.textContent = 'Looking for a match…';
      socket.emit('find_match');
    });
  });

  cancelBtn.addEventListener('click', () => {
    socket.emit('cancel_search');
    setSearching(false);
    statusEl.textContent = 'Search cancelled.';
  });

  socket.on('searching', () => {
    statusEl.textContent = 'Waiting for a compatible user to come online…';
  });

  // ---- Match found -> move to chat ----
  socket.on('match_found', ({ room, partner }) => {
    currentRoom = room;
    setSearching(false);
    statusEl.textContent = '';

    partnerName.textContent = partner.name || 'Match';
    const meta = [];
    if (partner.gender) meta.push(capitalize(partner.gender));
    if (partner.age) meta.push(`${partner.age}`);
    partnerMeta.textContent = meta.join(' · ');

    messagesEl.innerHTML = '';
    addSystem(`You matched with ${partner.name}. Say hi!`);
    show('chat');
    chatInput.focus();
  });

  // ---- Chat ----
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
    addSystem(reason === 'disconnected'
      ? 'Your match disconnected.'
      : 'Your match left the chat.');
    chatInput.disabled = true;
  });

  leaveBtn.addEventListener('click', () => {
    socket.emit('leave_chat');
    returnToLobby();
  });

  function returnToLobby() {
    currentRoom = null;
    chatInput.disabled = false;
    chatInput.value = '';
    show('login');
    setSearching(false);
    statusEl.textContent = 'You left the chat. Find another match?';
  }

  // ---- Rendering helpers ----
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

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }
})();
