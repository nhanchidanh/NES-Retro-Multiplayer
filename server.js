const http = require("http");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const safePath = decodeURIComponent(urlPath);
  const relPath = safePath.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, relPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocket.Server({ server });
const HEARTBEAT_MS = 15000;

let host = null;
let guest = null;

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Ignore send failures on closing sockets.
  }
}

function setRole(ws, role) {
  if (role === "host") {
    if (host && host !== ws && host.readyState === WebSocket.OPEN) {
      safeSend(ws, { type: "error", message: "host_taken" });
      ws.close(4000, "host_taken");
      return;
    }
    host = ws;
    ws.role = "host";
    safeSend(ws, { type: "status", message: "host_ready" });
    if (guest) safeSend(ws, { type: "guest_joined" });
    if (guest) safeSend(guest, { type: "status", message: "host_ready" });
    return;
  }

  if (role === "guest") {
    if (guest && guest !== ws && guest.readyState === WebSocket.OPEN) {
      safeSend(ws, { type: "error", message: "guest_taken" });
      ws.close(4001, "guest_taken");
      return;
    }
    guest = ws;
    ws.role = "guest";
    safeSend(ws, { type: "status", message: host ? "host_ready" : "waiting_host" });
    if (host) safeSend(host, { type: "guest_joined" });
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "role") {
      setRole(ws, msg.role);
      return;
    }

    if (msg.type === "input") {
      if (ws.role !== "guest") return;
      if (!host) return;
      safeSend(host, msg);
    }
  });

  ws.on("close", () => {
    if (ws === host) {
      host = null;
      if (guest) safeSend(guest, { type: "status", message: "host_left" });
    }
    if (ws === guest) {
      guest = null;
      if (host) safeSend(host, { type: "guest_left" });
    }
  });

  ws.on("error", () => {});
});

const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, HEARTBEAT_MS);

server.on("close", () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
