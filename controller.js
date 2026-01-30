(() => {
  const peerStatus = document.querySelector("#peer-status");
  const hostStatus = document.querySelector("#host-status");
  const playerStatus = document.querySelector("#player-status");
  const hostIdInput = document.querySelector("#host-id");
  const connectBtn = document.querySelector("#connect-btn");
  const playerSelect = document.querySelector("#player-select");
  const videoFrame = document.querySelector("#video-frame");
  const fullscreenBtn = document.querySelector("#fullscreen-btn");
  const controlButtons = Array.from(document.querySelectorAll("[data-btn], [data-combo]"));
  const joystickBase = document.querySelector("#joystick-base");
  const joystickKnob = document.querySelector("#joystick-knob");

  const STUN_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
  ];

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

  const MIN_PRESS_MS = 60;

  let peer = null;
  let dataConn = null;
  let gamepadIndex = null;
  const pressedSources = new Map();
  const pressStartedAt = new Map();
  const pendingReleaseTimers = new Map();
  const gamepadButtons = {};
  const axisState = { left: false, right: false, up: false, down: false };
  const joystickState = {
    active: false,
    pointerId: null,
    centerX: 0,
    centerY: 0,
    radius: 0,
  };

  function setPill(el, text, warn = false) {
    if (!el) return;
    el.textContent = text;
    el.dataset.tone = warn ? "warn" : "";
  }

  function currentPlayer() {
    return Number(playerSelect?.value || 2);
  }

  function updatePlayerStatus() {
    setPill(playerStatus, `Player: ${currentPlayer()}`);
  }

  function sendInput(btn, pressedState) {
    if (!dataConn || !dataConn.open) return;
    dataConn.send({
      type: "input",
      btn,
      pressed: pressedState,
      player: currentPlayer(),
    });
  }

  function sendHello() {
    if (!dataConn || !dataConn.open) return;
    dataConn.send({ type: "hello", player: currentPlayer() });
  }

  function haptic(pattern = 15) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  function updateButton(btn, source, pressed) {
    if (!btn) return;
    const sources = pressedSources.get(btn) || new Set();
    const hadPressed = sources.size > 0;
    if (pressed) {
      sources.add(source);
    } else {
      sources.delete(source);
    }
    if (sources.size === 0) {
      pressedSources.delete(btn);
    } else {
      pressedSources.set(btn, sources);
    }
    const hasPressed = sources.size > 0;
    if (hadPressed === hasPressed) return;
    if (hasPressed) {
      if (pendingReleaseTimers.has(btn)) {
        clearTimeout(pendingReleaseTimers.get(btn));
        pendingReleaseTimers.delete(btn);
      }
      pressStartedAt.set(btn, performance.now());
      sendInput(btn, true);
      return;
    }
    const startedAt = pressStartedAt.get(btn) ?? performance.now();
    const elapsed = performance.now() - startedAt;
    if (elapsed >= MIN_PRESS_MS) {
      sendInput(btn, false);
      pressStartedAt.delete(btn);
      pendingReleaseTimers.delete(btn);
      return;
    }
    const delay = Math.max(0, MIN_PRESS_MS - elapsed);
    const timer = setTimeout(() => {
      sendInput(btn, false);
      pressStartedAt.delete(btn);
      pendingReleaseTimers.delete(btn);
    }, delay);
    pendingReleaseTimers.set(btn, timer);
  }

  function releaseAll() {
    for (const btn of pressedSources.keys()) {
      sendInput(btn, false);
    }
    pressedSources.clear();
    pressStartedAt.clear();
    for (const timer of pendingReleaseTimers.values()) {
      clearTimeout(timer);
    }
    pendingReleaseTimers.clear();
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

  function releaseSource(source) {
    for (const [btn, sources] of pressedSources.entries()) {
      if (!sources.has(source)) continue;
      sources.delete(source);
      if (sources.size === 0) {
        pressedSources.delete(btn);
      }
      sendInput(btn, sources.size > 0);
    }
    if (source === "gamepad") {
      pressStartedAt.clear();
      for (const timer of pendingReleaseTimers.values()) {
        clearTimeout(timer);
      }
      pendingReleaseTimers.clear();
    }
    if (source === "gamepad") resetGamepadState();
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
    updateButton("LEFT", "joystick", normX < -axisThreshold);
    updateButton("RIGHT", "joystick", normX > axisThreshold);
    updateButton("UP", "joystick", normY < -axisThreshold);
    updateButton("DOWN", "joystick", normY > axisThreshold);
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
    updateButton("LEFT", "joystick", false);
    updateButton("RIGHT", "joystick", false);
    updateButton("UP", "joystick", false);
    updateButton("DOWN", "joystick", false);
    resetJoystickVisual();
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
    setPill(hostStatus, "Host: connecting...");
    dataConn = peer.connect(hostId, {
      reliable: true,
      metadata: { role: "controller" },
    });

    dataConn.on("open", () => {
      setPill(hostStatus, `Host: ${hostId}`);
      sendHello();
    });

    dataConn.on("close", () => {
      setPill(hostStatus, "Host: disconnected", true);
      releaseAll();
    });

    dataConn.on("error", (err) => {
      setPill(hostStatus, "Host: error", true);
      console.error(err);
    });
  }

  function handleFullscreenChange() {
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

  window.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    const btn = KEY_MAP[event.code];
    if (!btn) return;
    event.preventDefault();
    updateButton(btn, "keyboard", true);
  });

  window.addEventListener("keyup", (event) => {
    const btn = KEY_MAP[event.code];
    if (!btn) return;
    event.preventDefault();
    updateButton(btn, "keyboard", false);
  });

  window.addEventListener("blur", () => {
    releaseAll();
  });

  controlButtons.forEach((button) => {
    const targets = getButtonTargets(button);
    const press = () => {
      button.classList.add("active");
      targets.forEach((btn) => updateButton(btn, "touch", true));
      haptic(12);
    };
    const release = () => {
      button.classList.remove("active");
      targets.forEach((btn) => updateButton(btn, "touch", false));
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
        updateButton(btn, "gamepad", pressed);
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
      updateButton("LEFT", "gamepad", left);
    }
    if (right !== axisState.right) {
      axisState.right = right;
      updateButton("RIGHT", "gamepad", right);
    }
    if (up !== axisState.up) {
      axisState.up = up;
      updateButton("UP", "gamepad", up);
    }
    if (down !== axisState.down) {
      axisState.down = down;
      updateButton("DOWN", "gamepad", down);
    }

    requestAnimationFrame(pollGamepad);
  }

  window.addEventListener("gamepaddisconnected", () => {
    releaseSource("gamepad");
    gamepadIndex = null;
  });

  connectBtn.addEventListener("click", () => {
    haptic(10);
    connectToHost();
  });

  hostIdInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") connectToHost();
  });

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

  if (playerSelect) {
    playerSelect.addEventListener("change", () => {
      updatePlayerStatus();
      sendHello();
    });
  }

  updatePlayerStatus();
  setupPeer();
  requestAnimationFrame(pollGamepad);
})();
