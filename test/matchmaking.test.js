/**
 * End-to-end matchmaking test.
 *
 * Mirrors the manual test plan:
 *   - User A logs in as Male, 25
 *   - User B logs in as Female, 22
 *   - Both click "Find Match" and should be paired via `match_found`
 *   - A message sent by one is delivered to the other in the shared room
 *
 * Run with: node test/matchmaking.test.js
 * Exits non-zero on failure.
 */

const assert = require('assert');
const { io: Client } = require('socket.io-client');
const { server } = require('../server');

function connect(port) {
  return new Promise((resolve) => {
    const socket = Client(`http://localhost:${port}`, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
  });
}

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function register(socket, profile) {
  return new Promise((resolve) => socket.emit('register', profile, resolve));
}

async function run() {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const a = await connect(port);
  const b = await connect(port);

  // --- Register both users ---
  const ackA = await register(a, { name: 'User A', gender: 'male', age: 25 });
  const ackB = await register(b, { name: 'User B', gender: 'female', age: 22 });
  assert.strictEqual(ackA.ok, true, 'User A should register');
  assert.strictEqual(ackB.ok, true, 'User B should register');
  assert.strictEqual(ackA.profile.gender, 'male');
  assert.strictEqual(ackB.profile.age, 22);
  console.log('✓ both users registered with stored preferences');

  // --- Find match ---
  const matchA = once(a, 'match_found');
  const matchB = once(b, 'match_found');

  a.emit('find_match'); // A starts searching (no partner yet)
  // small gap so A is in the waiting pool before B searches
  await new Promise((r) => setTimeout(r, 50));
  b.emit('find_match'); // B searches and should pair with A

  const [resA, resB] = await Promise.all([matchA, matchB]);

  assert.ok(resA.room && resB.room, 'both should receive a room');
  assert.strictEqual(resA.room, resB.room, 'both should share the same room');
  assert.strictEqual(resA.partner.name, 'User B', 'A should be matched with User B');
  assert.strictEqual(resB.partner.name, 'User A', 'B should be matched with User A');
  assert.strictEqual(resA.partner.gender, 'female');
  assert.strictEqual(resB.partner.gender, 'male');
  console.log('✓ User A (Male, 25) and User B (Female, 22) were paired');

  // --- Chat relay within the room ---
  const gotByB = once(b, 'chat_message');
  a.emit('chat_message', { room: resA.room, text: 'Hello from A' });
  const msg = await gotByB;
  assert.strictEqual(msg.text, 'Hello from A', 'B should receive A\'s message');
  assert.strictEqual(msg.name, 'User A');
  console.log('✓ chat message relayed across the matched pair');

  // --- Preference filtering: an incompatible third user should not match ---
  const c = await connect(port);
  await register(c, {
    name: 'User C',
    gender: 'male',
    age: 40,
    lookingFor: 'female',
    minAge: 18,
    maxAge: 20, // wants 18-20, so 22-year-old B would be out of range anyway
  });
  let cMatched = false;
  c.on('match_found', () => { cMatched = true; });
  c.emit('find_match');
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(cMatched, false, 'User C should stay unmatched (no compatible partner)');
  console.log('✓ preference filtering keeps incompatible users unmatched');

  a.close();
  b.close();
  c.close();
  await new Promise((resolve) => server.close(resolve));
  console.log('\nAll matchmaking tests passed.');
}

run().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  process.exit(1);
});
