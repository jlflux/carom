// ai.js
// A pure shot-planning AI for the pool game. It has no dependency on the DOM
// or the renderer, so it can be unit-tested directly against the physics
// engine in Node.
//
// The planner uses the classic "ghost ball" method: to send an object ball
// toward a pocket, the cue ball must arrive at the ghost position — one ball
// diameter behind the object ball, on the line from the pocket through it.
// It scores every (target ball, pocket) pair for angle and clear paths, plays
// the best pot it can find, and otherwise falls back to a safe contact shot.

import { TABLE, POCKETS } from './physics.js';

const { HX, HZ, R } = TABLE;
const D = 2 * R;               // contact distance between two ball centers
const CLEAR = 2 * R * 0.98;    // a path is blocked if it passes this close to a ball

function groupIds(group) {
  if (group === 'solid') return [1, 2, 3, 4, 5, 6, 7];
  if (group === 'stripe') return [9, 10, 11, 12, 13, 14, 15];
  return [];
}

// Distance from point (px,pz) to the segment (ax,az)->(bx,bz).
function segDist(ax, az, bx, bz, px, pz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cz = az + t * dz;
  return Math.hypot(px - cx, pz - cz);
}

// Is the straight path from A to B clear of every ball except `ignore`?
function pathClear(balls, ax, az, bx, bz, ignore) {
  for (const b of balls) {
    if (!b.active || ignore.includes(b.id)) continue;
    if (segDist(ax, az, bx, bz, b.x, b.z) < CLEAR) return false;
  }
  return true;
}

function unit(x, z) {
  const m = Math.hypot(x, z) || 1;
  return { x: x / m, z: z / m };
}
function rotate(d, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return { x: d.x * c - d.z * s, z: d.x * s + d.z * c };
}

function legalTargets(balls, ctx) {
  if (ctx.cleared) return balls.filter(b => b.id === 8 && b.active);
  if (ctx.open || !ctx.group) {
    return balls.filter(b => b.active && b.id !== 0 && b.id !== 8);
  }
  return balls.filter(b => b.active && groupIds(ctx.group).includes(b.id));
}

function inBounds(x, z) {
  return Math.abs(x) <= HX - R && Math.abs(z) <= HZ - R;
}
function placementValid(balls, x, z) {
  if (!inBounds(x, z)) return false;
  for (const b of balls) {
    if (!b.active || b.id === 0) continue;
    if (Math.hypot(b.x - x, b.z - z) < D * 1.05) return false;
  }
  return true;
}

// Estimate the cue speed needed for the object ball to travel to the pocket.
// Cut shots transfer less energy, so steeper cuts need more power.
function shotPower(distCue, distObj, cosCut, maxPower) {
  let p = 1.4 + 0.85 * distCue + 1.95 * distObj;
  p /= Math.sqrt(Math.max(cosCut, 0.3));
  return Math.max(1.6, Math.min(maxPower * 0.95, p));
}

// Build a candidate pot for a given cue position, target and pocket.
// Returns null if the geometry/paths don't allow it.
function evalPot(balls, cue, target, pocket, maxPower) {
  const dirTP = unit(pocket.x - target.x, pocket.z - target.z);
  // Ghost ball: where the cue center must be at contact.
  const gx = target.x - dirTP.x * D;
  const gz = target.z - dirTP.z * D;

  const toGhost = { x: gx - cue.x, z: gz - cue.z };
  const distCue = Math.hypot(toGhost.x, toGhost.z);
  if (distCue < 1e-3) return null;
  const dirCue = unit(toGhost.x, toGhost.z);

  // Cut angle: how square the cue meets the object-to-pocket line.
  const cosCut = dirCue.x * dirTP.x + dirCue.z * dirTP.z;
  if (cosCut < 0.18) return null; // too thin a cut to make reliably

  // The cue must approach the ghost from the correct side (object ahead).
  if ((target.x - cue.x) * dirCue.x + (target.z - cue.z) * dirCue.z <= 0) return null;

  // Paths must be clear: cue -> ghost, and object -> pocket.
  if (!pathClear(balls, cue.x, cue.z, gx, gz, [0, target.id])) return null;
  if (!pathClear(balls, target.x, target.z, pocket.x, pocket.z, [target.id])) return null;

  const distObj = Math.hypot(pocket.x - target.x, pocket.z - target.z);
  const power = shotPower(distCue, distObj, cosCut, maxPower);

  // Prefer square cuts and shorter shots.
  const score = cosCut * 3 - 0.25 * distObj - 0.15 * distCue;
  return { dir: dirCue, power, spin: { x: 0, y: 0 }, score, cosCut, distCue, distObj };
}

// Find the best pottable shot from a fixed cue position.
function bestPot(balls, cue, ctx) {
  const targets = legalTargets(balls, ctx);
  let best = null;
  for (const t of targets) {
    for (const p of POCKETS) {
      const s = evalPot(balls, cue, t, p, ctx.maxPower);
      if (s && (!best || s.score > best.score)) best = s;
    }
  }
  return best;
}

// With ball in hand, search placements that yield an easy straight-in shot.
function bestBallInHand(balls, ctx) {
  const targets = legalTargets(balls, ctx);
  let best = null;
  for (const t of targets) {
    for (const p of POCKETS) {
      const dirTP = unit(p.x - t.x, p.z - t.z);
      const gx = t.x - dirTP.x * D, gz = t.z - dirTP.z * D;
      // Try placing the cue straight behind the ghost at a few distances.
      for (const back of [0.32, 0.45, 0.22, 0.6]) {
        const cx = gx - dirTP.x * back;
        const cz = gz - dirTP.z * back;
        if (!placementValid(balls, cx, cz)) continue;
        const cue = { x: cx, z: cz, id: 0 };
        const s = evalPot(balls, cue, t, p, ctx.maxPower);
        if (!s) continue;
        // Straight shots (cosCut ~ 1) score best; nearer pockets preferred.
        const score = s.score + 1.5; // bonus for the freedom of placement
        if (!best || score > best.score) {
          best = { ...s, score, place: { x: cx, z: cz } };
        }
      }
    }
  }
  return best;
}

// A safe shot when nothing is pottable: hit the nearest legal ball with
// medium pace so we make a legal contact and drive a ball to a rail.
function safeShot(balls, cue, ctx) {
  const targets = legalTargets(balls, ctx);
  let nearest = null, nd = Infinity;
  for (const t of targets) {
    const d = Math.hypot(t.x - cue.x, t.z - cue.z);
    if (d < nd && pathClear(balls, cue.x, cue.z, t.x, t.z, [0, t.id])) { nd = d; nearest = t; }
  }
  if (!nearest) {
    // Last resort: hit whatever legal ball is closest even if partly blocked.
    for (const t of targets) {
      const d = Math.hypot(t.x - cue.x, t.z - cue.z);
      if (d < nd) { nd = d; nearest = t; }
    }
  }
  if (!nearest) return { dir: { x: 1, z: 0 }, power: 2.5, spin: { x: 0, y: 0 } };
  const dir = unit(nearest.x - cue.x, nearest.z - cue.z);
  return { dir, power: 2.6, spin: { x: 0, y: 0 }, safe: true };
}

// The opening break: drive into the apex of the rack with near-full power.
function breakShot(cue, ctx) {
  const apexX = HX * 0.5, apexZ = 0;
  const dir = unit(apexX - cue.x, apexZ - cue.z + 0.012); // tiny offset for spread
  return { dir, power: ctx.maxPower * 0.95, spin: { x: 0, y: 0 } };
}

// Plan a shot. Returns { dir:{x,z}, power, spin:{x,y}, place?:{x,z} }.
export function planShot(world, ctx) {
  const balls = world.balls;
  const cue = world.cue();
  let shot;

  if (ctx.isBreak) {
    shot = breakShot(cue, ctx);
  } else if (ctx.ballInHand) {
    shot = bestBallInHand(balls, ctx) || (() => {
      // No clean placement found — drop the cue near center and play safe.
      const place = placementValid(balls, -HX * 0.4, 0) ? { x: -HX * 0.4, z: 0 } : { x: 0, z: 0 };
      const tmp = { x: place.x, z: place.z, id: 0 };
      return { ...safeShot(balls, tmp, ctx), place };
    })();
  } else {
    shot = bestPot(balls, cue, ctx) || safeShot(balls, cue, ctx);
  }

  // Apply aiming error so the AI is good but beatable. Safety shots and the
  // break get a touch more spray; clean pots are tighter.
  const err = ctx.error * (shot.safe ? 1.8 : 1);
  shot.dir = rotate(shot.dir, (Math.random() - 0.5) * 2 * err);
  return shot;
}
