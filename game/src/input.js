// Keyboard and mouse, and the pointer lock that turns the mouse into look. Also the one-shot
// actions that must not repeat while a key is held: firing a semi-automatic, throwing, planting.
// Plain browser APIs only; no library, no gamepad, no touch (mouse and keyboard are the game).
export function createInput(canvas, onLockChange) {
  const keys = new Set();
  const pressed = new Set();
  const state = { keys, locked: false, firing: false, looking: false, lookX: 0, lookY: 0 };

  function setKey(event, down) {
    // Typing in the buy menu or any input must not move the player, so keys are only read when the
    // pointer is actually locked.
    if (event.code === 'Space' || event.code === 'Tab') event.preventDefault();
    if (down) {
      if (!keys.has(event.code)) pressed.add(event.code);
      keys.add(event.code);
    } else {
      keys.delete(event.code);
    }
  }

  window.addEventListener('keydown', (event) => {
    if (event.repeat) {
      if (event.code === 'Space') event.preventDefault();
      return;
    }
    setKey(event, true);
  });
  window.addEventListener('keyup', (event) => setKey(event, false));
  window.addEventListener('blur', () => {
    keys.clear();
    pressed.clear();
    state.firing = false;
  });
  window.addEventListener('mousemove', (event) => {
    if (!state.locked) return;
    state.lookX += event.movementX;
    state.lookY += event.movementY;
  });
  window.addEventListener('mousedown', (event) => {
    if (!state.locked) return;
    if (event.button === 0) state.firing = true;
    if (event.button === 2) pressed.add('MouseRight');
  });
  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) state.firing = false;
  });
  window.addEventListener('contextmenu', (event) => {
    // Right-click is aim-down-sights, not a menu.
    if (state.locked) event.preventDefault();
  });
  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) {
      keys.clear();
      pressed.clear();
      state.firing = false;
    }
    onLockChange(state.locked);
  });

  return {
    state,
    requestLock() {
      canvas.requestPointerLock();
    },
    releaseLock() {
      if (document.pointerLockElement) document.exitPointerLock();
    },
    takeLook() {
      const x = state.lookX;
      const y = state.lookY;
      state.lookX = 0;
      state.lookY = 0;
      return { x, y };
    },
    // A press is consumed by the thing that acts on it, so one keystroke cannot buy two things.
    consume(code) {
      return pressed.delete(code);
    },
    consumeAny(codes) {
      for (const code of codes) {
        if (pressed.delete(code)) return code;
      }
      return null;
    },
    clearPressed() {
      pressed.clear();
    },
  };
}
