(() => {
  const peerStatus = document.querySelector("#peer-status");
  const hostStatus = document.querySelector("#host-status");
  const romStatus = document.querySelector("#rom-status");
  const syncStatus = document.querySelector("#sync-status");
  const hostIdInput = document.querySelector("#host-id");
  const connectBtn = document.querySelector("#connect-btn");
  const canvas = document.querySelector("#screen");
  const ctx = canvas.getContext("2d", { alpha: false });
  const videoFrame = document.querySelector("#video-frame");
  const fullscreenBtn = document.querySelector("#fullscreen-btn");
  const romInput = document.querySelector("#rom-input");
  const librarySelect = document.querySelector("#rom-library");
  const loadLibraryBtn = document.querySelector("#load-library");
  const controlButtons = Array.from(document.querySelectorAll("[data-btn], [data-combo]"));
  const joystickBase = document.querySelector("#joystick-base");
  const joystickKnob = document.querySelector("#joystick-knob");

  const NES_WIDTH = 256;
  const NES_HEIGHT = 240;
  const SCALE = 3;
  const FRAME_MS = 1000 / 60;
  const INPUT_DELAY_FRAMES = 2;
  const MAX_SIM_STEPS = 4;
  const LOCAL_PLAYER = 2;
  const REMOTE_PLAYER = 1;

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

  const GAMEPAD_BUTTON_MAP = {
    0: "A",
    1: "B",
    8: "SELECT",
    9: "START",
    12: "UP",
    13: "DOWN",
    14: "LEFT",
    15: "RIGHT",
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
  let gamepadIndex = null;
  let wakeLock = null;
  let wantsWakeLock = false;

  let simFrame = 0;
  let inputFrame = 0;
  let lastTime = 0;
  let accumulator = 0;

  const inputBuffer = new Map();
  const localSources = new Map();
  const localInput = makeButtons();
  const appliedButtons = {
    1: makeButtons(),
    2: makeButtons(),
  };
  const gamepadButtons = {};
  const axisState = { left: false, right: false, up: false, down: false };
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
    const neutral = makeButtons();
    for (let f = 0; f < INPUT_DELAY_FRAMES; f += 1) {
      inputBuffer.set(f, {
        1: cloneButtons(neutral),
        2: cloneButtons(neutral),
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
    if (!localReady || !remoteReady) return;
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
    if (dataConn && dataConn.open) {
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
  function arrayBufferToBinary(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      const slice = bytes.subarray(i, i + chunk);
      binary += String.fromCharCode.apply(null, slice);
    }
    return binary;
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
      reader.onload = () => resolve(arrayBufferToBinary(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  function normalizeLibraryEntry(entry) {
    if (!entry) return null;
    if (typeof entry === "string") {
      return { name: entry, file: entry };
    }
    if (typeof entry === "object" && entry.file) {
      return { name: entry.name || entry.file, file: entry.file };
    }
    return null;
  }

  async function fetchLibrary() {
    if (!librarySelect) return;
    try {
      const response = await fetch("roms.json", { cache: "no-store" });
      if (!response.ok) throw new Error("roms.json not found");
      const data = await response.json();
      const entries = Array.isArray(data) ? data.map(normalizeLibraryEntry).filter(Boolean) : [];
      librarySelect.innerHTML = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Select a game";
      librarySelect.appendChild(placeholder);
      entries.forEach((entry) => {
        const option = document.createElement("option");
        option.value = entry.file;
        option.textContent = entry.name;
        option.dataset.name = entry.name;
        librarySelect.appendChild(option);
      });
      librarySelect.disabled = entries.length === 0;
      if (loadLibraryBtn) loadLibraryBtn.disabled = entries.length === 0;
    } catch (err) {
      console.error(err);
      if (librarySelect) {
        librarySelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Library not found";
        librarySelect.appendChild(placeholder);
        librarySelect.disabled = true;
      }
      if (loadLibraryBtn) loadLibraryBtn.disabled = true;
    }
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
  function haptic(pattern = 15) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch {
      // Ignore wake lock errors (not supported or denied).
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
    }
  }

  function setWakeLockEnabled(enabled) {
    wantsWakeLock = enabled;
    if (enabled) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }
  }

  function shouldHoldWakeLock() {
    return (dataConn && dataConn.open) || document.fullscreenElement === videoFrame;
  }

  function refreshWakeLock() {
    setWakeLockEnabled(shouldHoldWakeLock());
  }

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

  function releaseSource(source) {
    for (const [btn, sources] of localSources.entries()) {
      if (!sources.has(source)) continue;
      sources.delete(source);
      if (sources.size === 0) {
        localSources.delete(btn);
      }
      localInput[btn] = sources.size > 0;
    }
    if (source === "gamepad") resetGamepadState();
  }

  function releaseAll() {
    BUTTON_ORDER.forEach((btn) => {
      localInput[btn] = false;
    });
    localSources.clear();
    resetGamepadState();
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

  function resetGamepadState() {
    Object.keys(gamepadButtons).forEach((key) => {
      delete gamepadButtons[key];
    });
    axisState.left = false;
    axisState.right = false;
    axisState.up = false;
    axisState.down = false;
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

  function handleDataMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === "input") {
      if (msg.player !== REMOTE_PLAYER) return;
      storeInput(msg.frame, msg.player, msg.buttons);
      return;
    }
    if (msg.type === "ready") {
      remoteReady = true;
      setSyncStatus("host ready");
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
      setPill(peerStatus, `Peer: ${id}`);
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

  function connectToHost() {
    const hostId = hostIdInput.value.trim();
    if (!hostId || !peer) {
      hostIdInput.focus();
      return;
    }
    if (dataConn) dataConn.close();
    remoteReady = false;
    romInfoRemote = null;
    setPill(hostStatus, "Host: connecting...");
    setSyncStatus("connecting...");
    dataConn = peer.connect(hostId, {
      reliable: true,
      metadata: { role: "guest" },
    });

    dataConn.on("open", () => {
      setPill(hostStatus, `Host: ${hostId}`);
      sendRomInfo();
      if (localReady) sendReady();
      maybeStartSync();
      refreshWakeLock();
    });

    dataConn.on("data", handleDataMessage);

    dataConn.on("close", () => {
      setPill(hostStatus, "Host: disconnected", true);
      stopSync("waiting for host", true);
      releaseAll();
      remoteReady = false;
      romInfoRemote = null;
      refreshWakeLock();
    });

    dataConn.on("error", (err) => {
      setPill(hostStatus, "Host: error", true);
      setSyncStatus("network error", true);
      console.error(err);
    });
  }

  window.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    const btn = KEY_MAP[event.code];
    if (!btn) return;
    event.preventDefault();
    updateLocalButton(btn, "keyboard", true);
  });

  window.addEventListener("keyup", (event) => {
    const btn = KEY_MAP[event.code];
    if (!btn) return;
    event.preventDefault();
    updateLocalButton(btn, "keyboard", false);
  });

  window.addEventListener("blur", () => {
    releaseAll();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      releaseAll();
      releaseWakeLock();
      return;
    }
    if (wantsWakeLock) requestWakeLock();
  });

  controlButtons.forEach((button) => {
    const targets = getButtonTargets(button);
    const press = () => {
      button.classList.add("active");
      targets.forEach((btn) => updateLocalButton(btn, "touch", true));
      haptic(12);
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
      haptic(10);
    });

    joystickBase.addEventListener("pointermove", handleJoystickMove);
    joystickBase.addEventListener("pointerup", releaseJoystick);
    joystickBase.addEventListener("pointercancel", releaseJoystick);
  }

  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    if (gamepadIndex !== null && pads[gamepadIndex]) {
      pad = pads[gamepadIndex];
    } else {
      pad = pads.find((candidate) => candidate && candidate.connected) || null;
    }

    if (!pad) {
      gamepadIndex = null;
      requestAnimationFrame(pollGamepad);
      return;
    }

    gamepadIndex = pad.index;

    Object.entries(GAMEPAD_BUTTON_MAP).forEach(([index, btn]) => {
      const pressed = Boolean(pad.buttons[index]?.pressed);
      if (gamepadButtons[index] !== pressed) {
        gamepadButtons[index] = pressed;
        updateLocalButton(btn, "gamepad", pressed);
      }
    });

    const axisX = pad.axes[0] || 0;
    const axisY = pad.axes[1] || 0;
    const left = axisX < -0.5;
    const right = axisX > 0.5;
    const up = axisY < -0.5;
    const down = axisY > 0.5;

    if (left !== axisState.left) {
      axisState.left = left;
      updateLocalButton("LEFT", "gamepad", left);
    }
    if (right !== axisState.right) {
      axisState.right = right;
      updateLocalButton("RIGHT", "gamepad", right);
    }
    if (up !== axisState.up) {
      axisState.up = up;
      updateLocalButton("UP", "gamepad", up);
    }
    if (down !== axisState.down) {
      axisState.down = down;
      updateLocalButton("DOWN", "gamepad", down);
    }

    requestAnimationFrame(pollGamepad);
  }

  window.addEventListener("gamepaddisconnected", () => {
    releaseSource("gamepad");
    gamepadIndex = null;
  });

  function handleFullscreenChange() {
    if (!fullscreenBtn || !videoFrame) return;
    const isFull = document.fullscreenElement === videoFrame;
    fullscreenBtn.textContent = isFull ? "Exit Fullscreen" : "Fullscreen";
    refreshWakeLock();
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
        haptic(10);
        toggleFullscreen();
      });
      document.addEventListener("fullscreenchange", handleFullscreenChange);
      handleFullscreenChange();
    }
  }

  connectBtn.addEventListener("click", () => {
    haptic(10);
    connectToHost();
  });

  hostIdInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") connectToHost();
  });

  async function loadRomFromLibrary() {
    if (!librarySelect) return;
    const option = librarySelect.selectedOptions[0];
    if (!option || !option.value) return;
    const name = option.dataset.name || option.textContent;
    try {
      setPill(romStatus, `ROM: loading ${name}`);
      const response = await fetch(encodeURI(option.value));
      if (!response.ok) throw new Error("ROM fetch failed");
      const buffer = await response.arrayBuffer();
      const romData = arrayBufferToBinary(buffer);
      const hash = computeRomHash(romData);
      romInfoLocal = { name, size: buffer.byteLength, hash };
      nes.loadROM(romData);
      setPill(romStatus, `ROM: ${name}`);
      localReady = true;
      sendRomInfo();
      sendReady();
      setSyncStatus("waiting for host");
      maybeStartSync();
    } catch (err) {
      setPill(romStatus, "ROM: failed", true);
      setSyncStatus("ROM load failed", true);
      console.error(err);
    }
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
      setSyncStatus("waiting for host");
      maybeStartSync();
    } catch (err) {
      setPill(romStatus, "ROM: failed", true);
      setSyncStatus("ROM load failed", true);
      console.error(err);
    }
  });

  if (loadLibraryBtn) {
    loadLibraryBtn.addEventListener("click", () => {
      loadRomFromLibrary();
    });
  }

  setupPeer();
  updateOutputSize();
  initNes();
  setSyncStatus("waiting for ROM");
  fetchLibrary();
  requestAnimationFrame(pollGamepad);
})();
