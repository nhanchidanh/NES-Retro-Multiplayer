# NES Retro Multiplayer (Host + Guest Input Relay)

This project runs a jsnes emulator on the host and relays only Player 2 key input via raw WebSocket.

## Features
- Host runs jsnes and renders to a 256x240 canvas.
- Guest only sends key input events (no emulator, no ROM).
- Raw WebSocket relay server (no Socket.IO).
- ROM stays on the host machine (local file upload).

## Requirements
- Node.js 18+ (or any recent Node version that supports WebSocket libraries)

## Setup
```bash
npm install
npm start
```

Open the host and guest pages:
- Host: http://localhost:8080/host.html
- Guest: http://localhost:8080/guest.html

## Controls (default)
- Arrows: D-Pad
- Z: A
- X: B
- Enter: Start
- Shift: Select

## Notes
- The emulator library is loaded from a CDN (jsnes). If you need offline usage, download jsnes and serve it locally.
- This is input-only sync (no rollback, no state sync, no frame sync).
