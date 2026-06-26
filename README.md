# Mappy

Send a letter across a **real 3D globe**. You drop a pin on your location, write
a letter, and send it to someone else online. They watch your letter fly across
a spinning, tiltable globe from your location to theirs along a great-circle arc
— and if they like it, they **accept** and the two of you start chatting.

Built with **Node.js + Express + Socket.IO** on the server and **MapLibre GL JS**
(globe projection) with **OpenStreetMap/CARTO** tiles for the 3D map and the
fly-across animation. No database — state lives in memory for the lifetime of the
server. MapLibre is vendored from npm and served by the app, so the library needs
no CDN (only the map tiles load from the network).

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3000** in two browser tabs/windows to play both
sides. (Set `PORT` to use a different port.)

## The experience

1. **Pick your spot.** On login, click **📍 Use my location** or click the 3D
   globe to drop your pin, give yourself a name, and enter.
2. **Write a letter.** In the lobby, write a note and hit **✉️ Send Letter**.
   It goes to another person who's online and free (or waits in a queue until
   someone arrives).
3. **Watch it travel.** The recipient sees a full-screen 3D globe and your letter
   flies along a great-circle arc from your location to theirs. Drag to spin the
   globe, right-drag (or use the control) to tilt it.
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

- The 3D map uses [MapLibre GL JS](https://maplibre.org/) with globe projection.
  The library is vendored (served from `node_modules` at `/vendor/maplibre-gl`),
  so no CDN is needed — but the map **tiles** load from CARTO/OpenStreetMap, so
  the browser still needs internet access. A WebGL-capable browser is required.
- Place names are filled in best-effort via OpenStreetMap's Nominatim reverse
  geocoder; if it's unavailable the app simply uses coordinates and you can type
  a label yourself.

## Troubleshooting

- **Blank map / empty box on the login screen.** The page renders but the globe
  doesn't. Usually the server wasn't restarted after pulling, or dependencies
  weren't installed. Fix: stop the server (`Ctrl + C`), then `npm install` and
  `npm start` again, and hard-refresh the browser (`Ctrl + Shift + R`). The
  client also falls back to loading MapLibre from a CDN automatically, and if the
  map still can't render it shows a message and you can continue with **Use my
  location** or by typing your city — the rest of the app works without the map.
- **"Map tiles couldn't load."** Your network/firewall is blocking the map tiles
  (`basemaps.cartocdn.com`). The app still works; you just won't see the globe.

## Project layout

```
server.js                 Express + Socket.IO server, letter routing & rooms
public/index.html         Login (map), lobby, animation stage, chat
public/client.js          MapLibre 3D globe, the fly-across animation, flow wiring
public/style.css          Styling
test/matchmaking.test.js  End-to-end letter-flow test
```
