(() => {
  const peerStatus = document.querySelector("#peer-status");
  const guestStatus = document.querySelector("#guest-status");
  const streamStatus = document.querySelector("#stream-status");
  const romStatus = document.querySelector("#rom-status");
  const romInput = document.querySelector("#rom-input");
  const canvas = document.querySelector("#screen");
  const ctx = canvas.getContext("2d", { alpha: false });
  const peerIdEl = document.querySelector("#peer-id");
  const copyIdBtn = document.querySelector("#copy-id");
  const controlButtons = Array.from(document.querySelectorAll(".host-overlay [data-btn]"));
  const videoFrame = document.querySelector("#video-frame");
  const fullscreenBtn = document.querySelector("#fullscreen-btn");
  const NES_WIDTH = 256;
  const NES_HEIGHT = 240;
  const SCALE = 3;
  const OUTPUT_WIDTH = NES_WIDTH * SCALE;
  const OUTPUT_HEIGHT = NES_HEIGHT * SCALE;

  const STUN_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
  ];

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

  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = NES_WIDTH;
  baseCanvas.height = NES_HEIGHT;
  const baseCtx = baseCanvas.getContext("2d", { alpha: false });
  const imageData = baseCtx.createImageData(NES_WIDTH, NES_HEIGHT);
  const frameBufferU32 = new Uint32Array(imageData.data.buffer);

  let running = false;
  let nes = null;
  let peer = null;
  let dataConn = null;
  let mediaCall = null;
  let canvasStream = null;
  const localSources = new Map();
  const remotePressed = new Set();

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
        baseCtx.putImageData(imageData, 0, 0);
        ctx.drawImage(baseCanvas, 0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
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

  function updateLocalButton(btnName, source, pressed) {
    if (!nes) return;
    const nesBtn = NES_BUTTONS[btnName];
    if (nesBtn === undefined) return;
    const sources = localSources.get(btnName) || new Set();
    const wasPressed = sources.size > 0;
    if (pressed) {
      sources.add(source);
    } else {
      sources.delete(source);
    }
    if (sources.size === 0) {
      localSources.delete(btnName);
    } else {
      localSources.set(btnName, sources);
    }
    const isPressed = sources.size > 0;
    if (wasPressed !== isPressed) {
      if (isPressed) {
        nes.buttonDown(1, nesBtn);
      } else {
        nes.buttonUp(1, nesBtn);
      }
    }
  }

  function applyLocalInput(code, pressed) {
    const btnName = KEY_MAP[code];
    if (!btnName) return;
    updateLocalButton(btnName, "keyboard", pressed);
  }

  function applyRemoteInput(btnName, pressed) {
    if (!nes) return;
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
      if (nesBtn !== undefined && nes) nes.buttonUp(2, nesBtn);
    }
    remotePressed.clear();
  }

  function releaseAllLocal() {
    for (const btnName of localSources.keys()) {
      const nesBtn = NES_BUTTONS[btnName];
      if (nesBtn !== undefined && nes) nes.buttonUp(1, nesBtn);
    }
    localSources.clear();
    controlButtons.forEach((btn) => btn.classList.remove("active"));
  }

  function ensureCanvasStream() {
    if (canvasStream) return canvasStream;
    if (!canvas.captureStream) {
      setPill(streamStatus, "Stream: unsupported", true);
      return null;
    }
    canvasStream = canvas.captureStream(60);
    const [track] = canvasStream.getVideoTracks();
    if (track) track.contentHint = "detail";
    return canvasStream;
  }

  function stopMediaCall() {
    if (mediaCall) {
      mediaCall.close();
      mediaCall = null;
    }
  }

  function startMediaCall(guestId) {
    const stream = ensureCanvasStream();
    if (!stream || !peer) return;
    stopMediaCall();
    try {
      mediaCall = peer.call(guestId, stream, { metadata: { role: "host" } });
    } catch (err) {
      setPill(streamStatus, "Stream: failed", true);
      console.error(err);
      return;
    }
    if (!mediaCall) {
      setPill(streamStatus, "Stream: failed", true);
      return;
    }
    setPill(streamStatus, "Stream: live");
    mediaCall.on("close", () => {
      setPill(streamStatus, "Stream: closed", true);
    });
    mediaCall.on("error", (err) => {
      setPill(streamStatus, "Stream: error", true);
      console.error(err);
    });
  }

  function handleDataConnection(conn) {
    if (dataConn && dataConn.open) {
      dataConn.close();
    }
    dataConn = conn;
    setPill(guestStatus, "Guest: connecting...");

    conn.on("open", () => {
      setPill(guestStatus, `Guest: ${conn.peer}`);
      setPill(streamStatus, "Stream: starting");
      startMediaCall(conn.peer);
    });

    conn.on("data", (msg) => {
      if (!msg || msg.type !== "input") return;
      applyRemoteInput(msg.btn, msg.pressed);
    });

    conn.on("close", () => {
      setPill(guestStatus, "Guest: waiting", true);
      setPill(streamStatus, "Stream: idle");
      releaseAllRemote();
      stopMediaCall();
    });

    conn.on("error", (err) => {
      setPill(guestStatus, "Guest: error", true);
      setPill(streamStatus, "Stream: error", true);
      console.error(err);
    });
  }

  function setupPeer() {
    setPill(peerStatus, "Peer: connecting...");
    peer = new Peer({
      debug: 2,
      config: {
        iceServers: STUN_SERVERS,
      },
    });

    peer.on("open", (id) => {
      peerIdEl.textContent = id;
      setPill(peerStatus, `Peer: ${id}`);
      copyIdBtn.disabled = false;
    });

    peer.on("connection", handleDataConnection);

    peer.on("call", (call) => {
      const stream = ensureCanvasStream();
      if (!stream) {
        call.close();
        return;
      }
      stopMediaCall();
      mediaCall = call;
      setPill(streamStatus, "Stream: answering");
      call.answer(stream);
      call.on("close", () => {
        setPill(streamStatus, "Stream: closed", true);
      });
      call.on("error", (err) => {
        setPill(streamStatus, "Stream: error", true);
        console.error(err);
      });
    });

    peer.on("disconnected", () => {
      setPill(peerStatus, "Peer: disconnected", true);
      peer.reconnect();
    });

    peer.on("error", (err) => {
      setPill(peerStatus, "Peer: error", true);
      console.error(err);
    });
  }

  copyIdBtn.addEventListener("click", async () => {
    const id = peerIdEl.textContent.trim();
    if (!id || id === "waiting...") return;
    try {
      await navigator.clipboard.writeText(id);
      copyIdBtn.textContent = "Copied";
      setTimeout(() => {
        copyIdBtn.textContent = "Copy ID";
      }, 1500);
    } catch {
      window.prompt("Copy Peer ID:", id);
    }
  });

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

  function updateFullscreenButton() {
    if (!fullscreenBtn || !videoFrame) return;
    const isFull = document.fullscreenElement === videoFrame;
    fullscreenBtn.textContent = isFull ? "Exit Fullscreen" : "Fullscreen";
  }

  async function toggleFullscreen() {
    if (!videoFrame || !videoFrame.requestFullscreen) return;
    try {
      if (document.fullscreenElement === videoFrame) {
        await document.exitFullscreen();
      } else {
        await videoFrame.requestFullscreen({ navigationUI: "hide" });
      }
    } catch (err) {
      console.error(err);
    }
  }

  if (fullscreenBtn) {
    const canFullscreen = !!(videoFrame && videoFrame.requestFullscreen);
    fullscreenBtn.disabled = !canFullscreen;
    if (!canFullscreen) {
      fullscreenBtn.textContent = "Fullscreen (unsupported)";
    } else {
      fullscreenBtn.addEventListener("click", () => {
        if (navigator.vibrate) navigator.vibrate(10);
        toggleFullscreen();
      });
      document.addEventListener("fullscreenchange", updateFullscreenButton);
      updateFullscreenButton();
    }
  }

  controlButtons.forEach((button) => {
    const btn = button.dataset.btn;
    const press = () => {
      button.classList.add("active");
      updateLocalButton(btn, "touch", true);
      if (navigator.vibrate) navigator.vibrate(10);
    };
    const release = () => {
      button.classList.remove("active");
      updateLocalButton(btn, "touch", false);
    };

    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      press();
    });
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("pointerleave", release);
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

  canvas.width = OUTPUT_WIDTH;
  canvas.height = OUTPUT_HEIGHT;
  ctx.imageSmoothingEnabled = false;
  baseCtx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  initNes();
  ensureCanvasStream();
  setupPeer();
})();
