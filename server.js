/**
 * Mappy — real-time matchmaking server.
 *
 * Flow:
 *   1. A client connects and `register`s with their profile
 *      (name, gender, age) plus optional matching preferences.
 *   2. The client emits `find_match`. The server places them in a
 *      waiting pool and looks for another waiting user whose profile and
 *      preferences are mutually compatible.
 *   3. When two users match, the server joins them to a private room and
 *      emits `match_found` to both, who then move to the chat screen.
 *   4. Chat messages are relayed only within the pair's room.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/**
 * socket.id -> {
 *   id, name, gender, age,
 *   lookingFor,            // 'any' | 'male' | 'female' | 'other'
 *   minAge, maxAge,        // desired partner age range
 *   status,                // 'idle' | 'searching' | 'matched'
 *   room, partnerId
 * }
 */
const users = new Map();

// Ordered list of socket ids currently searching for a match.
const waiting = [];

function removeFromWaiting(id) {
  const idx = waiting.indexOf(id);
  if (idx !== -1) waiting.splice(idx, 1);
}

/**
 * Does `me` accept `other` as a match?
 * Checks the gender preference and the age range. A missing/`any`
 * preference accepts anyone.
 */
function accepts(me, other) {
  if (me.lookingFor && me.lookingFor !== 'any' && other.gender !== me.lookingFor) {
    return false;
  }
  if (Number.isFinite(me.minAge) && other.age < me.minAge) return false;
  if (Number.isFinite(me.maxAge) && other.age > me.maxAge) return false;
  return true;
}

/** A match requires both sides to accept each other. */
function isCompatible(a, b) {
  return accepts(a, b) && accepts(b, a);
}

/**
 * Find a waiting partner compatible with `user`. Returns the partner's
 * socket id, or null if none is available.
 */
function findCompatiblePartner(user) {
  for (const candidateId of waiting) {
    if (candidateId === user.id) continue;
    const candidate = users.get(candidateId);
    if (!candidate || candidate.status !== 'searching') continue;
    if (isCompatible(user, candidate)) return candidateId;
  }
  return null;
}

function publicProfile(user) {
  return { id: user.id, name: user.name, gender: user.gender, age: user.age };
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  // Seed a default record so a stray `find_match` before `register` is safe.
  users.set(socket.id, {
    id: socket.id,
    name: 'Anonymous',
    gender: 'other',
    age: null,
    lookingFor: 'any',
    minAge: null,
    maxAge: null,
    status: 'idle',
    room: null,
    partnerId: null,
  });

  // Store profile + preferences supplied at login.
  socket.on('register', (data = {}, ack) => {
    const user = users.get(socket.id);
    if (!user) return;

    user.name = String(data.name || 'Anonymous').slice(0, 40).trim() || 'Anonymous';
    user.gender = ['male', 'female', 'other'].includes(data.gender) ? data.gender : 'other';

    const age = Number.parseInt(data.age, 10);
    user.age = Number.isFinite(age) ? age : null;

    user.lookingFor = ['any', 'male', 'female', 'other'].includes(data.lookingFor)
      ? data.lookingFor
      : 'any';

    const minAge = Number.parseInt(data.minAge, 10);
    const maxAge = Number.parseInt(data.maxAge, 10);
    user.minAge = Number.isFinite(minAge) ? minAge : null;
    user.maxAge = Number.isFinite(maxAge) ? maxAge : null;

    if (typeof ack === 'function') ack({ ok: true, profile: publicProfile(user) });
  });

  // Begin (or restart) the search for a match.
  socket.on('find_match', () => {
    const user = users.get(socket.id);
    if (!user || user.status === 'matched') return;

    user.status = 'searching';
    if (!waiting.includes(socket.id)) waiting.push(socket.id);

    const partnerId = findCompatiblePartner(user);
    if (!partnerId) {
      socket.emit('searching');
      return;
    }

    const partner = users.get(partnerId);

    // Pair them up.
    removeFromWaiting(socket.id);
    removeFromWaiting(partnerId);

    const room = `room-${socket.id}-${partnerId}`;
    user.status = partner.status = 'matched';
    user.room = partner.room = room;
    user.partnerId = partnerId;
    partner.partnerId = socket.id;

    socket.join(room);
    io.sockets.sockets.get(partnerId)?.join(room);

    socket.emit('match_found', { room, partner: publicProfile(partner) });
    io.to(partnerId).emit('match_found', { room, partner: publicProfile(user) });
  });

  // Stop searching while still on the lobby screen.
  socket.on('cancel_search', () => {
    const user = users.get(socket.id);
    if (!user) return;
    removeFromWaiting(socket.id);
    if (user.status === 'searching') user.status = 'idle';
  });

  // Relay a chat message to the partner within the shared room.
  socket.on('chat_message', (data = {}) => {
    const user = users.get(socket.id);
    if (!user || user.status !== 'matched' || !user.room) return;

    const text = String(data.text || '').slice(0, 2000).trim();
    if (!text) return;

    io.to(user.room).emit('chat_message', {
      from: user.id,
      name: user.name,
      text,
      ts: Date.now(),
    });
  });

  // Leave the current chat and return both users to an idle state.
  socket.on('leave_chat', () => endPairing(socket.id, 'left'));

  socket.on('disconnect', () => {
    endPairing(socket.id, 'disconnected');
    removeFromWaiting(socket.id);
    users.delete(socket.id);
  });

  /** Tear down a pairing and notify the partner. */
  function endPairing(id, reason) {
    const user = users.get(id);
    if (!user || user.status !== 'matched') return;

    const room = user.room;
    const partner = user.partnerId ? users.get(user.partnerId) : null;

    if (partner) {
      io.to(partner.id).emit('partner_left', { reason });
      partner.status = 'idle';
      partner.room = null;
      partner.partnerId = null;
      io.sockets.sockets.get(partner.id)?.leave(room);
    }

    user.status = 'idle';
    user.room = null;
    user.partnerId = null;
    io.sockets.sockets.get(id)?.leave(room);
  }
});

// Only start listening when run directly (`node server.js`), so tests can
// import the app and bind to an ephemeral port themselves.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Mappy running at http://localhost:${PORT}`);
  });
}

module.exports = { app, server, io };
