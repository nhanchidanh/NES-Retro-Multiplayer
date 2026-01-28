# NES Retro Multiplayer (Host Stream + Guest Input)

Run a jsnes emulator on the host, stream the canvas via WebRTC, and relay Player 2 input over a PeerJS data channel. The ROM stays on the host.

## Features

- Host runs jsnes and renders a 256x240 NES framebuffer.
- Guest receives a WebRTC video stream and only sends input (keyboard/touch/gamepad).
- No Socket.IO; media stream + data channel only.
- ROM never leaves the host machine.

## Requirements

- Any static HTTP server (or open the files directly for local testing).

## Quick start (local)

Open `index.html` in your browser, then choose Host or Guest.

### Alternative: run a simple static server

Use any static HTTP server (e.g. VSCode Live Server) and open:

- Host: http://localhost:8080/host.html
- Guest: http://localhost:8080/guest.html

## How it works

1. Host opens `host.html`, selects a .nes ROM, and shares the Peer ID.
2. Guest opens `guest.html`, enters the Host ID, and connects.
3. Video streams from host to guest; guest input goes back over the data channel.

## Controls (default)

- Arrows: D-Pad
- Z: A
- X: B
- Enter: Start
- Shift: Select
