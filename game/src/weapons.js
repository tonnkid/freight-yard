// The arsenal. Every weapon is data: a few numbers and a view-model recipe, so the buy menu reads
// this table and the simulation reads it too — one source for price, damage, spread and cadence.
// Rifles reward stopping to aim; the SMG trades per-bullet punch for speed; the shotgun is a
// corner tool; the pistol is what a broke round leaves you with.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

// Damage is per bullet before the distance falloff in main.js. Headshots multiply by HEAD_MULT.
export const HEAD_MULT = 4.0;
export const LEG_MULT = 0.7;

export const WEAPONS = {
  pistol: {
    id: 'pistol',
    name: 'M1911',
    slot: 'secondary',
    price: 0,
    damage: 26,
    headMult: HEAD_MULT,
    mag: 8,
    reserve: 40,
    fireGap: 0.16,
    reloadTime: 1.5,
    automatic: false,
    spreadStill: 0.0035,
    spreadMoving: 0.032,
    recoilPitch: 0.018,
    recoilYaw: 0.005,
    range: 60,
    falloffStart: 18,
    falloffEnd: 55,
    falloffFloor: 0.55,
    viewModel: 'pistol',
  },
  smg: {
    id: 'smg',
    name: 'MP-9',
    slot: 'primary',
    price: 1250,
    damage: 21,
    headMult: HEAD_MULT,
    mag: 30,
    reserve: 120,
    fireGap: 0.075,
    reloadTime: 1.9,
    automatic: true,
    spreadStill: 0.0075,
    spreadMoving: 0.030,
    recoilPitch: 0.011,
    recoilYaw: 0.006,
    range: 55,
    falloffStart: 14,
    falloffEnd: 44,
    falloffFloor: 0.5,
    viewModel: 'smg',
  },
  rifle: {
    id: 'rifle',
    name: 'AR-7',
    slot: 'primary',
    price: 2700,
    damage: 33,
    headMult: HEAD_MULT,
    mag: 30,
    reserve: 90,
    fireGap: 0.095,
    reloadTime: 2.1,
    automatic: true,
    spreadStill: 0.0020,
    spreadMoving: 0.034,
    recoilPitch: 0.016,
    recoilYaw: 0.005,
    range: 90,
    falloffStart: 26,
    falloffEnd: 70,
    falloffFloor: 0.62,
    viewModel: 'rifle',
  },
  shotgun: {
    id: 'shotgun',
    name: 'M-8 Buck',
    slot: 'primary',
    price: 1900,
    damage: 15,
    headMult: 2.0,
    mag: 6,
    reserve: 30,
    fireGap: 0.72,
    reloadTime: 2.6,
    automatic: false,
    spreadStill: 0.055,
    spreadMoving: 0.075,
    recoilPitch: 0.042,
    recoilYaw: 0.012,
    range: 28,
    falloffStart: 8,
    falloffEnd: 24,
    falloffFloor: 0.2,
    viewModel: 'shotgun',
    pellets: 8,
  },
};

export const GRENADES = {
  frag: { id: 'frag', name: 'Frag', price: 300, damage: 92, radius: 5.2, fuse: 1.7, max: 2 },
  flash: { id: 'flash', name: 'Flash', price: 200, damage: 0, radius: 7.0, fuse: 1.35, max: 2 },
};

// Kevlar turns a body shot into two shots instead of three and halves grenade damage.
export const ARMOR = { id: 'armor', name: 'Kevlar', price: 650, absorb: 0.5 };

// Money: a loss still pays, so a bad round is not a dead economy.
export const ECONOMY = {
  start: 800,
  max: 16000,
  winElimination: 3250,
  winObjective: 3500,
  loss: 1400,
  lossStreakBonus: 500,
  lossStreakMax: 2,
  plantBonus: 300,
  defuseBonus: 300,
  killReward: 300,
  killRewardShotgun: 900,
  teamKillPenalty: -300,
};

// A start loadout for the player, so round one is playable without a buy.
export function startLoadout() {
  return {
    primary: null,
    secondary: 'pistol',
    armor: 0,
    grenades: { frag: 0, flash: 0 },
    ammo: { pistol: { mag: WEAPONS.pistol.mag, reserve: WEAPONS.pistol.reserve } },
  };
}

// View models are built once per weapon type and hung off the camera. Building them lazily keeps
// a game that never buys the shotgun from paying for its geometry.
const BUILT = new Map();

export function buildViewModel(kind) {
  if (BUILT.has(kind)) return BUILT.get(kind).clone();
  const grip = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.72, metalness: 0.2 });
  const body = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.44, metalness: 0.42 });
  const trim = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.accent), roughness: 0.6, metalness: 0.1 });

  const group = new THREE.Group();
  const add = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };

  if (kind === 'pistol') {
    add(new THREE.BoxGeometry(0.05, 0.075, 0.26), body, 0, 0, 0);
    add(new THREE.BoxGeometry(0.042, 0.11, 0.06), grip, 0, -0.075, 0.07);
    add(new THREE.BoxGeometry(0.02, 0.014, 0.05), trim, 0, 0.048, -0.05);
    group.position.set(0.26, -0.19, -0.52);
  } else if (kind === 'smg') {
    add(new THREE.BoxGeometry(0.075, 0.09, 0.36), body, 0, 0, 0);
    add(new THREE.BoxGeometry(0.03, 0.03, 0.22), grip, 0, 0.012, -0.27);
    add(new THREE.BoxGeometry(0.05, 0.17, 0.055), grip, 0, -0.12, 0.04);
    add(new THREE.BoxGeometry(0.045, 0.06, 0.14), trim, 0, -0.02, 0.22);
    group.position.set(0.27, -0.21, -0.58);
  } else if (kind === 'rifle') {
    add(new THREE.BoxGeometry(0.085, 0.1, 0.44), body, 0, 0, 0);
    add(new THREE.BoxGeometry(0.032, 0.032, 0.34), grip, 0, 0.014, -0.36);
    add(new THREE.BoxGeometry(0.055, 0.19, 0.06), grip, 0, -0.14, 0.02);
    add(new THREE.BoxGeometry(0.075, 0.075, 0.2), grip, 0, -0.02, 0.3);
    add(new THREE.BoxGeometry(0.03, 0.05, 0.1), trim, 0, 0.075, 0.02);
    group.position.set(0.28, -0.22, -0.62);
  } else if (kind === 'shotgun') {
    add(new THREE.BoxGeometry(0.09, 0.1, 0.42), grip, 0, 0, 0);
    add(new THREE.BoxGeometry(0.05, 0.05, 0.44), body, 0, 0.03, -0.4);
    add(new THREE.BoxGeometry(0.06, 0.055, 0.2), body, 0, -0.02, -0.3);
    add(new THREE.BoxGeometry(0.07, 0.15, 0.09), grip, 0, -0.1, 0.26);
    group.position.set(0.28, -0.23, -0.60);
  } else if (kind === 'grenade') {
    add(new THREE.SphereGeometry(0.055, 12, 10), grip, 0, 0, 0);
    add(new THREE.BoxGeometry(0.03, 0.03, 0.03), trim, 0, 0.062, 0);
    group.position.set(0.30, -0.26, -0.54);
  }

  group.traverse((mesh) => {
    if (mesh.isMesh) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    }
  });
  BUILT.set(kind, group);
  return group.clone();
}

// Muzzle flash is shared: one plane and one light per gun would be waste, so main.js moves and
// recolours these. Kept here because it belongs to the weapon's look, not the simulation.
export function buildMuzzle() {
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.3, 0.3),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.accent),
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  flash.visible = false;
  const light = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 7, 2);
  return { flash, light };
}

// Pure helper: how far a bullet has fallen off at a given distance.
export function damageAtRange(weapon, distance) {
  if (distance <= weapon.falloffStart) return weapon.damage;
  if (distance >= weapon.falloffEnd) return weapon.damage * weapon.falloffFloor;
  const t = (distance - weapon.falloffStart) / (weapon.falloffEnd - weapon.falloffStart);
  return weapon.damage * (1 - t * (1 - weapon.falloffFloor));
}
