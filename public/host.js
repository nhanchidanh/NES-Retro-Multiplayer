(() => {
  const wsStatus = document.querySelector("#ws-status");
  const guestStatus = document.querySelector("#guest-status");
  const romStatus = document.querySelector("#rom-status");
  const romInput = document.querySelector("#rom-input");
  const canvas = document.querySelector("#screen");
  const ctx = canvas.getContext("2d", { alpha: false });

  const NES_BUTTONS = {
    A: jsnes.Controller.BUTTON_A,
    B: jsnes.Controller.BUTTON_B,
    SELECT: jsnes.Controller.BUTTON_SELECT,
    START: jsnes.Controller.BUTTON_START,
    UP: jsnes.Controller.BUTTON_UP,
    DOWN: jsnes.Controller.BUTTON_DOWN,
    LEFT: jsnes.Controller.BUTTON_LEFT,
    RIGHT: jsnes.Controller.BUTTON_RIGHT,
  };

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

  const imageData = ctx.createImageData(256, 240);
  const frameBufferU32 = new Uint32Array(imageData.data.buffer);

  let running = false;
  let ws = null;
  let nes = null;
  const localPressed = new Set();
  const remotePressed = new Set();
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

  function initNes() {
    nes = new jsnes.NES({
      onFrame(framebuffer) {
        for (let i = 0; i < framebuffer.length; i += 1) {
          frameBufferU32[i] = 0xff000000 | framebuffer[i];
        }
        ctx.putImageData(imageData, 0, 0);
      },
      onStatusUpdate(status) {
        setPill(romStatus, `ROM: ${status}`);
      },
    });
  }

  function frameLoop() {
    if (!running) return;
    nes.frame();
    requestAnimationFrame(frameLoop);
  }

  function loadRom(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      if (reader.readAsBinaryString) {
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsBinaryString(file);
        return;
      }
      reader.onload = () => {
        const bytes = new Uint8Array(reader.result);
        const chunk = 0x8000;
        let binary = "";
        for (let i = 0; i < bytes.length; i += chunk) {
          const slice = bytes.subarray(i, i + chunk);
          binary += String.fromCharCode.apply(null, slice);
        }
        resolve(binary);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  function applyLocalInput(code, pressed) {
    const btnName = KEY_MAP[code];
    if (!btnName) return;
    const nesBtn = NES_BUTTONS[btnName];
    if (pressed) {
      nes.buttonDown(1, nesBtn);
      localPressed.add(code);
    } else {
      nes.buttonUp(1, nesBtn);
      localPressed.delete(code);
    }
  }

  function applyRemoteInput(btnName, pressed) {
    const nesBtn = NES_BUTTONS[btnName];
    if (nesBtn === undefined) return;
    if (pressed) {
      if (remotePressed.has(btnName)) return;
      nes.buttonDown(2, nesBtn);
      remotePressed.add(btnName);
    } else {
      if (!remotePressed.has(btnName)) return;
      nes.buttonUp(2, nesBtn);
      remotePressed.delete(btnName);
    }
  }

  function releaseAllRemote() {
    for (const btnName of remotePressed) {
      const nesBtn = NES_BUTTONS[btnName];
      if (nesBtn !== undefined) nes.buttonUp(2, nesBtn);
    }
    remotePressed.clear();
  }

  function releaseAllLocal() {
    for (const code of localPressed) {
      const btnName = KEY_MAP[code];
      if (!btnName) continue;
      const nesBtn = NES_BUTTONS[btnName];
      nes.buttonUp(1, nesBtn);
    }
    localPressed.clear();
  }

  function connectWs() {
    const wsUrl = location.origin.replace(/^http/, "ws");
    ws = new WebSocket(wsUrl);

    ws.addEventListener("open", () => {
      setPill(wsStatus, "WS: connected");
      retryMs = 800;
      ws.send(JSON.stringify({ type: "role", role: "host" }));
    });

    ws.addEventListener("close", () => {
      setPill(wsStatus, "WS: disconnected", true);
      setPill(guestStatus, "Guest: waiting", true);
      releaseAllRemote();
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

      if (msg.type === "input") {
        applyRemoteInput(msg.btn, msg.pressed);
        return;
      }

      if (msg.type === "guest_joined") {
        setPill(guestStatus, "Guest: connected");
        releaseAllRemote();
      }

      if (msg.type === "guest_left") {
        setPill(guestStatus, "Guest: waiting", true);
        releaseAllRemote();
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
    if (!KEY_MAP[event.code]) return;
    event.preventDefault();
    applyLocalInput(event.code, true);
  });

  window.addEventListener("keyup", (event) => {
    if (!KEY_MAP[event.code]) return;
    event.preventDefault();
    applyLocalInput(event.code, false);
  });

  window.addEventListener("blur", () => {
    releaseAllLocal();
  });

  romInput.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      setPill(romStatus, `ROM: loading ${file.name}`);
      const romData = await loadRom(file);
      nes.loadROM(romData);
      setPill(romStatus, `ROM: ${file.name}`);
      if (!running) {
        running = true;
        requestAnimationFrame(frameLoop);
      }
    } catch (err) {
      setPill(romStatus, "ROM: failed", true);
      console.error(err);
    }
  });

  initNes();
  connectWs();
})();
