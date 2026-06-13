# Mappy

A minimal real-time matchmaking app. Users log in with their **gender** and
**age** (plus optional match preferences), hit **Find Match**, and are paired
with another online user into a private chat.

Built with **Node.js + Express + Socket.IO**. No database — matchmaking state
lives in memory for the lifetime of the server.

## Run it

```bash
npm install
npm start          # serves on http://localhost:3000 (set PORT to override)
```

Open two browser tabs/windows to simulate two users.

## Try the test plan

1. Tab 1 — log in as **User A**, Gender **Male**, Age **25**, click **Find Match**.
2. Tab 2 — log in as **User B**, Gender **Female**, Age **22**, click **Find Match**.
3. Both tabs jump to the chat screen, paired together. Send a message either way.

## Automated test

```bash
npm test
```

Spins up the server on an ephemeral port and drives the full flow with two
Socket.IO clients: register → find match → match found → chat relay, plus a
preference-filtering check.

## How matchmaking works

- On **connect**, the client `register`s its profile (`name`, `gender`, `age`)
  and optional preferences (`lookingFor`, `minAge`, `maxAge`). The server stores
  it keyed by socket id.
- On **`find_match`**, the user is added to a waiting pool. The server scans the
  pool for a **mutually compatible** partner — each side's gender/age preference
  must accept the other (a missing or `any` preference accepts everyone).
- On a match, both sockets join a private room and receive a **`match_found`**
  event carrying the room id and the partner's public profile. The UI switches
  to the chat screen.
- **`chat_message`** events are relayed only within the pair's room. Leaving or
  disconnecting emits **`partner_left`** to the other user and returns them to
  the lobby.

## Socket events

| Event | Direction | Payload |
| --- | --- | --- |
| `register` | client → server | `{ name, gender, age, lookingFor?, minAge?, maxAge? }` (acked) |
| `find_match` | client → server | — |
| `cancel_search` | client → server | — |
| `searching` | server → client | — (no partner available yet) |
| `match_found` | server → client | `{ room, partner: { id, name, gender, age } }` |
| `chat_message` | both ways | `{ room, text }` → `{ from, name, text, ts }` |
| `leave_chat` | client → server | — |
| `partner_left` | server → client | `{ reason: 'left' \| 'disconnected' }` |

## Project layout

```
server.js              Express + Socket.IO server and matchmaking logic
public/index.html      Login/lobby + chat screens
public/client.js       Client socket wiring and UI transitions
public/style.css       Styling
test/matchmaking.test.js  End-to-end matchmaking test
```
