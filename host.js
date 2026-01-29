(() => {
  const peerStatus = document.querySelector("#peer-status");
  const guestStatus = document.querySelector("#guest-status");
  const romStatus = document.querySelector("#rom-status");
  const syncStatus = document.querySelector("#sync-status");
  const romInput = document.querySelector("#rom-input");
  const offlineToggle = document.querySelector("#offline-toggle");
  const canvas = document.querySelector("#screen");
  const ctx = canvas.getContext("2d", { alpha: false });
  const peerIdEl = document.querySelector("#peer-id");
  const copyIdBtn = document.querySelector("#copy-id");
  const controlButtons = Array.from(
    document.querySelectorAll(".host-overlay [data-btn], .host-overlay [data-combo]")
  );
  const joystickBase = document.querySelector("#joystick-base");
  const joystickKnob = document.querySelector("#joystick-knob");
  const videoFrame = document.querySelector("#video-frame");
  const fullscreenBtn = document.querySelector("#fullscreen-btn");

  const NES_WIDTH = 256;
  const NES_HEIGHT = 240;
  const SCALE = 3;
  const FRAME_MS = 1000 / 60;
  const INPUT_DELAY_FRAMES = 2;
  const MAX_SIM_STEPS = 4;
  const LOCAL_PLAYER = 1;
  const REMOTE_PLAYER = 2;

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

  const BUTTON_ORDER = ["A", "B", "SELECT", "START", "UP", "DOWN", "LEFT", "RIGHT"];

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

  let nes = null;
  let peer = null;
  let dataConn = null;
  let running = false;
  let syncActive = false;
  let localReady = false;
  let remoteReady = false;
  let romInfoLocal = null;
  let romInfoRemote = null;

  let simFrame = 0;
  let inputFrame = 0;
  let lastTime = 0;
  let accumulator = 0;

  const inputBuffer = new Map();
  const localSources = new Map();
  const localInput = makeButtons();
  const neutralInput = makeButtons();
  const appliedButtons = {
    1: makeButtons(),
    2: makeButtons(),
  };
  const joystickState = {
    active: false,
    pointerId: null,
    centerX: 0,
    centerY: 0,
    radius: 0,
  };

  // --- UI helpers ---
  function setPill(el, text, warn = false) {
    if (!el) return;
    el.textContent = text;
    el.dataset.tone = warn ? "warn" : "";
  }

  function setSyncStatus(text, warn = false) {
    setPill(syncStatus, `Sync: ${text}`, warn);
  }

  function isOffline() {
    return !!(offlineToggle && offlineToggle.checked);
  }

  // --- Emulator render ---
  function updateOutputSize() {
    canvas.width = NES_WIDTH * SCALE;
    canvas.height = NES_HEIGHT * SCALE;
    ctx.imageSmoothingEnabled = false;
    baseCtx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function initNes() {
    nes = new jsnes.NES({
      onFrame(framebuffer) {
        for (let i = 0; i < framebuffer.length; i += 1) {
          frameBufferU32[i] = 0xff000000 | framebuffer[i];
        }
        baseCtx.putImageData(imageData, 0, 0);
        ctx.drawImage(baseCanvas, 0, 0, canvas.width, canvas.height);
      },
      onStatusUpdate(status) {
        setPill(romStatus, `ROM: ${status}`);
      },
    });
  }

  // --- Input buffer + lockstep ---
  function makeButtons() {
    return {
      A: false,
      B: false,
      UP: false,
      DOWN: false,
      LEFT: false,
      RIGHT: false,
      START: false,
      SELECT: false,
    };
  }

  function cloneButtons(state) {
    return {
      A: !!state.A,
      B: !!state.B,
      UP: !!state.UP,
      DOWN: !!state.DOWN,
      LEFT: !!state.LEFT,
      RIGHT: !!state.RIGHT,
      START: !!state.START,
      SELECT: !!state.SELECT,
    };
  }

  function seedInputBuffer() {
    if (INPUT_DELAY_FRAMES <= 0) return;
    for (let f = 0; f < INPUT_DELAY_FRAMES; f += 1) {
      inputBuffer.set(f, {
        1: cloneButtons(neutralInput),
        2: cloneButtons(neutralInput),
      });
    }
  }

  function clearAppliedInputs() {
    [LOCAL_PLAYER, REMOTE_PLAYER].forEach((player) => {
      const current = appliedButtons[player];
      BUTTON_ORDER.forEach((btn) => {
        if (current[btn]) {
          nes.buttonUp(player, NES_BUTTONS[btn]);
          current[btn] = false;
        }
      });
    });
  }

  function resetSyncState() {
    inputBuffer.clear();
    simFrame = 0;
    inputFrame = 0;
    accumulator = 0;
    if (nes) clearAppliedInputs();
    seedInputBuffer();
  }

  function stopSync(reason, warn = false) {
    syncActive = false;
    running = false;
    if (reason) setSyncStatus(reason, warn);
    resetSyncState();
  }

  function maybeStartSync() {
    if (syncActive) return;
    if (!localReady) return;

    if (isOffline()) {
      resetSyncState();
      syncActive = true;
      running = true;
      lastTime = performance.now();
      setSyncStatus("offline running");
      requestAnimationFrame(frameLoop);
      return;
    }

    if (!remoteReady) return;
    if (!dataConn || !dataConn.open) return;
    if (romInfoLocal && romInfoRemote && !romMatches()) {
      setSyncStatus("ROM mismatch", true);
      return;
    }
    resetSyncState();
    syncActive = true;
    running = true;
    lastTime = performance.now();
    setSyncStatus("running");
    requestAnimationFrame(frameLoop);
  }

  function romMatches() {
    if (!romInfoLocal || !romInfoRemote) return true;
    return romInfoLocal.hash === romInfoRemote.hash && romInfoLocal.size === romInfoRemote.size;
  }

  function storeInput(frame, player, buttons) {
    if (typeof frame !== "number" || !buttons) return;
    let entry = inputBuffer.get(frame);
    if (!entry) {
      entry = { 1: null, 2: null };
      inputBuffer.set(frame, entry);
    }
    entry[player] = cloneButtons(buttons);
  }

  function applyButtonsForFrame(entry) {
    [LOCAL_PLAYER, REMOTE_PLAYER].forEach((player) => {
      const next = entry[player];
      if (!next) return;
      const current = appliedButtons[player];
      BUTTON_ORDER.forEach((btn) => {
        const want = !!next[btn];
        const had = !!current[btn];
        if (want && !had) nes.buttonDown(player, NES_BUTTONS[btn]);
        if (!want && had) nes.buttonUp(player, NES_BUTTONS[btn]);
        current[btn] = want;
      });
    });
  }

  // Lockstep pseudo-code:
  // every tick:
  //   sample local input -> frame = inputFrame + INPUT_DELAY
  //   send input(frame)
  //   while both inputs available for simFrame:
  //     apply inputs -> nes.frame() -> simFrame++
  function stepLockstep() {
    let steps = 0;
    while (steps < MAX_SIM_STEPS) {
      const entry = inputBuffer.get(simFrame);
      if (!entry || !entry[1] || !entry[2]) break;
      inputBuffer.delete(simFrame);
      applyButtonsForFrame(entry);
      nes.frame();
      simFrame += 1;
      steps += 1;
    }
    if (steps === 0) {
      setSyncStatus("waiting input", true);
    } else {
      setSyncStatus(`running f${simFrame}`);
    }
  }

  function sendLocalInputFrame() {
    const frame = inputFrame + INPUT_DELAY_FRAMES;
    const buttons = cloneButtons(localInput);
    storeInput(frame, LOCAL_PLAYER, buttons);
    if (isOffline()) {
      storeInput(frame, REMOTE_PLAYER, cloneButtons(neutralInput));
    } else if (dataConn && dataConn.open) {
      dataConn.send({
        type: "input",
        frame,
        player: LOCAL_PLAYER,
        buttons,
      });
    }
    inputFrame += 1;
  }

  function frameLoop(now) {
    if (!running) return;
    const delta = now - lastTime;
    lastTime = now;
    accumulator += delta;

    while (accumulator >= FRAME_MS) {
      if (!syncActive) {
        accumulator = 0;
        break;
      }
      sendLocalInputFrame();
      stepLockstep();
      accumulator -= FRAME_MS;
    }

    requestAnimationFrame(frameLoop);
  }

  // --- ROM loading + hash ---
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

  function computeRomHash(binary) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < binary.length; i += 1) {
      hash ^= binary.charCodeAt(i) & 0xff;
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  // --- Network layer ---
  function sendRomInfo() {
    if (!dataConn || !dataConn.open || !romInfoLocal) return;
    dataConn.send({ type: "rom_info", ...romInfoLocal });
  }

  function sendReady() {
    if (!dataConn || !dataConn.open) return;
    dataConn.send({ type: "ready" });
  }

  // --- Local input capture ---
  function updateLocalButton(btnName, source, pressed) {
    if (!btnName) return;
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
      localInput[btnName] = isPressed;
    }
  }

  function applyLocalInput(code, pressed) {
    const btnName = KEY_MAP[code];
    if (!btnName) return;
    updateLocalButton(btnName, "keyboard", pressed);
  }

  function releaseAllLocal() {
    BUTTON_ORDER.forEach((btnName) => {
      localInput[btnName] = false;
    });
    localSources.clear();
    resetJoystickVisual();
    controlButtons.forEach((btn) => btn.classList.remove("active"));
  }

  function getButtonTargets(button) {
    const combo = button.dataset.combo;
    if (combo) {
      return combo
        .split(",")
        .map((btn) => btn.trim())
        .filter(Boolean);
    }
    const single = button.dataset.btn;
    return single ? [single] : [];
  }

  function resetJoystickVisual() {
    joystickState.active = false;
    joystickState.pointerId = null;
    if (joystickKnob) {
      joystickKnob.style.transform = "translate(0, 0)";
    }
  }

  function updateJoystickDirection(x, y) {
    const radius = joystickState.radius || 1;
    const deadZone = radius * 0.2;
    const axisThreshold = 0.35;
    const distance = Math.hypot(x, y);
    const normX = distance < deadZone ? 0 : x / radius;
    const normY = distance < deadZone ? 0 : y / radius;
    updateLocalButton("LEFT", "joystick", normX < -axisThreshold);
    updateLocalButton("RIGHT", "joystick", normX > axisThreshold);
    updateLocalButton("UP", "joystick", normY < -axisThreshold);
    updateLocalButton("DOWN", "joystick", normY > axisThreshold);
  }

  function handleJoystickMove(event) {
    if (!joystickBase || !joystickKnob) return;
    if (!joystickState.active || event.pointerId !== joystickState.pointerId) return;
    const dx = event.clientX - joystickState.centerX;
    const dy = event.clientY - joystickState.centerY;
    const radius = joystickState.radius || 1;
    const distance = Math.hypot(dx, dy);
    let clampedX = dx;
    let clampedY = dy;
    if (distance > radius) {
      const scale = radius / distance;
      clampedX *= scale;
      clampedY *= scale;
    }
    joystickKnob.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
    updateJoystickDirection(clampedX, clampedY);
  }

  function releaseJoystick() {
    if (!joystickState.active) return;
    updateLocalButton("LEFT", "joystick", false);
    updateLocalButton("RIGHT", "joystick", false);
    updateLocalButton("UP", "joystick", false);
    updateLocalButton("DOWN", "joystick", false);
    resetJoystickVisual();
  }

  function handleDataConnection(conn) {
    if (dataConn && dataConn.open) {
      dataConn.close();
    }
    dataConn = conn;
    remoteReady = false;
    romInfoRemote = null;
    setPill(guestStatus, "Guest: connecting...");

    conn.on("open", () => {
      if (isOffline()) {
        setPill(guestStatus, `Guest: ${conn.peer} (offline)`, true);
        setSyncStatus("offline mode", true);
        return;
      }
      setPill(guestStatus, `Guest: ${conn.peer}`);
      sendRomInfo();
      if (localReady) sendReady();
      setSyncStatus("waiting for guest");
      maybeStartSync();
    });

    conn.on("data", (msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === "input") {
        if (msg.player !== REMOTE_PLAYER) return;
        storeInput(msg.frame, msg.player, msg.buttons);
        return;
      }
      if (msg.type === "ready") {
        remoteReady = true;
        setSyncStatus("guest ready");
        maybeStartSync();
        return;
      }
      if (msg.type === "rom_info") {
        romInfoRemote = msg;
        if (!romMatches()) {
          setSyncStatus("ROM mismatch", true);
          stopSync("ROM mismatch", true);
        } else {
          setSyncStatus("ROM verified");
          maybeStartSync();
        }
      }
    });

    conn.on("close", () => {
      if (isOffline()) {
        setPill(guestStatus, "Guest: offline", true);
        return;
      }
      setPill(guestStatus, "Guest: waiting", true);
      stopSync("waiting for guest", true);
      remoteReady = false;
      romInfoRemote = null;
    });

    conn.on("error", (err) => {
      setPill(guestStatus, "Guest: error", true);
      setSyncStatus("network error", true);
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

  function handleOfflineToggle() {
    if (isOffline()) {
      if (dataConn && dataConn.open) dataConn.close();
      remoteReady = false;
      romInfoRemote = null;
      setPill(guestStatus, "Guest: offline", true);
      stopSync("offline mode");
      if (!localReady) setSyncStatus("waiting for ROM");
      maybeStartSync();
      return;
    }

    remoteReady = false;
    romInfoRemote = null;
    setPill(
      guestStatus,
      dataConn && dataConn.open ? `Guest: ${dataConn.peer}` : "Guest: waiting",
      !(dataConn && dataConn.open)
    );
    stopSync("waiting for guest", true);
    if (dataConn && dataConn.open) {
      sendRomInfo();
      if (localReady) sendReady();
    }
    maybeStartSync();
  }

  if (offlineToggle) {
    offlineToggle.addEventListener("change", handleOfflineToggle);
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
    const targets = getButtonTargets(button);
    const press = () => {
      button.classList.add("active");
      targets.forEach((btn) => updateLocalButton(btn, "touch", true));
      if (navigator.vibrate) navigator.vibrate(10);
    };
    const release = () => {
      button.classList.remove("active");
      targets.forEach((btn) => updateLocalButton(btn, "touch", false));
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

  if (joystickBase && joystickKnob) {
    joystickBase.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const rect = joystickBase.getBoundingClientRect();
      const knobRect = joystickKnob.getBoundingClientRect();
      joystickState.centerX = rect.left + rect.width / 2;
      joystickState.centerY = rect.top + rect.height / 2;
      joystickState.radius = Math.max(0, rect.width / 2 - knobRect.width / 2);
      joystickState.active = true;
      joystickState.pointerId = event.pointerId;
      joystickBase.setPointerCapture(event.pointerId);
      handleJoystickMove(event);
      if (navigator.vibrate) navigator.vibrate(10);
    });

    joystickBase.addEventListener("pointermove", handleJoystickMove);
    joystickBase.addEventListener("pointerup", releaseJoystick);
    joystickBase.addEventListener("pointercancel", releaseJoystick);
  }

  romInput.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      setPill(romStatus, `ROM: loading ${file.name}`);
      const romData = await loadRom(file);
      const hash = computeRomHash(romData);
      romInfoLocal = { name: file.name, size: file.size, hash };
      nes.loadROM(romData);
      setPill(romStatus, `ROM: ${file.name}`);
      localReady = true;
      sendRomInfo();
      sendReady();
      setSyncStatus("waiting for guest");
      maybeStartSync();
    } catch (err) {
      setPill(romStatus, "ROM: failed", true);
      setSyncStatus("ROM load failed", true);
      console.error(err);
    }
  });

  updateOutputSize();
  initNes();
  setSyncStatus("waiting for ROM");
  setupPeer();
})();
