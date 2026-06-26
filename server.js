/**
 * Mappy — send a letter across a real map.
 *
 * Flow:
 *   1. A user `register`s with a name and a real-world location (lat/lng).
 *   2. They write a letter and `send_letter`. The server hands it to another
 *      online, available user (or queues it until someone is free).
 *   3. The recipient watches the letter fly across the map from the sender's
 *      location to theirs, reads it, and either accepts or passes.
 *   4. On accept, both users join a private room (`letter_accepted`) and chat.
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
 *   id, name, lat, lng, place,
 *   status,        // 'available' | 'waiting' | 'receiving' | 'chatting'
 *   letter,        // recipient side: { id, senderId, text } currently being read
 *   partnerId, room
 * }
 */
const users = new Map();

// Socket ids that are online and free to receive a letter (FIFO for fairness).
const available = [];

// Letters with no recipient yet: { id, senderId, text }.
const pendingLetters = [];

let letterSeq = 0;

function removeAvailable(id) {
  const idx = available.indexOf(id);
  if (idx !== -1) available.splice(idx, 1);
}

function publicProfile(user) {
  return {
    id: user.id,
    name: user.name,
    place: user.place,
    lat: user.lat,
    lng: user.lng,
  };
}

/** Make a user available and try to hand them a letter that's waiting. */
function markAvailable(user) {
  user.status = 'available';
  user.letter = null;
  user.partnerId = null;
  user.room = null;
  if (!available.includes(user.id)) available.push(user.id);
  fulfillPendingFor(user);
}

/** Deliver a queued letter to a freshly-available user, if one fits. */
function fulfillPendingFor(user) {
  for (let i = 0; i < pendingLetters.length; i++) {
    const letter = pendingLetters[i];
    if (letter.senderId === user.id) continue;
    const sender = users.get(letter.senderId);
    if (!sender || sender.status !== 'waiting') {
      // Sender vanished; drop the stale letter.
      pendingLetters.splice(i, 1);
      i--;
      continue;
    }
    pendingLetters.splice(i, 1);
    deliverLetter(sender, user, letter.text, letter.id);
    return;
  }
}

/** Send `text` from `sender` to a specific `recipient`. */
function deliverLetter(sender, recipient, text, letterId) {
  removeAvailable(recipient.id);
  removeAvailable(sender.id);

  sender.status = 'waiting';
  recipient.status = 'receiving';
  recipient.letter = { id: letterId, senderId: sender.id, text };
  sender.partnerId = recipient.id; // provisional link until accept/decline

  io.to(recipient.id).emit('letter_received', {
    letterId,
    text,
    from: publicProfile(sender),
    to: publicProfile(recipient),
  });

  io.to(sender.id).emit('letter_delivered', {
    to: publicProfile(recipient),
  });
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  users.set(socket.id, {
    id: socket.id,
    name: 'Anonymous',
    lat: null,
    lng: null,
    place: '',
    status: 'available',
    letter: null,
    partnerId: null,
    room: null,
  });

  // Store profile + location supplied at login.
  socket.on('register', (data = {}, ack) => {
    const user = users.get(socket.id);
    if (!user) return;

    user.name = String(data.name || 'Anonymous').slice(0, 40).trim() || 'Anonymous';
    user.place = String(data.place || '').slice(0, 80).trim();

    const lat = Number(data.lat);
    const lng = Number(data.lng);
    user.lat = Number.isFinite(lat) ? lat : null;
    user.lng = Number.isFinite(lng) ? lng : null;

    markAvailable(user);
    if (typeof ack === 'function') ack({ ok: true, profile: publicProfile(user) });
  });

  // Write a letter and send it into the world.
  socket.on('send_letter', (data = {}, ack) => {
    const sender = users.get(socket.id);
    if (!sender) return;
    if (sender.status !== 'available') {
      if (typeof ack === 'function') ack({ ok: false, error: 'busy' });
      return;
    }

    const text = String(data.text || '').slice(0, 2000).trim();
    if (!text) {
      if (typeof ack === 'function') ack({ ok: false, error: 'empty' });
      return;
    }

    const letterId = `L${++letterSeq}`;
    const recipientId = available.find((id) => id !== socket.id);

    if (recipientId) {
      deliverLetter(sender, users.get(recipientId), text, letterId);
      if (typeof ack === 'function') ack({ ok: true, status: 'delivered' });
    } else {
      // Nobody free yet — hold the letter until someone comes online.
      removeAvailable(socket.id);
      sender.status = 'waiting';
      pendingLetters.push({ id: letterId, senderId: socket.id, text });
      if (typeof ack === 'function') ack({ ok: true, status: 'queued' });
    }
  });

  // Recipient likes the letter -> open a chat for both.
  socket.on('accept_letter', () => {
    const recipient = users.get(socket.id);
    if (!recipient || recipient.status !== 'receiving' || !recipient.letter) return;

    const sender = users.get(recipient.letter.senderId);
    if (!sender) {
      socket.emit('sender_gone');
      markAvailable(recipient);
      return;
    }

    const room = `room-${sender.id}-${recipient.id}`;
    sender.status = recipient.status = 'chatting';
    sender.room = recipient.room = room;
    sender.partnerId = recipient.id;
    recipient.partnerId = sender.id;
    recipient.letter = null;

    socket.join(room);
    io.sockets.sockets.get(sender.id)?.join(room);

    io.to(recipient.id).emit('letter_accepted', { room, partner: publicProfile(sender) });
    io.to(sender.id).emit('letter_accepted', { room, partner: publicProfile(recipient) });
  });

  // Recipient passes on the letter.
  socket.on('decline_letter', () => {
    const recipient = users.get(socket.id);
    if (!recipient || recipient.status !== 'receiving' || !recipient.letter) return;

    const sender = users.get(recipient.letter.senderId);
    if (sender) {
      io.to(sender.id).emit('letter_declined');
      markAvailable(sender);
    }
    markAvailable(recipient);
  });

  // Cancel a letter that's still waiting to be opened.
  socket.on('cancel_letter', () => {
    const sender = users.get(socket.id);
    if (!sender || sender.status !== 'waiting') return;

    // Remove from the pending queue if it never found a recipient.
    for (let i = pendingLetters.length - 1; i >= 0; i--) {
      if (pendingLetters[i].senderId === socket.id) pendingLetters.splice(i, 1);
    }

    // If it had already been delivered, return the recipient to the pool.
    const recipient = sender.partnerId ? users.get(sender.partnerId) : null;
    if (recipient && recipient.status === 'receiving') {
      io.to(recipient.id).emit('sender_gone');
      markAvailable(recipient);
    }
    markAvailable(sender);
  });

  // Relay a chat message within the pair's room.
  socket.on('chat_message', (data = {}) => {
    const user = users.get(socket.id);
    if (!user || user.status !== 'chatting' || !user.room) return;

    const text = String(data.text || '').slice(0, 2000).trim();
    if (!text) return;

    io.to(user.room).emit('chat_message', {
      from: user.id,
      name: user.name,
      text,
      ts: Date.now(),
    });
  });

  socket.on('leave_chat', () => endPairing(socket.id, 'left'));

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      if (user.status === 'chatting') {
        endPairing(socket.id, 'disconnected');
      } else if (user.status === 'waiting') {
        // Sender left: drop pending letters, free any recipient mid-read.
        for (let i = pendingLetters.length - 1; i >= 0; i--) {
          if (pendingLetters[i].senderId === socket.id) pendingLetters.splice(i, 1);
        }
        const recipient = user.partnerId ? users.get(user.partnerId) : null;
        if (recipient && recipient.status === 'receiving') {
          io.to(recipient.id).emit('sender_gone');
          markAvailable(recipient);
        }
      } else if (user.status === 'receiving' && user.letter) {
        // Recipient left mid-read: tell the sender it wasn't opened.
        const sender = users.get(user.letter.senderId);
        if (sender) {
          io.to(sender.id).emit('letter_declined');
          markAvailable(sender);
        }
      }
    }
    removeAvailable(socket.id);
    users.delete(socket.id);
  });

  /** Tear down a chat pairing and return both users to the pool. */
  function endPairing(id, reason) {
    const user = users.get(id);
    if (!user || user.status !== 'chatting') return;

    const room = user.room;
    const partner = user.partnerId ? users.get(user.partnerId) : null;

    io.sockets.sockets.get(id)?.leave(room);
    if (partner) {
      io.to(partner.id).emit('partner_left', { reason });
      io.sockets.sockets.get(partner.id)?.leave(room);
      markAvailable(partner);
    }
    // The leaver returns to the pool too (their own client decides where to go).
    markAvailable(user);
  }
});

// Only listen when run directly, so tests can bind their own port.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Mappy running at http://localhost:${PORT}`);
  });
}

module.exports = { app, server, io };
