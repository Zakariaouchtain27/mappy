/**
 * End-to-end test for the letter -> accept -> chat flow.
 *
 *   - User A (in Paris) and User B (in New York) both come online.
 *   - A writes a letter and sends it; B receives it with both real locations.
 *   - B accepts; both are placed in a shared room and can chat.
 *   - A queued letter (sent while nobody is free) is delivered once a new
 *     user comes online.
 *
 * Run with: node test/matchmaking.test.js   (exits non-zero on failure)
 */

const assert = require('assert');
const { io: Client } = require('socket.io-client');
const { server } = require('../server');

const PARIS = { lat: 48.8566, lng: 2.3522, place: 'Paris, France' };
const NYC = { lat: 40.7128, lng: -74.006, place: 'New York, USA' };
const TOKYO = { lat: 35.6762, lng: 139.6503, place: 'Tokyo, Japan' };

function connect(port) {
  return new Promise((resolve) => {
    const socket = Client(`http://localhost:${port}`, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
  });
}
const once = (socket, event) => new Promise((res) => socket.once(event, res));
const register = (socket, profile) => new Promise((res) => socket.emit('register', profile, res));
const sendLetter = (socket, text) => new Promise((res) => socket.emit('send_letter', { text }, res));

async function run() {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const a = await connect(port);
  const b = await connect(port);

  // --- Register both with real locations ---
  const ackA = await register(a, { name: 'User A', ...PARIS });
  const ackB = await register(b, { name: 'User B', ...NYC });
  assert.strictEqual(ackA.ok, true);
  assert.strictEqual(ackB.ok, true);
  assert.strictEqual(ackA.profile.place, 'Paris, France');
  console.log('✓ both users registered with real locations stored');

  // --- A sends a letter; B receives it ---
  const bGetsLetter = once(b, 'letter_received');
  const aDelivered = once(a, 'letter_delivered');
  const sendAck = await sendLetter(a, 'Dear stranger, hello from Paris!');
  assert.strictEqual(sendAck.ok, true);
  assert.strictEqual(sendAck.status, 'delivered');

  const letter = await bGetsLetter;
  assert.strictEqual(letter.text, 'Dear stranger, hello from Paris!');
  assert.strictEqual(letter.from.name, 'User A');
  assert.ok(Math.abs(letter.from.lat - PARIS.lat) < 1e-6, 'sender lat carried through');
  assert.ok(Math.abs(letter.to.lng - NYC.lng) < 1e-6, 'recipient lng carried through');
  console.log('✓ letter delivered with sender + recipient coordinates (the map arc data)');

  const delivered = await aDelivered;
  assert.strictEqual(delivered.to.name, 'User B');
  console.log('✓ sender notified of delivery (so they can animate the send)');

  // --- B accepts -> both land in the same room ---
  const aAccepted = once(a, 'letter_accepted');
  const bAccepted = once(b, 'letter_accepted');
  b.emit('accept_letter');
  const [ra, rb] = await Promise.all([aAccepted, bAccepted]);
  assert.ok(ra.room && ra.room === rb.room, 'both share one room');
  assert.strictEqual(ra.partner.name, 'User B');
  assert.strictEqual(rb.partner.name, 'User A');
  console.log('✓ acceptance opens a shared chat room for both users');

  // --- Chat relay ---
  const bMsg = once(b, 'chat_message');
  a.emit('chat_message', { room: ra.room, text: 'Hi from Paris!' });
  const msg = await bMsg;
  assert.strictEqual(msg.text, 'Hi from Paris!');
  assert.strictEqual(msg.name, 'User A');
  console.log('✓ chat messages relay between the matched pair');

  // --- Queued letter: sent with nobody free, delivered when someone arrives ---
  const c = await connect(port);
  await register(c, { name: 'User C', ...TOKYO });
  const queuedAck = await sendLetter(c, 'Anyone out there?');
  assert.strictEqual(queuedAck.status, 'queued', 'no one free -> letter is queued');

  const d = await connect(port);
  const dGetsLetter = once(d, 'letter_received');
  await register(d, { name: 'User D', ...PARIS });
  const queuedLetter = await dGetsLetter;
  assert.strictEqual(queuedLetter.text, 'Anyone out there?');
  assert.strictEqual(queuedLetter.from.name, 'User C');
  console.log('✓ queued letter is delivered when a new user comes online');

  [a, b, c, d].forEach((s) => s.close());
  await new Promise((resolve) => server.close(resolve));
  console.log('\nAll letter-flow tests passed.');
}

run().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
