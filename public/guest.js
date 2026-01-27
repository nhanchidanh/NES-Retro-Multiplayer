(() => {
  const wsStatus = document.querySelector("#ws-status");
  const hostStatus = document.querySelector("#host-status");

  const KEY_MAP = {
    ArrowUp: "UP",
    ArrowDown: "DOWN",
    ArrowLeft: "LEFT",
    ArrowRight: "RIGHT",
    KeyZ: "A",
    KeyX: "B",
    Enter: "START",
    ShiftLeft: "SELECT",
    ShiftRight: "SELECT",
  };

  let ws = null;
  const pressed = new Set();
  let retryMs = 800;
  let reconnectTimer = null;

  function setPill(el, text, warn = false) {
    el.textContent = text;
    if (warn) {
      el.dataset.tone = "warn";
    } else {
      el.dataset.tone = "";
    }
  }

  function sendInput(btn, pressedState) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "input", btn, pressed: pressedState }));
  }

  function releaseAll() {
    for (const code of pressed) {
      const btn = KEY_MAP[code];
      if (btn) sendInput(btn, false);
    }
    pressed.clear();
  }

  function connectWs() {
    const wsUrl = location.origin.replace(/^http/, "ws");
    ws = new WebSocket(wsUrl);

    ws.addEventListener("open", () => {
      setPill(wsStatus, "WS: connected");
      retryMs = 800;
      ws.send(JSON.stringify({ type: "role", role: "guest" }));
    });

    ws.addEventListener("close", () => {
      setPill(wsStatus, "WS: disconnected", true);
      setPill(hostStatus, "Host: offline", true);
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      if (ws.readyState === WebSocket.OPEN) return;
      ws.close();
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "status") {
        if (msg.message === "host_ready") {
          setPill(hostStatus, "Host: ready");
        }
        if (msg.message === "waiting_host") {
          setPill(hostStatus, "Host: waiting", true);
        }
        if (msg.message === "host_left") {
          setPill(hostStatus, "Host: offline", true);
        }
      }
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWs();
      retryMs = Math.min(retryMs * 1.6, 8000);
    }, retryMs);
  }

  window.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    const btn = KEY_MAP[event.code];
    if (!btn) return;
    event.preventDefault();
    pressed.add(event.code);
    sendInput(btn, true);
  });

  window.addEventListener("keyup", (event) => {
    const btn = KEY_MAP[event.code];
    if (!btn) return;
    event.preventDefault();
    pressed.delete(event.code);
    sendInput(btn, false);
  });

  window.addEventListener("blur", () => {
    releaseAll();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseAll();
  });

  connectWs();
})();
