# NES Retro Multiplayer (Host Stream + Guest Input)

This project runs a jsnes emulator on the host, streams the canvas via WebRTC, and relays Player 2 input over a PeerJS data channel.

## Features
- Host runs jsnes and renders to a 256x240 canvas.
- Guest only sends input events (keyboard / touch / gamepad). No emulator, no ROM.
- WebRTC media stream for video, data channel for input (no Socket.IO).
- ROM stays on the host machine (local file upload).

## Requirements
- Any static web server (Node.js 18+ included in this repo).

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
- The emulator library and PeerJS are loaded from CDNs. For offline use, download them and serve locally.
- This is input-only sync (no rollback, no state sync, no frame sync).
- PeerJS uses a signaling server for initial connection; after that the connection is P2P.
