// The round machine: buy phase, live round, a planted bomb with a fuse, a defuse, a win by
// elimination, money between rounds and a match that ends at a score limit. It owns every rule
// and the money; main.js owns the camera, the weapon and the bullets, and calls into this.
//
// The state is one object with a phase field rather than a set of booleans, so "what is true now"
// is a single read and a screenshot can force a phase without lying about the rest.
import * as THREE from 'three';
import { ECONOMY, WEAPONS, ARMOR, GRENADES } from './weapons.js';

export const PHASE = {
  BUY: 'buy',
  LIVE: 'live',
  PLANTED: 'planted',
  ROUND_OVER: 'roundOver',
  MATCH_OVER: 'matchOver',
};

const BUY_SECONDS = 16;
const ROUND_SECONDS = 105;
const ROUND_OVER_SECONDS = 4.5;
const PLANT_SECONDS = 3.4;
const DEFUSE_SECONDS = 7.0;
const BOMB_FUSE = 40;
const SCORE_LIMIT = 5;
const ROUNDS_PER_HALF = 6;

export function createMatch(world) {
  const state = {
    phase: PHASE.BUY,
    phaseTime: BUY_SECONDS,
    round: 1,
    scoreAtk: 0,
    scoreDef: 0,
    money: ECONOMY.start,
    twoPrev: 0,
    onePrev: 0,
    // Bomb
    bombCarried: true,
    bombPlanted: false,
    bombTimer: 0,
    plantProgress: 0,
    defuseProgress: 0,
    defusing: false,
    plantZone: false,
    // Round outcome, for the HUD and the summary.
    lastWinner: null,
    lastReason: '',
    roundLog: [],
    half: 1,
  };

  // The bomb's own little body: a box that appears on the site once it is planted.
  const bombMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.2, 0.26),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#c8412c'),
      roughness: 0.6,
      emissive: new THREE.Color('#8a1f10'),
      emissiveIntensity: 0.7,
    }),
  );
  bombMesh.castShadow = true;
  bombMesh.visible = false;
  world.group.add(bombMesh);

  const blinkLight = new THREE.PointLight(new THREE.Color('#ff3b1f'), 0, 6, 2);
  blinkLight.position.set(world.siteCenter.x, 0.5, world.siteCenter.z);
  world.group.add(blinkLight);

  function plantingAllowed(playerPos) {
    const dx = playerPos.x - world.siteCenter.x;
    const dz = playerPos.z - world.siteCenter.z;
    return Math.hypot(dx, dz) < world.siteRadius;
  }

  function awardRound(winner, reason) {
    if (winner === 'atk') state.scoreAtk += 1;
    else state.scoreDef += 1;
    state.lastWinner = winner;
    state.lastReason = reason;
    state.roundLog.push({ round: state.round, winner, reason });
    state.phase = PHASE.ROUND_OVER;
    state.phaseTime = ROUND_OVER_SECONDS;
  }

  // Money follows the classic ladder: a win pays most, a losing streak pays a little more each
  // round so a side is never out of the game for good, and a lost bomb round still pays its plant.
  // The human plays a defender in this build, so 'def' is the player's crew.
  function payRound(winner) {
    if (winner === 'def') {
      state.money += state.plantedByPlayer ? ECONOMY.winObjective : ECONOMY.winElimination;
      state.lossStreak = 0;
    } else {
      const streak = Math.min(ECONOMY.lossStreakMax, state.lossStreak);
      state.money += ECONOMY.loss + streak * ECONOMY.lossStreakBonus;
      state.lossStreak = streak + 1;
      // A plant that still lost is paid: the plant is a real piece of work in this economy.
      if (state.plantedByPlayer) state.money += ECONOMY.plantBonus;
    }
    state.money = Math.max(0, Math.min(ECONOMY.max, state.money));
  }

  // The counters the round logic needs beyond the player's own: how many of each side are left.
  state.lossStreak = 0;
  state.plantedByPlayer = false;

  function endRound(winner, reason) {
    if (state.phase === PHASE.ROUND_OVER || state.phase === PHASE.MATCH_OVER) return;
    payRound(winner);
    state.twoPrev = state.onePrev;
    state.onePrev = winner;
    awardRound(winner, reason);
    bombMesh.visible = false;
    blinkLight.intensity = 0;
    state.bombPlanted = false;
    state.plantProgress = 0;
    state.defuseProgress = 0;
    state.defusing = false;
    state.plantedByPlayer = false;
  }

  function nextRound() {
    state.round += 1;
    state.phase = PHASE.BUY;
    state.phaseTime = BUY_SECONDS;
    state.bombCarried = true;
    state.bombPlanted = false;
    state.bombTimer = 0;
    state.plantProgress = 0;
    state.defuseProgress = 0;
    state.defusing = false;
    state.lastWinner = null;
    state.lastReason = '';
    if (state.round > ROUNDS_PER_HALF && state.half === 1) {
      // Half time swaps sides and resets money, as a match of two sixes does.
      state.half = 2;
      state.money = ECONOMY.start;
      state.lossStreak = 0;
      const swap = state.scoreAtk;
      state.scoreAtk = state.scoreDef;
      state.scoreDef = swap;
    }
  }

  function checkMatchOver() {
    if (state.scoreAtk >= SCORE_LIMIT || state.scoreDef >= SCORE_LIMIT) {
      state.phase = PHASE.MATCH_OVER;
      state.phaseTime = 0;
      return true;
    }
    return false;
  }

  // One fixed step of the round clock and every rule that depends on it. ctx carries the live
  // world: player body, squad counts, and the callbacks the round needs to fire.
  function step(dt, ctx) {
    if (state.phase === PHASE.ROUND_OVER) {
      state.phaseTime -= dt;
      if (state.phaseTime <= 0) {
        if (checkMatchOver()) return;
        nextRound();
        ctx.onNextRound();
      }
      return;
    }
    if (state.phase === PHASE.MATCH_OVER) return;

    if (state.phase === PHASE.BUY) {
      state.phaseTime -= dt;
      if (state.phaseTime <= 0) {
        state.phase = PHASE.LIVE;
        state.phaseTime = ROUND_SECONDS;
        ctx.onRoundStart();
      }
      return;
    }

    if (state.phase === PHASE.LIVE || state.phase === PHASE.PLANTED) {
      if (state.phase === PHASE.LIVE) {
        state.phaseTime -= dt;
        state.plantZone = plantingAllowed(ctx.player.position);
      } else {
        state.bombTimer -= dt;
        blinkLight.intensity = state.bombTimer % 0.8 < 0.4 ? 4 : 0;
        if (state.bombTimer <= 0) {
          endRound('atk', 'The bomb detonated.');
          ctx.onBombExplode();
          return;
        }
        // A defuse pauses if the defuser lets go or dies.
        if (state.defusing && ctx.player.alive && ctx.player.position.distanceTo(bombMesh.position) < 2.4) {
          state.defuseProgress += dt;
          if (state.defuseProgress >= DEFUSE_SECONDS) {
            endRound('def', 'Bomb defused.');
            ctx.onDefused();
            return;
          }
        } else {
          state.defusing = false;
          state.defuseProgress = Math.max(0, state.defuseProgress - dt * 1.5);
        }
      }
    }

    if (state.phase === PHASE.LIVE && state.phaseTime <= 0) {
      endRound('def', 'Time expired: the site was held.');
      return;
    }

    // Elimination ends a round from either side: the human counts as one of the defenders, so the
    // defending crew is left when the player or any bot is still standing.
    if (ctx.attackersLeft === 0) {
      endRound('def', 'Attackers eliminated.');
      return;
    }
    if (!ctx.player.alive && ctx.defendersLeft === 0) {
      endRound('atk', 'Defenders eliminated.');
    }
  }

  function tryPlant(dt, playerPos) {
    if (state.phase !== PHASE.LIVE) return false;
    if (!state.bombCarried || !plantingAllowed(playerPos)) return false;
    state.plantProgress += dt;
    if (state.plantProgress >= PLANT_SECONDS) {
      state.bombCarried = false;
      state.bombPlanted = true;
      state.plantedByPlayer = true;
      state.phase = PHASE.PLANTED;
      state.bombTimer = BOMB_FUSE;
      state.plantProgress = PLANT_SECONDS;
      bombMesh.position.set(playerPos.x, 0.1, playerPos.z);
      bombMesh.visible = true;
      blinkLight.position.copy(bombMesh.position);
      blinkLight.position.y = 0.5;
      return true;
    }
    return false;
  }

  function cancelPlant() {
    state.plantProgress = Math.max(0, state.plantProgress - 0.06);
  }

  function buy(what) {
    if (state.phase !== PHASE.BUY) return { ok: false, why: 'The buy menu is closed.' };
    if (what === 'armor') {
      if (state.armor >= 100) return { ok: false, why: 'Kevlar already worn.' };
      if (state.money < ARMOR.price) return { ok: false, why: 'Not enough money.' };
      state.money -= ARMOR.price;
      state.armor = 100;
      return { ok: true, why: 'Kevlar worn.' };
    }
    const weapon = WEAPONS[what];
    if (weapon) {
      if (state.money < weapon.price) return { ok: false, why: 'Not enough money.' };
      state.money -= weapon.price;
      return { ok: true, why: `${weapon.name} bought.` };
    }
    const grenade = GRENADES[what];
    if (grenade) {
      if (state.money < grenade.price) return { ok: false, why: 'Not enough money.' };
      state.money -= grenade.price;
      return { ok: true, why: `${grenade.name} bought.` };
    }
    return { ok: false, why: 'Unknown item.' };
  }

  function addMoney(amount) {
    state.money = Math.max(0, Math.min(ECONOMY.max, state.money + amount));
  }

  function reset() {
    state.phase = PHASE.BUY;
    state.phaseTime = BUY_SECONDS;
    state.round = 1;
    state.half = 1;
    state.scoreAtk = 0;
    state.scoreDef = 0;
    state.money = ECONOMY.start;
    state.lossStreak = 0;
    state.twoPrev = 0;
    state.onePrev = 0;
    state.bombCarried = true;
    state.bombPlanted = false;
    state.bombTimer = 0;
    state.plantProgress = 0;
    state.defuseProgress = 0;
    state.defusing = false;
    state.plantedByPlayer = false;
    state.lastWinner = null;
    state.lastReason = '';
    state.roundLog.length = 0;
    bombMesh.visible = false;
    blinkLight.intensity = 0;
  }

  return {
    state,
    step,
    buy,
    tryPlant,
    cancelPlant,
    endRound,
    addMoney,
    reset,
    setDefusing(value) {
      state.defusing = value;
    },
    bombMesh,
    PHASE,
    BUY_SECONDS,
    ROUND_SECONDS,
    PLANT_SECONDS,
    DEFUSE_SECONDS,
    BOMB_FUSE,
    SCORE_LIMIT,
  };
}
