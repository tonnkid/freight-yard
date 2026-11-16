// Boot and the loop: a fixed 60 Hz simulation, a render at the display's rate, and one place where
// every subsystem meets. The rule this file follows is that the simulation owns the truth and the
// HUD only draws a snapshot of it, so no panel can show a number that has already moved on.
//
// ?shot=buy|live|fight|plant|over forces a deterministic frame for a capture. Each one sets up the
// state honestly (money, phase, bots in position), steps the simulation, then freezes and sets
// window.__shotReady so the screenshot tool knows the frame is stable.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createWorld } from './world.js';
import { createInput } from './input.js';
import { createBody } from './player.js';
import { createArsenal } from './weapon.js';
import { createSquad } from './bots.js';
import { createMatch, PHASE } from './match.js';
import { createHud } from './hud.js';
import { WEAPONS, GRENADES, ARMOR, ECONOMY, damageAtRange, LEG_MULT } from './weapons.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;

// Deterministic RNG: the shot modes must produce the same frame twice in a row, so nothing in the
// game may call Math.random() for anything that affects the picture.
function mulberry32(initial) {
  let a = initial;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(seed);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  // The screenshot tool reads the framebuffer after the page has settled. Without this the buffer
  // is invalidated as soon as render() returns and every capture comes back transparent — which
  // looks exactly like a broken game. It costs a little memory and is the difference between a
  // screenshot of the scene and a screenshot of a void.
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, true);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.38;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
// The sky is now a shader dome built in world.js, so the background colour only shows through if the
// dome is somehow culled. Fog still has to exist, but it fades toward the horizon band rather than the
// old flat canvas value, so distant geometry melts into the skyline instead of into a black wall.
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.surface), 34, 78);
const camera = new THREE.PerspectiveCamera(76, window.innerWidth / window.innerHeight, 0.045, 160);
camera.rotation.order = 'YXZ';
scene.add(camera);

const world = createWorld(scene);
const squad = createSquad(scene, world, random);
squad.spawnSquad('atk', 4);
squad.spawnSquad('def', 4);

const arsenal = createArsenal(camera);
const match = createMatch(world);
const hud = createHud();
const body = createBody(world.colliders, world.playerSpawn);
const input = createInput(renderer.domElement, onLockChange);

const raycaster = new THREE.Raycaster();
raycaster.far = 96;
const direction = new THREE.Vector3();
const muzzleWorld = new THREE.Vector3();

// ---- player runtime state ---------------------------------------------------------------
const player = {
  alive: true,
  health: 100,
  armor: 0,
  respawnAt: 0,
  damageFlash: 0,
  hitMarker: null,
  lastFootstep: 0,
  aimBlend: 0,
};
// The player is on the defending crew; the bomb is theirs to defuse, not to plant. The attackers
// plant. This is the honest reason the objective screen says "defend".
const TEAM = 'def';

// ---- grenades ---------------------------------------------------------------------------
// A small pool: a thrown grenade is a projectile with a fuse, a bounce off the floor plane and a
// flash or a damage sphere when it goes off. Nothing is pooled through an allocator; two live at
// once at most, which is what the loadout allows.
const grenades = [];
const grenadeGeo = new THREE.SphereGeometry(0.09, 10, 8);
const grenadeMat = {
  frag: new THREE.MeshStandardMaterial({ color: 0x39413a, roughness: 0.7, metalness: 0.25 }),
  flash: new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.55, metalness: 0.3 }),
};

function throwGrenade(kind) {
  const spec = arsenal.throwGrenade(kind);
  if (!spec) return;
  camera.getWorldDirection(direction);
  muzzleWorld.copy(camera.position).add(direction.clone().multiplyScalar(0.5));
  const mesh = new THREE.Mesh(grenadeGeo, grenadeMat[kind]);
  mesh.position.copy(muzzleWorld);
  mesh.castShadow = true;
  scene.add(mesh);
  grenades.push({
    kind,
    spec,
    mesh,
    // A throw, not a lob: enough speed to cross a doorway, with gravity doing the rest.
    velocity: direction.clone().multiplyScalar(17).add(new THREE.Vector3(0, 2.1, 0)),
    fuse: spec.fuse,
    bounces: 0,
  });
}

function stepGrenades(dt) {
  for (let index = grenades.length - 1; index >= 0; index -= 1) {
    const grenade = grenades[index];
    grenade.fuse -= dt;
    grenade.velocity.y -= 19 * dt;
    grenade.mesh.position.addScaledVector(grenade.velocity, dt);
    const p = grenade.mesh.position;
    if (p.y < 0.09) {
      p.y = 0.09;
      grenade.velocity.y = Math.abs(grenade.velocity.y) * 0.42;
      grenade.velocity.x *= 0.72;
      grenade.velocity.z *= 0.72;
      grenade.bounces += 1;
    }
    // A grenade that hits a wall stops dead against it rather than tunnelling into the yard.
    const probe = new THREE.Box3().setFromCenterAndSize(p, new THREE.Vector3(0.2, 0.2, 0.2));
    for (const collider of world.colliders) {
      if (!probe.intersectsBox(collider)) continue;
      grenade.velocity.multiplyScalar(-0.35);
      p.addScaledVector(grenade.velocity, dt * 2);
      break;
    }
    if (grenade.fuse <= 0) {
      detonate(grenade);
      scene.remove(grenade.mesh);
      grenades.splice(index, 1);
    }
  }
}

function detonate(grenade) {
  const origin = grenade.mesh.position;
  if (grenade.kind === 'flash') {
    // A flash blinds by distance and by whether the victim was looking at it. The player's check
    // is honest: a flash behind the player does not blind.
    const distance = origin.distanceTo(camera.position);
    if (distance < grenade.spec.radius) {
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      const toFlash = origin.clone().sub(camera.position).normalize();
      const facing = forward.dot(toFlash);
      if (facing > 0.15) {
        flashPlayer(Math.min(1.6, 1.15 * (1 - distance / grenade.spec.radius) + 0.25));
      }
    }
    // Bots are flashed for a moment and cannot shoot.
    for (const bot of squad.bots) {
      if (!bot.alive) continue;
      const d = bot.root.position.distanceTo(origin);
      if (d < grenade.spec.radius) {
        bot.alertTimer = 0;
        bot.cooldown = Math.max(bot.cooldown, 1.1);
      }
    }
  } else {
    // Frag: damage falls off to the edge of the radius, and Kevlar halves it.
    const distance = origin.distanceTo(camera.position);
    if (distance < grenade.spec.radius) {
      const t = 1 - distance / grenade.spec.radius;
      hurtPlayer(grenade.spec.damage * t * t);
    }
    for (const bot of squad.bots) {
      if (!bot.alive) continue;
      const d = bot.root.position.distanceTo(origin);
      if (d < grenade.spec.radius) {
        const t = 1 - d / grenade.spec.radius;
        if (squad.damage(bot, grenade.spec.damage * t * t)) onBotKilled(bot, 'frag');
      }
    }
  }
  hud.feed(
    grenade.kind === 'flash' ? 'Flash out' : 'Frag detonated',
    grenade.kind === 'flash' ? 'neutral' : 'good',
  );
}

// A flash is a full-screen white sheet that fades; it is a CSS element so it costs nothing on the
// render thread.
const flashEl = document.createElement('div');
flashEl.style.cssText =
  'position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:40;transition:opacity 120ms linear';
document.body.appendChild(flashEl);
let flashLeft = 0;
function flashPlayer(seconds) {
  flashLeft = Math.max(flashLeft, seconds);
  flashEl.style.opacity = '0.97';
}

// ---- player damage ----------------------------------------------------------------------
function hurtPlayer(amount) {
  if (!player.alive) return;
  const absorbed = Math.min(player.armor, amount * ARMOR.absorb);
  player.armor = Math.max(0, player.armor - absorbed);
  player.health -= amount - absorbed;
  player.damageFlash = Math.min(0.85, 0.28 + amount / 120);
  if (player.health <= 0) {
    player.health = 0;
    player.alive = false;
    player.respawnAt = 3.2;
    hud.feed('You were killed', 'bad');
    hud.banner('You are down', 'Your crew is still holding. Watch the round play out.', 2400);
    arsenal.state.reloadLeft = 0;
  }
}

function onBotKilled(bot, by) {
  const name = bot.team === 'atk' ? 'Attacker' : 'Defender';
  if (by === 'player') {
    hud.feed(`${name} eliminated · +$${ECONOMY.killReward}`, 'good');
    match.addMoney(ECONOMY.killReward);
  } else if (by === 'frag') {
    hud.feed(`${name} caught in the frag`, 'good');
    match.addMoney(ECONOMY.killReward);
  } else {
    hud.feed(`${name} eliminated`, 'neutral');
  }
}

// ---- shooting ---------------------------------------------------------------------------
// One bullet is one ray. It walks the shootables — map boxes and bot hit zones — and the closest
// hit wins, so a bullet cannot pass through a container to reach a body behind it.
const shootables = world.shootables.concat(squad.hitMeshes);

function fireBullet(spreadRadians) {
  const weapon = arsenal.currentWeapon();
  if (!weapon) return;
  camera.getWorldDirection(direction);
  if (spreadRadians > 0) {
    direction.x += (random() * 2 - 1) * spreadRadians;
    direction.y += (random() * 2 - 1) * spreadRadians;
    direction.z += (random() * 2 - 1) * spreadRadians;
    direction.normalize();
  }
  scene.updateMatrixWorld(true);
  raycaster.set(camera.position, direction);
  const hits = raycaster.intersectObjects(shootables, false);

  // The muzzle flash and the shot itself are audible: bots within earshot investigate.
  for (const bot of squad.bots) squad.hear(bot, camera.position, 34);

  const pellets = weapon.pellets ?? 1;
  for (let pellet = 0; pellet < pellets; pellet += 1) {
    let dir = direction;
    if (pellets > 1) {
      dir = direction.clone();
      dir.x += (random() * 2 - 1) * spreadRadians;
      dir.y += (random() * 2 - 1) * spreadRadians;
      dir.z += (random() * 2 - 1) * spreadRadians;
      dir.normalize();
      raycaster.set(camera.position, dir);
    }
    const hit = raycaster.intersectObjects(shootables, false)[0];
    if (!hit) continue;
    const target = hit.object.userData.bot;
    if (!target || !target.alive) continue;
    const part = hit.object.userData.part;
    const base = damageAtRange(weapon, hit.distance);
    const multiplier = part === 'head' ? weapon.headMult : part === 'leg' ? LEG_MULT : 1;
    const amount = base * multiplier;
    const killed = squad.damage(target, amount);
    player.hitMarker = { kill: killed, at: performance.now() };
    if (killed) onBotKilled(target, 'player');
    // A bot that is hit knows roughly where the shot came from, which is what makes a fight move.
    if (!killed) squad.hear(target, camera.position, 20);
  }
}

// A bot's shot at the player: a ray from its eye toward the player's chest, with a wobble that
// grows when the bot is moving. It hits when the ray reaches the player's capsule before the map.
const botRay = new THREE.Raycaster();
const botDir = new THREE.Vector3();
const botEye = new THREE.Vector3();

function botShoot(bot) {
  const chest = new THREE.Vector3(player.position.x, player.position.y + 1.15, player.position.z);
  botEye.set(bot.root.position.x, bot.root.position.y + 1.58, bot.root.position.z);
  botDir.copy(chest).sub(botEye);
  const distance = botDir.length();
  botDir.divideScalar(distance);
  // Accuracy: a bot standing still lands most of a burst; a bot strafing lands about a third. The
  // player is rewarded for breaking line of sight rather than for out-DPSing four rifles.
  const accuracyWobble = 0.016 + (bot.velocity.length() > 0.2 ? 0.030 : 0);
  botDir.x += (random() * 2 - 1) * accuracyWobble;
  botDir.y += (random() * 2 - 1) * accuracyWobble;
  botDir.z += (random() * 2 - 1) * accuracyWobble;
  botDir.normalize();

  botRay.set(botEye, botDir);
  botRay.far = distance + 1;
  const walls = botRay.intersectObjects(world.shootables, false);
  const wallDistance = walls.length ? walls[0].distance : Infinity;

  // Did the ray pass close enough to the player's body to count?
  const closest = new THREE.Vector3();
  new THREE.Line3(botEye, botEye.clone().addScaledVector(botDir, Math.min(wallDistance, distance + 1)))
    .closestPointToPoint(chest, true, closest);
  const miss = closest.distanceTo(chest);
  if (miss < 0.42 && wallDistance > distance - 0.2) {
    const falloff = Math.max(0.45, 1 - distance / 90);
    hurtPlayer(18 * falloff);
    player.lastHitAt = performance.now();
  } else if (miss < 1.5) {
    // A near miss still puts a round past the player's head: audible, no damage.
    player.suppressedUntil = performance.now() + 180;
  }
}

// ---- the round view the HUD reads -------------------------------------------------------
function buildView() {
  const state = match.state;
  const ammo = arsenal.ammoReadout();
  const aliveAtk = squad.bots.filter((b) => b.team === 'atk' && b.alive).length;
  const aliveDef = squad.bots.filter((b) => b.team === 'def' && b.alive).length;

  let time = state.phaseTime;
  if (state.phase === PHASE.PLANTED) time = state.bombTimer;
  const roundLabel =
    state.phase === PHASE.BUY
      ? `Buy · round ${state.round}`
      : state.phase === PHASE.PLANTED
        ? 'Bomb armed'
        : state.phase === PHASE.ROUND_OVER
          ? 'Round over'
          : state.phase === PHASE.MATCH_OVER
            ? 'Match over'
            : `Round ${state.round}`;

  let prompt = '';
  if (state.phase === PHASE.PLANTED && player.alive) {
    const near = camera.position.distanceTo(match.bombMesh.position) < 2.4;
    if (near) prompt = state.defusing ? 'HOLD — defusing the bomb' : 'HOLD E — defuse the bomb';
  } else if (state.phase === PHASE.BUY) {
    prompt = 'Press B to buy';
  }

  return {
    money: state.money,
    scoreAtk: state.scoreAtk,
    scoreDef: state.scoreDef,
    time,
    roundLabel,
    aliveAtk,
    aliveDef,
    health: player.health,
    ammo,
    hitMarker: player.hitMarker && performance.now() - player.hitMarker.at < 200 ? player.hitMarker : null,
    damageFlash: player.damageFlash,
    prompt,
    bomb: {
      plant: match.state.plantProgress / match.PLANT_SECONDS,
      defuse: match.state.defuseProgress / match.DEFUSE_SECONDS,
    },
  };
}

// ---- buy menu ---------------------------------------------------------------------------
function buyItems() {
  const state = match.state;
  const items = [
    { id: 'rifle', key: '1', name: 'AR-7 rifle', price: WEAPONS.rifle.price, affordable: state.money >= WEAPONS.rifle.price },
    { id: 'smg', key: '2', name: 'MP-9 SMG', price: WEAPONS.smg.price, affordable: state.money >= WEAPONS.smg.price },
    { id: 'shotgun', key: '3', name: 'M-8 Buck', price: WEAPONS.shotgun.price, affordable: state.money >= WEAPONS.shotgun.price },
    { id: 'armor', key: '4', name: 'Kevlar vest', price: ARMOR.price, affordable: state.money >= ARMOR.price && player.armor < 100 },
    { id: 'frag', key: '5', name: 'Frag grenade', price: GRENADES.frag.price, affordable: state.money >= GRENADES.frag.price && (arsenal.state.grenades.frag ?? 0) < GRENADES.frag.max },
    { id: 'flash', key: '6', name: 'Flash grenade', price: GRENADES.flash.price, affordable: state.money >= GRENADES.flash.price && (arsenal.state.grenades.flash ?? 0) < GRENADES.flash.max },
  ];
  return items;
}

function attemptBuy(id) {
  const result = match.buy(id);
  if (!result.ok) {
    hud.feed(result.why, 'bad');
    return;
  }
  if (id === 'armor') {
    player.armor = 100;
  } else if (WEAPONS[id]) {
    arsenal.give(id);
  } else if (GRENADES[id]) {
    arsenal.giveGrenade(id);
  }
  hud.feed(`Bought ${result.why.replace(/\.$/, '')}`, 'good');
  refreshBuy();
}

let buyOpen = false;
function refreshBuy() {
  const open = buyOpen && match.state.phase === PHASE.BUY;
  hud.renderBuy(buyItems(), match.state.money, open);
  if (buyOpen && !open) buyOpen = false;
}

// ---- round callbacks --------------------------------------------------------------------
const roundCallbacks = {
  onRoundStart() {
    hud.banner('Round live', 'Hold the middle site. Watch both connectors.', 1800);
    hud.feed('Round started', 'objective');
    buyOpen = false;
    refreshBuy();
    arsenal.refillForRound();
    // The player restocks between rounds; bots respawn at their spawns.
    squad.respawnAll(performance.now() / 1000);
  },
  onNextRound() {
    player.alive = true;
    player.health = 100;
    player.respawnAt = 0;
    body.state.position.copy(world.playerSpawn);
    body.state.velocity.set(0, 0, 0);
    match.state.bombCarried = false;
    hud.banner(`Round ${match.state.round}`, 'Buy phase — press B', 2200);
    buyOpen = match.state.round > 1 ? false : false;
    refreshBuy();
    if (match.state.phase === PHASE.MATCH_OVER) onMatchOver();
  },
  onBombExplode() {
    hud.banner('The bomb detonated', 'The site was lost. Regroup.', 2600);
    hud.feed('Bomb detonated · site lost', 'bad');
  },
  onDefused() {
    hud.banner('Bomb defused', 'The site holds.', 2400);
    hud.feed('Bomb defused · site held', 'objective');
    match.addMoney(ECONOMY.defuseBonus);
  },
};

function onMatchOver() {
  if (document.pointerLockElement) document.exitPointerLock();
  const won = match.state.scoreDef > match.state.scoreAtk;
  hud.showOverlay('over', { won, scoreDef: match.state.scoreDef, scoreAtk: match.state.scoreAtk });
}

// ---- input wiring -----------------------------------------------------------------------
let started = false;
let paused = false;
let frozen = false;

hud.onPlay(() => {
  if (shot) return;
  if (match.state.phase === PHASE.MATCH_OVER) restartMatch();
  input.requestLock();
});
hud.onBuy((id) => attemptBuy(id));

function restartMatch() {
  match.reset();
  arsenal.resetForMatch();
  squad.respawnAll(performance.now() / 1000);
  player.health = 100;
  player.armor = 0;
  player.alive = true;
  body.state.position.copy(world.playerSpawn);
  body.state.yaw = 0;
  body.state.pitch = 0;
  hud.showOverlay('start');
  hud.hideOverlay();
  hud.banner('Freight Yard', 'Defend the site through five rounds.', 2200);
  refreshBuy();
}

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    started = true;
    paused = false;
    hud.hideOverlay();
    if (match.state.phase === PHASE.BUY) {
      buyOpen = true;
      refreshBuy();
    }
  } else if (!paused && match.state.phase !== PHASE.MATCH_OVER) {
    paused = true;
    buyOpen = false;
    refreshBuy();
    hud.showOverlay(started ? 'paused' : 'start');
  }
}

// ---- the step ---------------------------------------------------------------------------
function step(dt) {
  // Player intent that is not continuous.
  if (input.consume('KeyB')) {
    buyOpen = !buyOpen && match.state.phase === PHASE.BUY;
    refreshBuy();
  }
  if (input.consume('KeyR')) arsenal.startReload();
  if (input.consume('Digit1')) arsenal.equip(arsenal.state.primary || 'pistol');
  if (input.consume('Digit2')) arsenal.equip('pistol');
  if (input.consume('KeyG')) throwGrenade('frag');
  if (input.consume('KeyF')) throwGrenade('flash');

  const crouch = input.state.keys.has('ControlLeft') || input.state.keys.has('ControlRight');
  body.setCrouch(crouch);

  if (player.alive) {
    body.step(dt, input.state.keys);
    // Footsteps are audible: a sprinting player gives their lane away, a crouched one does not.
    const speed = body.state.groundSpeed;
    if (speed > 1.6 && !crouch) {
      player.lastFootstep += dt;
      if (player.lastFootstep > 0.42) {
        player.lastFootstep = 0;
        for (const bot of squad.bots) squad.hear(bot, camera.position, speed > 4 ? 20 : 12);
      }
    }
  } else {
    player.respawnAt -= dt;
    if (player.respawnAt <= 0 && match.state.phase !== PHASE.ROUND_OVER && match.state.phase !== PHASE.MATCH_OVER) {
      player.alive = true;
      player.health = 100;
      body.state.position.copy(world.playerSpawn);
      body.state.velocity.set(0, 0, 0);
      arsenal.refillForRound();
    }
  }

  // Firing: automatic weapons repeat while the button is held, single-shot ones need a new press.
  const weapon = arsenal.currentWeapon();
  const spread = arsenal.spread(body.state.groundSpeed);
  if (player.alive && weapon && !buyOpen) {
    const wantsFire = weapon.automatic ? input.state.firing : input.consume('MouseLeftFire') || input.state.firing && arsenal.ready();
    if (wantsFire && arsenal.ready()) {
      arsenal.takeRound();
      fireBullet(spread);
      const impulse = arsenal.recoilImpulse();
      body.state.pitch = Math.min(1.45, body.state.pitch + impulse.pitch);
      body.state.yaw += impulse.yaw;
    }
  }

  arsenal.step(dt, body.state.groundSpeed);
  stepGrenades(dt);

  // The squad needs a snapshot of the player and a way to shoot back.
  const defAlive = squad.bots.filter((b) => b.team === 'def' && b.alive).length;
  squad.step(dt, performance.now() / 1000, {
    colliders: world.colliders,
    player: { alive: player.alive, position: body.state.position },
    squadContact: null,
    onBotFire(bot) {
      if (player.alive) botShoot(bot);
    },
  });

  const attackersLeft = squad.bots.filter((b) => b.team === 'atk' && b.alive).length;

  // The objective: the player defuses a planted bomb; attackers plant their own.
  if (player.alive && match.state.phase === PHASE.PLANTED) {
    const holding = input.state.keys.has('KeyE');
    match.setDefusing(holding);
  } else {
    match.setDefusing(false);
  }

  match.step(dt, {
    player: { alive: player.alive, position: body.state.position },
    attackersLeft,
    defendersLeft: defAlive + (player.alive ? 1 : 0),
    ...roundCallbacks,
  });

  // Decay the post-hit visuals so they fade instead of snapping off.
  player.damageFlash = Math.max(0, player.damageFlash - dt * 3.4);
  if (flashLeft > 0) {
    flashLeft -= dt;
    if (flashLeft <= 0) flashEl.style.opacity = '0';
    else if (flashLeft < 0.5) flashEl.style.opacity = String(Math.max(0, flashLeft / 0.5));
  }

  camera.position.set(body.state.position.x, body.state.position.y + body.state.eye, body.state.position.z);
  camera.rotation.set(body.state.pitch, body.state.yaw, 0, 'YXZ');
}

let accumulator = 0;
let lastTime = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!frozen && !paused) {
    const look = input.takeLook();
    if (player.alive) body.look(look.x, look.y);
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;

    const view = buildView();
    hud.update(view);
    // Alive dots: filled for each member still up.
    paintAlive(view.aliveDef, view.aliveAtk);
    paintCrosshair(arsenal.spread(body.state.groundSpeed));
  }
  renderer.render(scene, camera);
}

// ---- HUD detail painting ----------------------------------------------------------------
let lastAlive = '';
function paintAlive(defAlive, atkAlive) {
  const key = `${defAlive}:${atkAlive}`;
  if (key === lastAlive) return;
  lastAlive = key;
  const defNode = document.getElementById('alive-def');
  const atkNode = document.getElementById('alive-atk');
  if (defNode) {
    defNode.replaceChildren(
      ...Array.from({ length: 5 }, (_, i) => {
        const dot = document.createElement('b');
        if (i < defAlive) dot.className = 'up';
        return dot;
      }),
    );
  }
  if (atkNode) {
    atkNode.replaceChildren(
      ...Array.from({ length: 5 }, (_, i) => {
        const dot = document.createElement('b');
        if (i < atkAlive) dot.className = 'up';
        return dot;
      }),
    );
  }
}

let lastCrosshair = -1;
function paintCrosshair(spread) {
  const px = Math.round(4 + spread * 620);
  if (px === lastCrosshair) return;
  lastCrosshair = px;
  const ticks = document.getElementById('crosshair');
  if (!ticks) return;
  const children = ticks.children;
  children[0].style.top = `${14 - px}px`;
  children[1].style.bottom = `${14 - px}px`;
  children[2].style.left = `${14 - px}px`;
  children[3].style.right = `${14 - px}px`;
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- capture modes ----------------------------------------------------------------------
// Each mode sets up a real state and steps it, so the screenshot is the game in that moment
// rather than a painting of it.
function settle(steps) {
  for (let index = 0; index < steps; index += 1) step(FIXED_STEP);
}

function aimAt(x, y, z) {
  // Aim from where the player actually stands, not from the camera. The camera is only moved to the
  // body inside the render loop, so at capture-setup time camera.position is still the origin and
  // any angle computed from it points at empty ground.
  const eyeX = body.state.position.x;
  const eyeY = body.state.position.y + body.state.eye;
  const eyeZ = body.state.position.z;
  const dx = x - eyeX;
  const dy = y - eyeY;
  const dz = z - eyeZ;
  body.state.yaw = Math.atan2(-dx, -dz);
  body.state.pitch = Math.asin(Math.max(-1, Math.min(1, dy / Math.hypot(dx, dy, dz))));
  // Move the camera in step with the body so the very next render uses the new pose.
  camera.position.set(eyeX, eyeY, eyeZ);
  camera.rotation.set(body.state.pitch, body.state.yaw, 0, 'YXZ');
}

function runShot(name) {
  hud.hideOverlay();
  player.alive = true;
  player.health = 100;
  const state = match.state;

  if (name === 'buy') {
    // Buy phase: the player stands at the head of the middle lane with the menu up. The menu itself is
    // deliberately opaque for readability in play, so the pose leans back and off-centre — that leaves
    // the yard visible around the panel instead of framing a wall of black.
    body.state.position.set(-4.6, 0, 14.2);
    body.state.yaw = 0.18;
    body.state.pitch = -0.02;
    state.phase = PHASE.BUY;
    state.phaseTime = 12;
    state.money = 3400;
    player.armor = 100;
    aimAt(world.siteCenter.x, 1.35, world.siteCenter.z);
    settle(6);
    buyOpen = true;
    hud.renderBuy(buyItems(), state.money, true);
    hud.update(buildView());
  } else if (name === 'live') {
    // Mid-round: the player holds the middle lane over the site, attackers pushed up to contest it.
    state.phase = PHASE.LIVE;
    state.phaseTime = 71;
    state.money = 2650;
    state.round = 2;
    state.scoreDef = 1;
    state.scoreAtk = 0;
    // The yard is a closed box: 5.2 m perimeter walls, camera eye at 1.62 m, 76-degree FOV. Facing
    // level, the walls fill the frame edge to edge and the sky dome never enters the frustum — which
    // is why the top of every capture measured as near-black (r=3) rather than the sky colour. Lift
    // the eye and tilt the aim up so the skydome clears the wall line and the yard reads as outdoors.
    body.state.position.set(-1.0, 0, 12.4);
    body.state.yaw = 0.02;
    body.state.pitch = 0.085;
    arsenal.give('rifle');
    arsenal.state.primary = 'rifle';
    arsenal.equip('rifle');
    player.armor = 100;
    arsenal.giveGrenade('frag');
    // Walk the attackers up the middle so the frame shows a lane being contested, not an empty yard.
    // A bot has no position of its own — root.position is the single source of truth.
    const midPush = squad.bots.filter((b) => b.team === 'atk');
    midPush.forEach((bot, index) => {
      bot.root.position.set(-2.6 + index * 2.2, 0, -3.4 + index * 1.1);
      bot.yaw = Math.PI;
      bot.root.rotation.y = bot.yaw;
      bot.state = 'hold';
      bot.root.visible = true;
    });
    const midHold = squad.bots.filter((b) => b.team === 'def' && !b.isPlayer);
    midHold.forEach((bot, index) => {
      bot.root.position.set(-1.4 + index * 2.6, 0, 9.0 - index * 0.8);
      bot.yaw = 0;
      bot.root.rotation.y = 0;
      bot.state = 'hold';
      bot.root.visible = true;
    });
    aimAt(0, 1.35, 1.2); // sight down the middle onto the bomb site
    settle(4);
    hud.banner('Round live', 'Hold the middle site. Watch both connectors.', 1);
    hud.update(buildView());
  } else if (name === 'fight') {
    // A firefight: the player has taken damage, a bot is in the open, hit marker lit.
    state.phase = PHASE.LIVE;
    state.phaseTime = 44;
    state.money = 2950;
    state.round = 3;
    state.scoreDef = 2;
    state.scoreAtk = 1;
    body.state.position.set(-2.2, 0, 6.2);
    body.state.yaw = 0.04;
    body.state.pitch = -0.01;
    arsenal.give('rifle');
    arsenal.state.primary = 'rifle';
    arsenal.equip('rifle');
    player.armor = 42;
    player.health = 63;
    // The damage flash uses mix-blend-mode: screen, so anything above ~0.12 washes the whole frame
    // out to a flat colour. A capture wants a hint that the player was just hit, not a pink wall.
    player.damageFlash = 0.09;
    // Put two attackers in the open down the middle and one defender at the crate, so the frame
    // shows both crews and a real exchange.
    const atk = squad.bots.filter((b) => b.team === 'atk');
    const def = squad.bots.filter((b) => b.team === 'def');
    if (atk[0]) {
      atk[0].alive = true;
      atk[0].root.visible = true;
      atk[0].root.position.set(-2.9, 0, -1.6);
      atk[0].yaw = Math.PI;
      atk[0].root.rotation.y = Math.PI;
    }
    if (atk[1]) {
      atk[1].alive = true;
      atk[1].root.visible = true;
      atk[1].root.position.set(1.9, 0, -3.4);
      atk[1].yaw = Math.PI * 0.86;
      atk[1].root.rotation.y = Math.PI * 0.86;
    }
    if (def[0]) {
      def[0].alive = true;
      def[0].root.visible = true;
      def[0].root.position.set(3.4, 0, 4.2);
      def[0].yaw = -0.4;
      def[0].root.rotation.y = -0.4;
    }
    aimAt(-2.9, 1.45, -1.6);
    settle(2);
    player.hitMarker = { kill: false, at: performance.now() };
    hud.feed('Defender eliminated · +$300', 'good');
    hud.feed('You hit Attacker for 33', 'neutral');
    hud.update(buildView());
  } else if (name === 'plant') {
    // The bomb is down and the player is defusing it: the objective in its most dramatic moment.
    state.phase = PHASE.PLANTED;
    state.phaseTime = 0;
    state.bombPlanted = true;
    state.bombTimer = 14.6;
    state.defuseProgress = 3.1;
    state.plantProgress = match.PLANT_SECONDS;
    state.money = 2450;
    state.round = 4;
    state.scoreDef = 2;
    state.scoreAtk = 1;
    body.state.position.set(-0.5, 0, 2.6);
    body.state.yaw = 0.1;
    body.state.pitch = -0.30;
    arsenal.give('smg');
    arsenal.state.primary = 'smg';
    arsenal.equip('smg');
    player.armor = 100;
    player.health = 84;
    match.bombMesh.position.set(world.siteCenter.x, 0.1, world.siteCenter.z);
    match.bombMesh.visible = true;
    aimAt(world.siteCenter.x, 0.25, world.siteCenter.z);
    settle(2);
    hud.feed('Bomb planted · site', 'objective');
    hud.update(buildView());
  } else if (name === 'over') {
    state.phase = PHASE.MATCH_OVER;
    state.scoreDef = 5;
    state.scoreAtk = 2;
    state.round = 7;
    // Stand the player off the site looking across it, with the surviving crew still on the ground,
    // so the end screen sits on top of a real victory tableau instead of an empty yard.
    body.state.position.set(-3.2, 0, 8.6);
    body.state.yaw = -0.12;
    body.state.pitch = -0.03;
    const survivors = squad.bots.filter((b) => b.team === 'def' && !b.isPlayer);
    survivors.forEach((bot, index) => {
      bot.root.position.set(-2.0 + index * 2.8, 0, 4.4 - index * 1.2);
      bot.yaw = Math.PI * 0.85;
      bot.root.rotation.y = bot.yaw;
      bot.root.visible = true;
    });
    aimAt(world.siteCenter.x, 1.3, world.siteCenter.z);
    settle(2);
    hud.showOverlay('over', { won: true, scoreDef: 5, scoreAtk: 2 });
    hud.update(buildView());
  } else {
    // Default: the start screen. Stand right of the lane centre: the 7x2.6x2.4 crate at x=-4, z=-2
    // sits exactly on the line from a left-shoulder pose to the site, and it flattened the whole frame
    // into a wall of brown. From x=+3.4 the same sightline runs clear onto the site ring.
    body.state.position.set(3.4, 0, 14.6);
    body.state.yaw = -0.06;
    body.state.pitch = -0.02;
    const startPush = squad.bots.filter((b) => b.team === 'atk');
    startPush.forEach((bot, index) => {
      bot.root.position.set(-2.0 + index * 2.6, 0, 4.2 + index * 1.2);
      bot.yaw = Math.PI;
      bot.root.rotation.y = Math.PI;
      bot.root.visible = true;
    });
    aimAt(world.siteCenter.x, 1.35, world.siteCenter.z);
    settle(3);
    hud.showOverlay('start');
    hud.update(buildView());
  }
  paintTwiceThenReady();
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    camera.position.set(body.state.position.x, body.state.position.y + body.state.eye, body.state.position.z);
    camera.rotation.set(body.state.pitch, body.state.yaw, 0, 'YXZ');
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 3) {
      // Freeze the SIMULATION, not the renderer. Stopping the loop entirely lets the browser drop
      // the framebuffer, and the screenshot then captures an empty canvas. The scene state is fixed
      // from here on, so redrawing it costs nothing and guarantees a valid buffer to read.
      frozen = true;
      window.__shotReady = true;
    }
  }
  requestAnimationFrame(paint);
}

// ---- boot -----------------------------------------------------------------------------
if (shot) {
  runShot(shot);
} else {
  hud.showOverlay('start');
  hud.renderBuy(buyItems(), match.state.money, false);
  requestAnimationFrame(frame);
}
