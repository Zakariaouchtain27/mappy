# Mappy

Send a letter across a **real map**. You drop a pin on your location, write a
letter, and send it to someone else online. They watch your letter fly across
the map from your location to theirs — and if they like it, they **accept** and
the two of you start chatting.

Built with **Node.js + Express + Socket.IO** on the server and **Leaflet +
OpenStreetMap** for the real maps and the fly-across animation. No database —
state lives in memory for the lifetime of the server.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3000** in two browser tabs/windows to play both
sides. (Set `PORT` to use a different port.)

## The experience

1. **Pick your spot.** On login, click **📍 Use my location** or click the map
   to drop your pin, give yourself a name, and enter.
2. **Write a letter.** In the lobby, write a note and hit **✉️ Send Letter**.
   It goes to another person who's online and free (or waits in a queue until
   someone arrives).
3. **Watch it travel.** The recipient sees a full-screen real map and your
   letter flies along a curved arc from your location to theirs.
4. **Accept & chat.** They read the letter and choose **Accept & Chat** or
   **Pass**. On accept, both of you drop into a private chat.

## Try it with two tabs

1. Tab 1 — name yourself **User A**, set a location (e.g. use your location),
   write a letter, **Send Letter**. You'll see the "delivering" map.
2. Tab 2 — name yourself **User B**, set a *different* location (click somewhere
   far away on the map for a dramatic arc).
3. Tab 2 receives the letter, watches it fly in, and clicks **Accept & Chat**.
4. Both tabs land in the chat. Send messages back and forth.

> Tip: give the two tabs locations far apart (e.g. Paris and New York) so the
> arc animation really shows the journey.

## Automated test

```bash
npm test
```

Drives the whole flow with Socket.IO clients on an ephemeral port: register with
locations → send letter → recipient gets it with both coordinates → accept →
shared room → chat relay, plus the queued-letter case.

## How it works

- On **connect**, the client `register`s `{ name, lat, lng, place }`. The server
  keeps a pool of `available` users.
- **`send_letter`** hands the letter to the first available user (not the
  sender). If nobody is free, it's queued and delivered when someone next comes
  online. The recipient gets **`letter_received`** with the sender's and their
  own coordinates (the data that drives the map arc); the sender gets
  **`letter_delivered`** so they can animate the send too.
- **`accept_letter`** joins both sockets to a private room and emits
  **`letter_accepted`** to each. **`decline_letter`** sends the sender a
  **`letter_declined`** and returns both to the pool.
- **`chat_message`** relays only within the pair's room. Leaving or
  disconnecting emits **`partner_left`**.

## Socket events

| Event | Direction | Payload |
| --- | --- | --- |
| `register` | client → server | `{ name, lat, lng, place }` (acked) |
| `send_letter` | client → server | `{ text }` → ack `{ ok, status: 'delivered' \| 'queued' }` |
| `letter_received` | server → recipient | `{ letterId, text, from, to }` (`from`/`to` carry `lat`/`lng`/`place`) |
| `letter_delivered` | server → sender | `{ to }` |
| `accept_letter` | client → server | — |
| `decline_letter` | client → server | — |
| `cancel_letter` | client → server | — |
| `letter_accepted` | server → both | `{ room, partner }` |
| `letter_declined` | server → sender | — |
| `sender_gone` | server → recipient | — |
| `chat_message` | both ways | `{ room, text }` → `{ from, name, text, ts }` |
| `leave_chat` | client → server | — |
| `partner_left` | server → client | `{ reason: 'left' \| 'disconnected' }` |

## Notes

- Maps use [Leaflet](https://leafletjs.com/) with CARTO/OpenStreetMap tiles
  loaded in the browser, so the client machine needs internet access.
- Place names are filled in best-effort via OpenStreetMap's Nominatim reverse
  geocoder; if it's unavailable the app simply uses coordinates and you can type
  a label yourself.

## Project layout

```
server.js                 Express + Socket.IO server, letter routing & rooms
public/index.html         Login (map), lobby, animation stage, chat
public/client.js          Leaflet maps, the fly-across animation, flow wiring
public/style.css          Styling
test/matchmaking.test.js  End-to-end letter-flow test
```
