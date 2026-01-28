(() => {
  const peerStatus = document.querySelector("#peer-status");
  const hostStatus = document.querySelector("#host-status");
  const streamStatus = document.querySelector("#stream-status");
  const hostIdInput = document.querySelector("#host-id");
  const connectBtn = document.querySelector("#connect-btn");
  const video = document.querySelector("#screen");
  const videoFrame = document.querySelector("#video-frame");
  const fullscreenBtn = document.querySelector("#fullscreen-btn");
  const controlButtons = Array.from(document.querySelectorAll("[data-btn]"));
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

  let peer = null;
  let dataConn = null;
  let mediaCall = null;
  let gamepadIndex = null;
  let wakeLock = null;
  let wantsWakeLock = false;
  const gamepadButtons = {};
  const axisState = { left: false, right: false, up: false, down: false };
  const pressedSources = new Map();
  const joystickState = {
    active: false,
    pointerId: null,
    centerX: 0,
    centerY: 0,
    radius: 0,
  };

  function setPill(el, text, warn = false) {
    el.textContent = text;
    if (warn) {
      el.dataset.tone = "warn";
    } else {
      el.dataset.tone = "";
    }
  }

  function sendInput(btn, pressedState) {
    if (!dataConn || !dataConn.open) return;
    dataConn.send({ type: "input", btn, pressed: pressedState });
  }

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
    if (hadPressed !== hasPressed) {
      sendInput(btn, hasPressed);
    }
  }

  function releaseAll() {
    for (const btn of pressedSources.keys()) {
      sendInput(btn, false);
    }
    pressedSources.clear();
    resetGamepadState();
    resetJoystickVisual();
    controlButtons.forEach((btn) => btn.classList.remove("active"));
  }

  function releaseSource(source) {
    for (const [btn, sources] of pressedSources.entries()) {
      if (!sources.has(source)) continue;
      sources.delete(source);
      const hasPressed = sources.size > 0;
      if (!hasPressed) {
        pressedSources.delete(btn);
      }
      sendInput(btn, hasPressed);
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

  function syncPressed() {
    for (const btn of pressedSources.keys()) {
      sendInput(btn, true);
    }
  }

  function cleanupMedia() {
    if (mediaCall) {
      mediaCall.close();
      mediaCall = null;
    }
    video.srcObject = null;
  }

  function handleCall(call) {
    cleanupMedia();
    mediaCall = call;
    setPill(streamStatus, "Stream: connecting");
    call.answer();
    call.on("stream", (stream) => {
      video.srcObject = stream;
      setPill(streamStatus, "Stream: live");
      refreshWakeLock();
    });
    call.on("close", () => {
      setPill(streamStatus, "Stream: closed", true);
      video.srcObject = null;
      refreshWakeLock();
    });
    call.on("error", (err) => {
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
      setPill(peerStatus, `Peer: ${id}`);
    });

    peer.on("call", handleCall);

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
    setPill(streamStatus, "Stream: waiting");
    dataConn = peer.connect(hostId, {
      reliable: false,
      metadata: { role: "guest" },
    });

    dataConn.on("open", () => {
      setPill(hostStatus, `Host: ${hostId}`);
      syncPressed();
      refreshWakeLock();
    });

    dataConn.on("data", (msg) => {
      if (msg && msg.type === "host_ready") {
        setPill(hostStatus, `Host: ${hostId}`);
      }
    });

    dataConn.on("close", () => {
      setPill(hostStatus, "Host: disconnected", true);
      setPill(streamStatus, "Stream: idle", true);
      releaseAll();
      cleanupMedia();
      refreshWakeLock();
    });

    dataConn.on("error", (err) => {
      setPill(hostStatus, "Host: error", true);
      console.error(err);
    });
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

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      releaseAll();
      releaseWakeLock();
      return;
    }
    if (wantsWakeLock) requestWakeLock();
  });

  controlButtons.forEach((button) => {
    const btn = button.dataset.btn;
    const press = () => {
      button.classList.add("active");
      updateButton(btn, "touch", true);
      haptic(12);
    };
    const release = () => {
      button.classList.remove("active");
      updateButton(btn, "touch", false);
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

  setupPeer();
  requestAnimationFrame(pollGamepad);
})();
