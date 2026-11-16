// Player movement: acceleration, friction, gravity, crouch and jump, resolved as a box against
// the world's colliders one axis at a time, so a wall never swallows the player. The numbers are
// tuned so that stopping to aim is worth it: ground acceleration is high enough to strafe a
// corner, friction is high enough to stop inside one stride, and air control is deliberately
// weak so a jumping player is a worse shot than a standing one.
import * as THREE from 'three';

const RADIUS = 0.34;
const STAND_HEIGHT = 1.72;
const CROUCH_HEIGHT = 1.12;
const STAND_EYE = 1.62;
const CROUCH_EYE = 1.04;
const WALK_SPEED = 5.4;
const CROUCH_SPEED = 2.3;
const GROUND_ACCEL = 46;
const AIR_ACCEL = 8;
const FRICTION = 11;
const GRAVITY = 20;
const JUMP_SPEED = 6.0;
const STEP_UP = 0.42;

export function createBody(colliders, spawn) {
  const body = {
    position: spawn ? spawn.clone() : new THREE.Vector3(0, 0, 0),
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    eye: STAND_EYE,
    onGround: true,
    crouching: false,
    height: STAND_HEIGHT,
    // The last frame's horizontal speed, read by the weapon spread: firing while moving costs
    // accuracy, so main.js asks the body rather than guessing from input.
    groundSpeed: 0,
  };

  const probe = new THREE.Box3();
  const wish = new THREE.Vector3();

  // lift keeps the feet and the crown out of the horizontal tests, so standing on the floor is
  // not read as walking into a wall.
  function overlaps(x, y, z, height, lift) {
    probe.min.set(x - RADIUS, y + lift, z - RADIUS);
    probe.max.set(x + RADIUS, y + height - lift, z + RADIUS);
    for (let index = 0; index < colliders.length; index += 1) {
      const collider = colliders[index];
      if (probe.intersectsBox(collider)) return collider;
    }
    return null;
  }

  function setCrouch(wantCrouch) {
    if (wantCrouch && !body.crouching) {
      body.crouching = true;
      body.height = CROUCH_HEIGHT;
    } else if (!wantCrouch && body.crouching && !overlaps(body.position.x, body.position.y, body.position.z, STAND_HEIGHT, 0.02)) {
      body.crouching = false;
      body.height = STAND_HEIGHT;
    }
  }

  // Walking up a step is a lift, not a jump: if the only thing blocking the move is a face lower
  // than STEP_UP, the feet rise onto it. Without this the platform stairs are unscalable.
  function tryStep(x, z) {
    const lift = body.position.y + STEP_UP;
    if (!overlaps(x, lift, z, body.height, 0.04)) {
      const below = overlaps(x, lift - STEP_UP, z, body.height, 0.04);
      if (!below) return false;
      body.position.y = lift - 0.04;
      return true;
    }
    return false;
  }

  function step(dt, keys) {
    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    wish.set(0, 0, 0);
    if (forward || strafe) {
      const sin = Math.sin(body.yaw);
      const cos = Math.cos(body.yaw);
      wish.set(-sin * forward + cos * strafe, 0, -cos * forward - sin * strafe);
      if (wish.lengthSq() > 0) wish.normalize();
    }

    const speed = body.crouching ? CROUCH_SPEED : WALK_SPEED;
    const accel = body.onGround ? GROUND_ACCEL : AIR_ACCEL;
    const blend = Math.min(1, accel * dt / speed);
    body.velocity.x += (wish.x * speed - body.velocity.x) * blend;
    body.velocity.z += (wish.z * speed - body.velocity.z) * blend;
    if (body.onGround && !wish.lengthSq()) {
      const damp = Math.max(0, 1 - FRICTION * dt);
      body.velocity.x *= damp;
      body.velocity.z *= damp;
    }

    if (keys.has('Space') && body.onGround) {
      body.velocity.y = JUMP_SPEED;
      body.onGround = false;
    }
    body.velocity.y -= GRAVITY * dt;

    const standing = overlaps(body.position.x, body.position.y, body.position.z, body.height, 0.04);
    // One axis at a time: a blocked X leaves Z free, so a wall is slid along instead of stuck on.
    const nextX = body.position.x + body.velocity.x * dt;
    if (!overlaps(nextX, body.position.y, body.position.z, body.height, 0.04)) {
      body.position.x = nextX;
    } else if (!tryStep(nextX, body.position.z)) {
      body.velocity.x = 0;
    }
    const nextZ = body.position.z + body.velocity.z * dt;
    if (!overlaps(body.position.x, body.position.y, nextZ, body.height, 0.04)) {
      body.position.z = nextZ;
    } else if (!tryStep(body.position.x, nextZ)) {
      body.velocity.z = 0;
    }

    body.position.y += body.velocity.y * dt;
    body.onGround = false;
    const hit = overlaps(body.position.x, body.position.y, body.position.z, body.height, 0);
    if (hit && body.velocity.y <= 0) {
      body.position.y = hit.max.y;
      body.velocity.y = 0;
      body.onGround = true;
    } else if (hit && body.velocity.y > 0) {
      body.position.y = hit.min.y - body.height;
      body.velocity.y = 0;
    }
    if (!hit && !standing && body.position.y < -8) {
      // A body that leaves the map is put back on its feet rather than falling forever.
      body.position.copy(spawn);
      body.velocity.set(0, 0, 0);
    }

    const eyeTarget = body.crouching ? CROUCH_EYE : STAND_EYE;
    body.eye += (eyeTarget - body.eye) * Math.min(1, dt * 14);
    body.groundSpeed = Math.hypot(body.velocity.x, body.velocity.z);
  }

  function look(dx, dy, sensitivity = 0.0022) {
    body.yaw -= dx * sensitivity;
    body.pitch = Math.max(-1.45, Math.min(1.45, body.pitch - dy * sensitivity));
  }

  function recoil(pitchKick, yawKick) {
    body.pitch = Math.min(1.45, body.pitch + pitchKick);
    body.yaw += yawKick;
  }

  function syncCamera(camera) {
    camera.position.set(body.position.x, body.position.y + body.eye, body.position.z);
    camera.rotation.set(body.pitch, body.yaw, 0, 'YXZ');
  }

  return { state: body, step, look, recoil, setCrouch, syncCamera, overlaps };
}
