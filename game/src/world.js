// The map: an original dock-side freight yard in three lanes, built from boxes and thin slabs.
// Every solid box is a collider for the player and a surface a bullet stops on, so the geometry
// the eye reads is exactly the geometry the simulation collides with. Plain geometry only: no
// models, no textures, no network assets.
//
// Layout, seen from above (the defending crew spawns +Z, the attackers -Z):
//
//        -Z  attacker spawn
//   ┌──────────────────────────────┐
//   │  warehouse      yard     shed │   long-left lane (A)
//   │  ─────────────────────────    │
//   │        containers (mid)       │   contested middle (B) with the site
//   │  ─────────────────────────    │
//   │  dock           crates   tower │   long-right lane (C)
//   └──────────────────────────────┘
//        +Z  defender spawn
//
// Three lanes, three connectors, and one raised platform that overlooks the site, so a route
// can be held from cover, flanked through the connectors, or contested at range down a lane.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const MATERIAL_SPECS = {
  canvas: { roughness: 0.96, metalness: 0.02 },
  surface: { roughness: 0.88, metalness: 0.05 },
  hairline: { roughness: 0.8, metalness: 0.12 },
  ink: { roughness: 0.55, metalness: 0.25 },
  muted: { roughness: 0.9, metalness: 0.04 },
  accent: { roughness: 0.6, metalness: 0.1 },
  teamDef: { roughness: 0.72, metalness: 0.1 },
  teamAtk: { roughness: 0.72, metalness: 0.1 },
  objective: { roughness: 0.5, metalness: 0.15, emissiveIntensity: 0.55 },
};

export function createWorld(scene) {
  const group = new THREE.Group();
  group.name = 'yard';
  scene.add(group);

  // Materials are built once and shared by every box, so a map this size costs one material per
  // palette entry rather than one per mesh.
  const materials = {};
  for (const name of Object.keys(PALETTE)) {
    if (name === 'teamDef' || name === 'teamAtk' || name === 'objective') continue;
    materials[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[name]),
      ...MATERIAL_SPECS[name],
    });
  }

  const colliders = [];
  const shootables = [];
  // Reusable scratch box: setFromObject writes into it, then a clone is kept, so a map of a few
  // hundred boxes allocates a few hundred Box3s during construction and none afterwards.
  const scratch = new THREE.Box3();

  function solid(width, height, depth, x, y, z, material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), materials[material]);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    scratch.setFromObject(mesh);
    colliders.push(scratch.clone());
    shootables.push(mesh);
    return mesh;
  }

  // A slab is a collider a player can walk under only if it floats; these all sit on the floor or
  // on a wall, so they are ordinary solids that happen to be thin.
  function slab(width, height, depth, x, y, z, material) {
    return solid(width, height, depth, x, y, z, material);
  }

  // ---- floor and perimeter ----------------------------------------------------------------
  // 46 x 40 m of yard: long enough that a lane is a real sightline, narrow enough that a wall
  // never eats the player. Walls are 5.2 m so a raised platform still has a backdrop.
  solid(46.4, 0.4, 40.4, 0, -0.2, 0, 'canvas');
  // Walls are 3.4 m: tall enough to be real cover, low enough that a level camera at eye height still
  // catches the sky above them. At 5.2 m the perimeter filled the entire frustum and every capture
  // measured near-black across the top third — the yard read as a sealed box, not an outdoor yard.
  solid(0.6, 3.4, 40.4, -23, 1.7, 0, 'surface');
  solid(0.6, 3.4, 40.4, 23, 1.7, 0, 'surface');
  solid(46.4, 3.4, 0.6, 0, 1.7, -20, 'surface');
  solid(46.4, 3.4, 0.6, 0, 1.7, 20, 'surface');

  // ---- left lane (A): the warehouse run -----------------------------------------------
  // A long warehouse wall makes the lane one-sided cover: the attacker pushes up against it, the
  // defender holds from the far corner where the wall ends.
  solid(1.2, 4.4, 22.0, -19.4, 2.2, -3.0, 'surface');
  solid(9.0, 0.55, 1.2, -14.0, 0.28, 8.0, 'hairline'); // low cover across the lane mouth
  solid(1.4, 1.9, 1.4, -12.6, 0.95, 1.4, 'hairline'); // stack a crouch can beat
  solid(1.4, 1.1, 1.4, -12.6, 0.55, 3.2, 'hairline');
  solid(2.6, 3.0, 1.4, -16.4, 1.5, -13.6, 'surface'); // a shed at the attacker's end
  solid(1.0, 1.0, 3.0, -8.4, 0.5, -16.0, 'hairline');

  // ---- right lane (C): the dock -------------------------------------------------------
  solid(1.2, 3.4, 20.0, 19.4, 1.7, 2.0, 'surface');
  solid(2.0, 1.2, 2.0, 14.6, 0.6, -6.0, 'hairline'); // loading crates
  solid(2.0, 0.9, 2.0, 16.8, 0.45, -6.0, 'hairline');
  solid(2.0, 1.6, 2.0, 16.8, 0.8, -8.6, 'hairline');
  solid(1.2, 2.2, 1.2, 11.8, 1.1, 6.4, 'surface'); // corner post the defender peeks around
  solid(6.0, 0.5, 1.2, 15.0, 0.25, 11.0, 'hairline');

  // ---- middle (B): containers on the site line ----------------------------------------
  // Two offset container rows split the middle into a near side and a far side, with a gap on
  // the left that a rotator has to cross in the open. The site sits between them.
  solid(7.0, 2.6, 2.4, -4.0, 1.3, -2.0, 'hairline');
  solid(6.0, 2.6, 2.4, 5.0, 1.3, 2.0, 'hairline');
  solid(2.4, 2.6, 6.0, -10.2, 1.3, -8.4, 'hairline');
  solid(2.4, 2.6, 6.0, 10.2, 1.3, 8.4, 'hairline');
  solid(3.2, 1.1, 3.2, 0.0, 0.55, -6.4, 'surface'); // low crate the planter can crouch behind

  // ---- the raised platform that overlooks the site ------------------------------------
  // A defend-side perch: stairs are three steps, each its own collider, and the deck is wide
  // enough to hold a rifle angle down the middle without being safe from the left lane.
  solid(6.0, 0.5, 4.0, 0, 0.25, 14.0, 'surface');
  solid(5.4, 0.5, 0.6, 0, 0.25, 12.1, 'surface');
  solid(4.2, 0.5, 0.6, 0, 0.25, 11.6, 'surface');
  solid(3.0, 0.5, 0.6, 0, 0.25, 11.1, 'surface');
  solid(0.4, 1.6, 4.0, -2.8, 0.8, 14.0, 'hairline');
  solid(0.4, 1.6, 4.0, 2.8, 0.8, 14.0, 'hairline');

  // ---- connectors ---------------------------------------------------------------------
  // Doorways between lanes, so a route can be flanked instead of only held head-on.
  solid(1.0, 2.8, 1.0, -10.4, 1.4, 10.6, 'surface');
  solid(1.0, 2.8, 1.0, 10.4, 1.4, -10.6, 'surface');
  solid(1.0, 2.8, 1.0, -6.2, 1.4, 16.8, 'surface');
  solid(1.0, 2.8, 1.0, 6.2, 1.4, -16.8, 'surface');

  // ---- lighting -----------------------------------------------------------------------
  // Dusk: a cold hemisphere for ambient bounce, one warm low sun for long readable shadows, and
  // two cool fills so the far lanes never fall to flat black.
  const hemi = new THREE.HemisphereLight(new THREE.Color(PALETTE.surface), new THREE.Color(PALETTE.canvas), 1.15);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(new THREE.Color(PALETTE.accent), 2.35);
  sun.position.set(16, 15, 12);
  sun.target.position.set(0, 0, -2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -26;
  sun.shadow.camera.right = 26;
  sun.shadow.camera.top = 26;
  sun.shadow.camera.bottom = -26;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 64;
  sun.shadow.bias = -0.0007;
  scene.add(sun, sun.target);

  const fillLeft = new THREE.DirectionalLight(new THREE.Color(PALETTE.teamDef), 0.75);
  fillLeft.position.set(-18, 9, -14);
  scene.add(fillLeft);

  const fillRight = new THREE.DirectionalLight(new THREE.Color(PALETTE.muted), 0.5);
  fillRight.position.set(8, 6, 20);
  scene.add(fillRight);

  // ---- spawns and routes --------------------------------------------------------------
  // Both crews hold a lane each and a connector between, so neither spawn is a shooting gallery.
  const attackerSpawns = [
    new THREE.Vector3(-15.0, 0, -16.4),
    new THREE.Vector3(-9.0, 0, -17.6),
    new THREE.Vector3(9.0, 0, -17.6),
    new THREE.Vector3(15.4, 0, -16.0),
  ];
  const defenderSpawns = [
    new THREE.Vector3(-14.6, 0, 16.2),
    new THREE.Vector3(-8.0, 0, 17.2),
    new THREE.Vector3(8.0, 0, 17.2),
    new THREE.Vector3(14.6, 0, 16.0),
  ];
  const playerSpawn = new THREE.Vector3(-2.2, 0, 17.4);

  // Route waypoints per lane. A bot picks a lane at spawn and walks its waypoints, which is what
  // makes a push read as a route rather than a bee-line at the player.
  const routes = {
    A: [
      new THREE.Vector3(-16.0, 0, -16.0),
      new THREE.Vector3(-16.4, 0, -8.0),
      new THREE.Vector3(-15.2, 0, 0.0),
      new THREE.Vector3(-14.6, 0, 6.0),
    ],
    B: [
      new THREE.Vector3(-2.0, 0, -15.0),
      new THREE.Vector3(-2.6, 0, -8.4),
      new THREE.Vector3(-1.2, 0, -3.0),
      new THREE.Vector3(0.0, 0, 3.0),
    ],
    C: [
      new THREE.Vector3(15.0, 0, -15.0),
      new THREE.Vector3(15.6, 0, -7.0),
      new THREE.Vector3(14.4, 0, 0.0),
      new THREE.Vector3(13.6, 0, 6.0),
    ],
  };

  // Angles worth holding: a bot that reaches one of these stops and watches its lane instead of
  // walking into the open forever.
  const holds = {
    A: [new THREE.Vector3(-13.4, 0, 2.4), new THREE.Vector3(-8.6, 0, 8.2)],
    B: [new THREE.Vector3(-2.2, 0, 10.0), new THREE.Vector3(2.6, 0, 12.0)],
    C: [new THREE.Vector3(12.4, 0, 4.6), new THREE.Vector3(8.8, 0, 9.6)],
  };

  // The bomb site sits in the middle lane, between the container rows: a planter has to hold it
  // long enough to finish the plant, and a defuser has to reach it while the lane is contested.
  const siteCenter = new THREE.Vector3(0, 0, 1.2);
  const siteRadius = 3.4;

  const siteRing = new THREE.Mesh(
    new THREE.RingGeometry(siteRadius - 0.28, siteRadius, 48),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.objective),
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  siteRing.rotation.x = -Math.PI / 2;
  siteRing.position.set(siteCenter.x, 0.02, siteCenter.z);
  siteRing.renderOrder = 2;
  group.add(siteRing);

  const sitePad = new THREE.Mesh(
    new THREE.CircleGeometry(siteRadius, 40),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE.objective),
      transparent: true,
      opacity: 0.06,
      roughness: 0.9,
      depthWrite: false,
    }),
  );
  sitePad.rotation.x = -Math.PI / 2;
  sitePad.position.set(siteCenter.x, 0.011, siteCenter.z);
  group.add(sitePad);

  // ---- horizon ---------------------------------------------------------------------------
  // Without this the upper half of every frame was a single flat colour: scene.background was one
  // value and the fog faded to the same value, so the sky and the far end of the yard were literally
  // the same pixel. Captures read as "half the screen is empty black". Three cheap layers fix it —
  // a gradient dome for the sky, a dark silhouette band for the horizon line, and a warm glow where
  // the sun sits — so distance reads as distance even at this poly budget.
  // A gradient dome built from a canvas texture rather than a custom shader. The shader version
  // rendered nothing measurable: the top third of every frame stayed at r=3 with no sky colour at all,
  // which pointed at the fragment program rather than the geometry. A CanvasTexture on a plain
  // MeshBasicMaterial has no shader to fail, and it is still one draw call.
  // A CanvasTexture kept coming back as a flat pale blue-grey (#93AABB) that appeared nowhere in the
  // gradient — the 2D canvas had not painted by the time the texture was uploaded, so the sampler got
  // undefined bytes. A DataTexture written by hand has no paint step and cannot race: the bytes are
  // final before the GPU ever sees them.
  const SKY_STOPS = [
    [0.000, [0x0d, 0x16, 0x22]],
    [0.220, [0x1b, 0x2b, 0x3d]],
    [0.400, [0x2f, 0x44, 0x59]],
    [0.520, [0x4a, 0x5b, 0x6b]],
    [0.600, [0x7d, 0x6a, 0x55]],
    [0.660, [0xb0, 0x7a, 0x45]],
    [0.700, [0xd4, 0x91, 0x4e]],
    [0.745, [0x8a, 0x5f, 0x3a]],
    [0.800, [0x3a, 0x2e, 0x24]],
    [1.000, [0x12, 0x0f, 0x0d]],
  ];
  const SKY_H = 256;
  const skyBytes = new Uint8Array(SKY_H * 4);
  for (let i = 0; i < SKY_H; i += 1) {
    // v runs 0 at the bottom of the texture to 1 at the top; SphereGeometry maps t=0 to the south
    // pole, so flip here to put the zenith colour at the top of the dome.
    const v = 1 - i / (SKY_H - 1);
    let a = SKY_STOPS[0];
    let b = SKY_STOPS[SKY_STOPS.length - 1];
    for (let s = 0; s < SKY_STOPS.length - 1; s += 1) {
      if (v >= SKY_STOPS[s][0] && v <= SKY_STOPS[s + 1][0]) {
        a = SKY_STOPS[s];
        b = SKY_STOPS[s + 1];
        break;
      }
    }
    const span = b[0] - a[0] || 1;
    const f = Math.min(1, Math.max(0, (v - a[0]) / span));
    for (let c = 0; c < 3; c += 1) {
      skyBytes[i * 4 + c] = Math.round(a[1][c] + (b[1][c] - a[1][c]) * f);
    }
    skyBytes[i * 4 + 3] = 255;
  }
  const skyTex = new THREE.DataTexture(skyBytes, 1, SKY_H, THREE.RGBAFormat);
  // Without this the bytes (13,22,34) are treated as LINEAR light. The renderer then runs them through
  // ACES filmic tone mapping and an sRGB encode, which lifts the shadows hard and lands the zenith at
  // roughly (141,165,183) on screen — a pale daytime blue instead of the dusk indigo that was written.
  // Declaring the texture as sRGB makes the colour chain honour the values as authored.
  skyTex.colorSpace = THREE.SRGBColorSpace;
  skyTex.magFilter = THREE.LinearFilter;
  skyTex.minFilter = THREE.LinearFilter;
  skyTex.wrapS = THREE.ClampToEdgeWrapping;
  skyTex.wrapT = THREE.ClampToEdgeWrapping;
  skyTex.needsUpdate = true;
  const skyGeo = new THREE.SphereGeometry(120, 32, 24);
  const skyMat = new THREE.MeshBasicMaterial({
    map: skyTex,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  group.add(sky);

  // A ring of distant container silhouettes just outside the playable walls. They never collide and
  // never cast, they exist only so the eye finds a horizon line instead of empty sky.
  const farGeo = new THREE.BoxGeometry(1, 1, 1);
  const farMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#0a0e14'), fog: false });
  const farBoxes = new THREE.InstancedMesh(farGeo, farMat, 96);
  const m4 = new THREE.Matrix4();
  const q0 = new THREE.Quaternion();
  let fi = 0;
  for (let ring = 0; ring < 2; ring++) {
    const radius = 46 + ring * 14;
    const count = 48;
    for (let i = 0; i < count && fi < 96; i++) {
      const a = (i / count) * Math.PI * 2 + ring * 0.07;
      const w = 7 + ((i * 37) % 11) * 1.4;
      const h = 5 + ((i * 53) % 9) * 1.6 + ring * 3;
      const d = 5;
      m4.compose(
        new THREE.Vector3(Math.cos(a) * radius, h / 2 - 0.6, Math.sin(a) * radius),
        q0.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a),
        new THREE.Vector3(w, h, d),
      );
      farBoxes.setMatrixAt(fi++, m4);
    }
  }
  farBoxes.instanceMatrix.needsUpdate = true;
  farBoxes.frustumCulled = false;
  farBoxes.renderOrder = -50;
  group.add(farBoxes);

  // Bounds the bots stay inside, so a stray waypoint never pushes one through a wall.
  const bounds = { minX: -21.6, maxX: 21.6, minZ: -18.6, maxZ: 18.6 };

  return {
    group,
    colliders,
    shootables,
    attackerSpawns,
    defenderSpawns,
    playerSpawn,
    routes,
    holds,
    siteCenter,
    siteRadius,
    siteRing,
    bounds,
    sun,
  };
}
