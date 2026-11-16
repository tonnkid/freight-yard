// The opposing crew. Each bot is a small soldier with a rifle, a route through one lane, an angle
// it likes to hold, and a set of things it reacts to: a body it can see, a muzzle flash it just
// saw, the sound of a shot, footsteps close behind a wall, the bomb being planted.
//
// The design goal is that a bot reads as a player of middling skill: it pushes its lane, stops at
// its angle, checks the connector, and only then starts shooting — and it misses when it fires on
// the move, which is what makes stopping to aim worth it for the human too.
//
// Hits are checked against head, torso and legs, so damage depends on where the bullet lands.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const HEALTH = 100;
const BOT_RIFLE = {
  damage: 24,
  fireGap: 0.145,
  mag: 25,
  reloadTime: 2.3,
  range: 78,
  falloffStart: 20,
  falloffEnd: 62,
  falloffFloor: 0.5,
};
const SPEED = 3.5;
const CHASE_SPEED = 4.5;
const TURN_RATE = 4.2;
const EYE_HEIGHT = 1.58;
// How close a bot gets to a waypoint before it counts as reached.
const ARRIVE = 0.9;
// A bot that has not seen anything for this long goes back to its route.
const ALERT_MEMORY = 6.0;

export function createSquad(scene, world, rnd) {
  const geometryCache = {
    torso: new THREE.BoxGeometry(0.56, 0.78, 0.34),
    head: new THREE.SphereGeometry(0.155, 12, 10),
    leg: new THREE.BoxGeometry(0.17, 0.86, 0.19),
    arm: new THREE.BoxGeometry(0.13, 0.62, 0.15),
    gun: new THREE.BoxGeometry(0.07, 0.08, 0.5),
  };

  const bots = [];
  const hitMeshes = [];

  function buildMaterials(team) {
    const base = team === 'atk' ? PALETTE.teamAtk : PALETTE.teamDef;
    return {
      // Body, head and limbs share one material per team so a squad reads as two sides at a glance
      // and the whole squad costs three materials rather than three per bot.
      body: new THREE.MeshStandardMaterial({ color: new THREE.Color(base), roughness: 0.74, metalness: 0.08 }),
      head: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.6, metalness: 0.1 }),
      boot: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.85 }),
    };
  }

  const MATERIALS = { atk: buildMaterials('atk'), def: buildMaterials('def') };

  function build(team, index, spawn) {
    const materials = MATERIALS[team];
    const root = new THREE.Group();
    const rig = new THREE.Group();
    root.add(rig);

    const torso = new THREE.Mesh(geometryCache.torso, materials.body);
    torso.position.y = 1.05;
    const head = new THREE.Mesh(geometryCache.head, materials.head);
    head.position.y = 1.6;
    const legL = new THREE.Mesh(geometryCache.leg, materials.boot);
    legL.position.set(-0.13, 0.45, 0);
    const legR = new THREE.Mesh(geometryCache.leg, materials.boot);
    legR.position.set(0.13, 0.45, 0);
    const armL = new THREE.Mesh(geometryCache.arm, materials.body);
    armL.position.set(-0.33, 1.18, -0.06);
    const armR = new THREE.Mesh(geometryCache.arm, materials.body);
    armR.position.set(0.33, 1.18, -0.06);
    const gun = new THREE.Mesh(geometryCache.gun, materials.boot);
    gun.position.set(0.16, 1.16, -0.34);
    rig.add(torso, head, legL, legR, armL, armR, gun);

    torso.userData.part = 'torso';
    head.userData.part = 'head';
    legL.userData.part = 'leg';
    legR.userData.part = 'leg';

    root.position.copy(spawn);
    root.rotation.y = team === 'atk' ? 0 : Math.PI;
    scene.add(root);

    const bot = {
      team,
      index,
      root,
      rig,
      torso,
      head,
      legL,
      legR,
      health: HEALTH,
      alive: true,
      respawnAt: 0,
      // Aim and state.
      yaw: team === 'atk' ? 0 : Math.PI,
      pitch: 0,
      target: null,
      alertTimer: 0,
      lastSeenPos: new THREE.Vector3(),
      heardPos: new THREE.Vector3(),
      hasHeard: false,
      // Route state.
      route: null,
      node: 0,
      holdAt: null,
      holdTimer: 0,
      // Weapon state.
      mag: BOT_RIFLE.mag,
      cooldown: 0,
      reloadLeft: 0,
      burst: 0,
      burstPause: 0,
      // Movement.
      velocity: new THREE.Vector3(),
      walkPhase: rnd() * Math.PI * 2,
    };

    for (const mesh of [torso, head, legL, legR]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.bot = bot;
      hitMeshes.push(mesh);
    }
    bots.push(bot);
    return bot;
  }

  // Reuse one camera-shaped frustum test: a bot sees a target when the target is inside its view
  // cone, close enough, and nothing in the map is between them.
  const viewDir = new THREE.Vector3();
  const toTarget = new THREE.Vector3();
  const eye = new THREE.Vector3();
  const ray = new THREE.Raycaster();

  function canSee(bot, point, colliders) {
    eye.set(bot.root.position.x, bot.root.position.y + EYE_HEIGHT, bot.root.position.z);
    toTarget.copy(point).sub(eye);
    const distance = toTarget.length();
    if (distance > BOT_RIFLE.range) return false;
    toTarget.divideScalar(distance);
    viewDir.set(-Math.sin(bot.yaw), 0, -Math.cos(bot.yaw));
    // A 110-degree cone: wide enough to notice a flank, narrow enough that a bot does not see
    // through its own back.
    if (viewDir.dot(new THREE.Vector3(toTarget.x, 0, toTarget.z).normalize()) < 0.35) return false;

    ray.set(eye, toTarget);
    ray.far = distance - 0.25;
    // The world's colliders are Box3 volumes, not meshes: a Box3 has no raycast() method, so asking
    // the raycaster to walk them throws. Box3.intersectsLine was removed in three r160, so the test
    // that survives is Ray.intersectsBox, which answers the only question that matters here — does
    // the map block this line of sight. A tiny epsilon on the near plane keeps a bot from blinding
    // itself on the crate it is standing beside.
    ray.near = 0.05;
    for (let index = 0; index < colliders.length; index += 1) {
      if (ray.ray.intersectsBox(colliders[index])) return false;
    }
    return true;
  }

  function chooseRoute(bot) {
    const lanes = ['A', 'B', 'C'];
    const lane = lanes[Math.floor(rnd() * lanes.length)];
    bot.route = world.routes[lane];
    const holds = world.holds[lane];
    bot.holdAt = holds[Math.floor(rnd() * holds.length)];
    bot.node = 0;
  }

  function reset(bot, spawn, time) {
    bot.health = HEALTH;
    bot.alive = true;
    bot.root.visible = true;
    bot.root.position.copy(spawn);
    bot.root.rotation.set(0, 0, 0);
    bot.rig.rotation.set(0, 0, 0);
    bot.yaw = bot.team === 'atk' ? 0 : Math.PI;
    bot.pitch = 0;
    bot.velocity.set(0, 0, 0);
    bot.mag = BOT_RIFLE.mag;
    bot.cooldown = 0;
    bot.reloadLeft = 0;
    bot.burst = 0;
    bot.burstPause = 0;
    bot.alertTimer = 0;
    bot.target = null;
    bot.hasHeard = false;
    bot.holdTimer = 0;
    bot.respawnAt = 0;
    bot.lastUpdate = time;
    bot.root.rotation.y = bot.yaw;
  }

  function damage(bot, amount) {
    if (!bot.alive) return false;
    bot.health -= amount;
    // Being hit is by itself information: the bot turns toward the shooter even if it cannot see
    // them, which is what makes a suppressed fight feel different from a loud one.
    bot.alertTimer = Math.max(bot.alertTimer, 2.4);
    if (bot.health > 0) return false;
    bot.alive = false;
    bot.root.visible = false;
    bot.target = null;
    return true;
  }

  // Hearing: a shot or a footstep within range puts a position in the bot's ears. It does not tell
  // the bot exactly where a shooter is, only roughly, which is why a bot investigates an area.
  function hear(bot, position, radius) {
    if (!bot.alive) return;
    const distance = bot.root.position.distanceTo(position);
    if (distance > radius || distance < 0.001) return;
    const error = distance * 0.18;
    bot.heardPos.set(
      position.x + (rnd() * 2 - 1) * error,
      position.y,
      position.z + (rnd() * 2 - 1) * error,
    );
    bot.hasHeard = true;
    bot.alertTimer = Math.max(bot.alertTimer, ALERT_MEMORY * 0.6);
  }

  function aimAt(bot, point, dt) {
    const dx = point.x - bot.root.position.x;
    const dz = point.z - bot.root.position.z;
    const dy = point.y - (bot.root.position.y + EYE_HEIGHT);
    const wantedYaw = Math.atan2(-dx, -dz);
    let delta = wantedYaw - bot.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const maxTurn = TURN_RATE * dt;
    bot.yaw += Math.max(-maxTurn, Math.min(maxTurn, delta));
    const wantedPitch = Math.atan2(dy, Math.hypot(dx, dz));
    bot.pitch += (wantedPitch - bot.pitch) * Math.min(1, dt * 8);
  }

  // Moving a bot is the same one-axis-at-a-time test the player uses, minus gravity: the yard is
  // flat apart from the platform, and a bot that walks a lane never needs to climb it.
  function moveToward(bot, point, dt, speed, colliders) {
    const dx = point.x - bot.root.position.x;
    const dz = point.z - bot.root.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.001) return 0;
    const nx = dx / distance;
    const nz = dz / distance;
    const stride = Math.min(speed * dt, distance);

    const nextX = bot.root.position.x + nx * stride;
    if (!blocked(nextX, bot.root.position.z, colliders)) bot.root.position.x = nextX;
    const nextZ = bot.root.position.z + nz * stride;
    if (!blocked(bot.root.position.x, nextZ, colliders)) bot.root.position.z = nextZ;

    bot.walkPhase += stride * 5.4;
    // A step cycle so a moving bot is not a sliding statue.
    const swing = Math.sin(bot.walkPhase) * 0.6;
    bot.legL.rotation.x = swing;
    bot.legR.rotation.x = -swing;
    return distance - stride;
  }

  const probe = new THREE.Box3();
  function blocked(x, z, colliders) {
    probe.min.set(x - 0.32, 0.35, z - 0.32);
    probe.max.set(x + 0.32, 1.6, z + 0.32);
    for (let index = 0; index < colliders.length; index += 1) {
      if (probe.intersectsBox(colliders[index])) return true;
    }
    return false;
  }

  // The squad's own view of a body: bots share contacts, so a bot that sees the player warns the
  // rest of its team. That is what makes a push look coordinated rather than five blind walkers.
  const contacts = { player: null, playerVisible: false, playerPos: new THREE.Vector3() };

  function step(dt, time, ctx) {
    const colliders = ctx.colliders;
    contacts.playerVisible = false;

    for (const bot of bots) {
      if (!bot.alive) continue;
      bot.cooldown = Math.max(0, bot.cooldown - dt);
      bot.alertTimer = Math.max(0, bot.alertTimer - dt);
      if (bot.reloadLeft > 0) {
        bot.reloadLeft = Math.max(0, bot.reloadLeft - dt);
        if (bot.reloadLeft === 0) bot.mag = BOT_RIFLE.mag;
      }

      // ---- perception -----------------------------------------------------------------
      const playerAlive = ctx.player.alive;
      const playerPoint = eye.set(ctx.player.position.x, ctx.player.position.y + 1.3, ctx.player.position.z).clone();
      let seesPlayer = false;
      if (playerAlive && bot.team !== 'def' || (playerAlive && bot.team === 'def')) {
        seesPlayer = canSee(bot, playerPoint, colliders);
      }
      // A teammate's contact is a contact: the first bot to see the player tells the squad.
      if (ctx.squadContact) {
        contacts.playerVisible = true;
        contacts.playerPos.copy(ctx.squadContact);
        if (bot.team === 'atk' && !seesPlayer && bot.root.position.distanceTo(ctx.squadContact) < 26) {
          seesPlayer = true;
          contacts.playerPos.copy(ctx.squadContact);
        }
      }
      if (seesPlayer) {
        bot.target = playerPoint;
        bot.alertTimer = ALERT_MEMORY;
        bot.lastSeenPos.copy(playerPoint);
        contacts.playerVisible = true;
        contacts.playerPos.copy(playerPoint);
      } else if (bot.target && bot.alertTimer <= 0) {
        bot.target = null;
      }

      // ---- decide ---------------------------------------------------------------------
      const hasTarget = bot.target !== null && bot.alertTimer > 0;
      const distanceToPlayer = bot.root.position.distanceTo(ctx.player.position);

      if (hasTarget) {
        const point = bot.target;
        aimAt(bot, point, dt);
        // Fire only inside range with a round in the magazine and its cadence ready, and hold a
        // burst: three or four rounds, then a beat to settle. That pause is what lets a human
        // trade shots instead of being deleted.
        if (bot.cooldown === 0 && bot.reloadLeft === 0 && bot.mag > 0 && distanceToPlayer < BOT_RIFLE.range) {
          if (bot.burstPause > 0) {
            bot.burstPause -= dt;
          } else {
            ctx.onBotFire(bot, point);
            bot.mag -= 1;
            bot.cooldown = BOT_RIFLE.fireGap;
            bot.burst += 1;
            if (bot.burst >= 4) {
              bot.burst = 0;
              bot.burstPause = 0.28 + rnd() * 0.3;
            }
          }
        }
        if (bot.mag === 0 && bot.reloadLeft === 0) bot.reloadLeft = BOT_RIFLE.reloadTime;
        // Strafe a step while shooting so two bots never stand in the same line.
        if (distanceToPlayer < 30) {
          const side = (bot.index % 2 === 0 ? 1 : -1) * 0.7;
          const nextX = bot.root.position.x + Math.cos(bot.yaw) * side * dt;
          const nextZ = bot.root.position.z - Math.sin(bot.yaw) * side * dt;
          if (!blocked(nextX, nextZ, colliders)) {
            bot.root.position.x = nextX;
            bot.root.position.z = nextZ;
          }
        }
      } else {
        // ---- route ---------------------------------------------------------------------
        let goal = null;
        if (bot.hasHeard) {
          goal = bot.heardPos;
        } else if (bot.holdTimer > 0) {
          bot.holdTimer -= dt;
          goal = null;
          // Holding an angle: sweep the lane rather than stare at one point.
          bot.yaw += Math.sin(time * 0.7 + bot.index) * dt * 0.35;
          if (bot.holdTimer <= 0) bot.hasHeard = false;
        } else if (bot.route) {
          const node = bot.route[bot.node];
          goal = node;
          if (bot.root.position.distanceTo(node) < ARRIVE) {
            bot.node += 1;
            if (bot.node >= bot.route.length) {
              // Route finished: take the angle and watch it, then re-route.
              bot.node = 0;
              bot.holdTimer = 5.5 + rnd() * 3.5;
              if (bot.holdAt) {
                bot.yaw = Math.atan2(
                  -(bot.holdAt.x - bot.root.position.x),
                  -(bot.holdAt.z - bot.root.position.z),
                );
              }
            }
          }
        }
        if (goal) {
          const remaining = moveToward(bot, goal, dt, SPEED, colliders);
          // Face the walk direction while moving.
          const dx = goal.x - bot.root.position.x;
          const dz = goal.z - bot.root.position.z;
          if (Math.hypot(dx, dz) > 0.4) {
            const wanted = Math.atan2(-dx, -dz);
            let delta = wanted - bot.yaw;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            bot.yaw += Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, delta));
          }
          if (remaining === 0) bot.hasHeard = false;
        }
      }

      // Keep inside the yard even if a waypoint is odd.
      bot.root.position.x = Math.max(world.bounds.minX, Math.min(world.bounds.maxX, bot.root.position.x));
      bot.root.position.z = Math.max(world.bounds.minZ, Math.min(world.bounds.maxZ, bot.root.position.z));
      bot.root.rotation.y = bot.yaw;
      bot.rig.rotation.x = bot.pitch * 0.35;
      // Settle the legs when the bot is not walking.
      if (!hasTarget) {
        bot.legL.rotation.x *= 0.85;
        bot.legR.rotation.x *= 0.85;
      }
    }
  }

  function alive() {
    let count = 0;
    for (const bot of bots) if (bot.alive) count += 1;
    return count;
  }

  function respawnAll(time) {
    let attackerIndex = 0;
    let defenderIndex = 0;
    for (const bot of bots) {
      if (bot.team === 'atk') {
        reset(bot, world.attackerSpawns[attackerIndex % world.attackerSpawns.length], time);
        attackerIndex += 1;
      } else {
        reset(bot, world.defenderSpawns[defenderIndex % world.defenderSpawns.length], time);
        defenderIndex += 1;
      }
      chooseRoute(bot);
    }
  }

  function spawnSquad(team, count) {
    const spawns = team === 'atk' ? world.attackerSpawns : world.defenderSpawns;
    for (let index = 0; index < count; index += 1) build(team, index, spawns[index % spawns.length]);
  }

  return {
    bots,
    hitMeshes,
    contacts,
    spawnSquad,
    respawnAll,
    step,
    damage,
    hear,
    alive,
    canSee,
    BOT_RIFLE,
  };
}
