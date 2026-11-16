// The player's gun: one active weapon at a time, each with its own magazine, reserve and cadence,
// a reload that can be interrupted, a recoil impulse the body receives, and a spread that depends
// on how fast the player is moving. Grenades are thrown from here too, because they share the
// same "what is in your hands" question.
//
// Nothing in this file draws the world: it owns numbers and the view model's pose, and main.js
// asks it whether a shot is ready.
import * as THREE from 'three';
import { WEAPONS, GRENADES, ARMOR, startLoadout, buildViewModel, buildMuzzle } from './weapons.js';
import { PALETTE } from './palette.js';

const MOVE_REFERENCE = 5.4;
const VIEW_BOB = 0.011;

export function createArsenal(camera) {
  const loadout = startLoadout();
  const state = {
    ...loadout,
    active: 'pistol',
    mag: { pistol: WEAPONS.pistol.mag },
    reserve: { pistol: WEAPONS.pistol.reserve },
    cooldown: 0,
    reloadLeft: 0,
    reloadingWeapon: null,
    kick: 0,
    flashTimer: 0,
    bobPhase: 0,
    grenadeTimer: 0,
    throwing: null,
  };

  // Two slots on the camera: the current view model and the muzzle that belongs to it. Models are
  // built once per weapon type and cloned, so switching guns costs a graph swap, not a rebuild.
  const modelHolder = new THREE.Group();
  camera.add(modelHolder);
  const { flash, light } = buildMuzzle();
  camera.add(flash, light);

  let currentModel = null;

  function mountModel(kind) {
    if (currentModel) modelHolder.remove(currentModel);
    currentModel = kind ? buildViewModel(kind) : null;
    if (currentModel) modelHolder.add(currentModel);
  }

  function weaponOf(slot) {
    return slot ? WEAPONS[slot] : null;
  }

  function ammoFor(slot) {
    return { mag: state.mag[slot] ?? 0, reserve: state.reserve[slot] ?? 0 };
  }

  function equip(slot) {
    if (!slot) return;
    if (slot !== 'pistol' && !state.primary) return;
    if (slot === 'pistol' && !state.secondary) return;
    state.active = slot;
    state.reloadLeft = 0;
    state.reloadingWeapon = null;
    state.cooldown = Math.max(state.cooldown, 0.22);
    mountModel(WEAPONS[slot].viewModel);
  }

  function give(weaponId) {
    const weapon = WEAPONS[weaponId];
    if (!weapon) return false;
    if (weapon.slot === 'primary') {
      if (state.primary === weaponId) return false;
      state.primary = weaponId;
      state.mag[weaponId] = weapon.mag;
      state.reserve[weaponId] = weapon.reserve;
      equip(weaponId);
    } else {
      state.secondary = weaponId;
      state.mag[weaponId] = weapon.mag;
      state.reserve[weaponId] = weapon.reserve;
      if (!state.primary) equip(weaponId);
    }
    return true;
  }

  function giveArmor() {
    state.armor = 100;
  }

  function giveGrenade(kind) {
    const spec = GRENADES[kind];
    if (!spec) return false;
    state.grenades[kind] = Math.min(spec.max, (state.grenades[kind] ?? 0) + 1);
    return true;
  }

  function refillForRound() {
    // A new round tops every gun up to the magazine it was bought with, and keeps whatever
    // reserve survived, which is the standard behaviour and it means ammo is a real cost.
    for (const id of Object.keys(WEAPONS)) {
      if (state.primary === id || state.secondary === id) {
        const spec = WEAPONS[id];
        state.mag[id] = spec.mag;
        state.reserve[id] = Math.min(spec.reserve, (state.reserve[id] ?? 0) + spec.mag);
        if (state.reserve[id] === 0) state.reserve[id] = spec.reserve;
      }
    }
  }

  function ready() {
    const weapon = weaponOf(state.active);
    if (!weapon) return false;
    return state.cooldown === 0 && state.reloadLeft === 0 && (state.mag[state.active] ?? 0) > 0;
  }

  function takeRound() {
    if (!ready()) return false;
    state.mag[state.active] -= 1;
    state.cooldown = weaponOf(state.active).fireGap;
    state.kick = 1;
    state.flashTimer = 0.055;
    return true;
  }

  function startReload() {
    const weapon = weaponOf(state.active);
    if (!weapon) return false;
    if (state.reloadLeft > 0) return false;
    const mag = state.mag[state.active] ?? 0;
    const reserve = state.reserve[state.active] ?? 0;
    if (mag >= weapon.mag || reserve <= 0) return false;
    state.reloadLeft = weapon.reloadTime;
    state.reloadingWeapon = state.active;
    return true;
  }

  // Spread is the heart of the gunplay: standing still is tight, moving is loose, and the gap is
  // wide enough that a moving player genuinely wastes bullets at range.
  function spread(groundSpeed) {
    const weapon = weaponOf(state.active);
    if (!weapon) return 0.01;
    const t = Math.min(1, groundSpeed / MOVE_REFERENCE);
    return weapon.spreadStill + (weapon.spreadMoving - weapon.spreadStill) * t;
  }

  function recoilImpulse() {
    const weapon = weaponOf(state.active);
    if (!weapon) return { pitch: 0, yaw: 0 };
    return { pitch: weapon.recoilPitch, yaw: (Math.random() * 2 - 1) * weapon.recoilYaw };
  }

  function canThrow(kind) {
    return (state.grenades[kind] ?? 0) > 0 && state.grenadeTimer <= 0;
  }

  function throwGrenade(kind) {
    if (!canThrow(kind)) return null;
    state.grenades[kind] -= 1;
    state.grenadeTimer = 0.85;
    state.throwing = kind;
    mountModel('grenade');
    return GRENADES[kind];
  }

  function step(dt, groundSpeed) {
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.flashTimer = Math.max(0, state.flashTimer - dt);
    state.grenadeTimer = Math.max(0, state.grenadeTimer - dt);
    state.kick += (0 - state.kick) * Math.min(1, dt * 15);

    if (state.reloadLeft > 0) {
      state.reloadLeft = Math.max(0, state.reloadLeft - dt);
      if (state.reloadLeft === 0 && state.reloadingWeapon) {
        const id = state.reloadingWeapon;
        const weapon = WEAPONS[id];
        const need = weapon.mag - (state.mag[id] ?? 0);
        const take = Math.min(need, state.reserve[id] ?? 0);
        state.mag[id] = (state.mag[id] ?? 0) + take;
        state.reserve[id] = (state.reserve[id] ?? 0) - take;
        state.reloadingWeapon = null;
      }
    }

    // View model pose: recoil pushes it back and up, a reload rolls it, and a walk bobs it. All of
    // it is a read of the numbers above, so the model never disagrees with the simulation.
    if (currentModel) {
      state.bobPhase += dt * groundSpeed * 1.7;
      const bob = groundSpeed > 0.4 ? Math.sin(state.bobPhase) * VIEW_BOB * Math.min(1, groundSpeed / MOVE_REFERENCE) : 0;
      const bobY = Math.cos(state.bobPhase * 2) * VIEW_BOB * 0.5 * Math.min(1, groundSpeed / MOVE_REFERENCE);
      currentModel.position.z = (currentModel.position.z || 0) * 0;
      const base = state.active === 'rifle' ? -0.42 : state.active === 'smg' ? -0.36 : -0.3;
      currentModel.position.z = base + state.kick * 0.05;
      currentModel.position.y = bobY;
      currentModel.position.x = bob;
      currentModel.rotation.x = state.kick * 0.22;
      if (state.reloadLeft > 0) {
        const weapon = WEAPONS[state.reloadingWeapon ?? state.active];
        const progress = 1 - state.reloadLeft / (weapon?.reloadTime ?? 1);
        currentModel.rotation.x = -0.9 * Math.sin(Math.min(1, progress) * Math.PI);
        currentModel.rotation.z = 0.5 * Math.sin(Math.min(1, progress) * Math.PI);
      } else {
        currentModel.rotation.z = 0;
      }
    }

    const weapon = weaponOf(state.active);
    const muzzleZ = weapon?.viewModel === 'pistol' ? -0.5 : -0.95;
    flash.visible = state.flashTimer > 0;
    if (flash.visible) {
      flash.position.set(0.19, -0.14, muzzleZ);
      flash.rotation.z = Math.random() * Math.PI;
      flash.scale.setScalar(0.8 + Math.random() * 0.55);
      light.position.set(0.19, -0.12, muzzleZ + 0.35);
      light.intensity = 16;
    } else {
      light.intensity = 0;
    }
  }

  function resetForMatch() {
    state.primary = null;
    state.secondary = 'pistol';
    state.armor = 0;
    state.grenades = { frag: 0, flash: 0 };
    state.mag = { pistol: WEAPONS.pistol.mag };
    state.reserve = { pistol: WEAPONS.pistol.reserve };
    state.reloadLeft = 0;
    state.reloadingWeapon = null;
    equip('pistol');
  }

  function currentWeapon() {
    return weaponOf(state.active);
  }

  function ammoReadout() {
    const id = state.active;
    return {
      name: WEAPONS[id].name,
      mag: state.mag[id] ?? 0,
      reserve: state.reserve[id] ?? 0,
      capacity: WEAPONS[id].mag,
      reloading: state.reloadLeft > 0,
      reloadProgress: state.reloadLeft > 0 ? 1 - state.reloadLeft / WEAPONS[id].reloadTime : 1,
    };
  }

  mountModel('pistol');

  return {
    state,
    equip,
    give,
    giveArmor,
    giveGrenade,
    refillForRound,
    ready,
    takeRound,
    startReload,
    spread,
    recoilImpulse,
    canThrow,
    throwGrenade,
    step,
    resetForMatch,
    currentWeapon,
    ammoReadout,
    ammoFor,
    WEAPONS,
    ARMOR,
    GRENADES,
    // Palette is exposed so the HUD can name a colour without importing the look plan twice.
    palette: PALETTE,
  };
}
