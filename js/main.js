// main.js
// Glue layer: builds the world, runs the game loop, handles input (aim,
// power, spin, ball-in-hand), and enforces a simplified 8-ball ruleset.

import { World, Ball, TABLE } from './physics.js';
import { Scene3D, ballGroup } from './scene.js';

const { HX, HZ, R } = TABLE;

const canvas = document.getElementById('game');
const view = new Scene3D(canvas);
const world = new World();

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const game = {
  phase: 'aiming',          // 'aiming' | 'shooting' | 'gameover'
  current: 0,               // player index 0 or 1
  players: [{ group: null }, { group: null }],
  open: true,               // table open (groups unassigned)
  isBreak: true,
  ballInHand: false,
  aimDir: { x: 1, z: 0 },
  spin: { x: 0, y: 0 },     // english tip offset, within unit circle
  power: 0,
  charging: false,
  chargeStart: 0,
};

const MAX_POWER = 6.0;       // m/s at full charge
const CHARGE_TIME = 1100;    // ms to reach full power

function rackBalls() {
  world.balls.length = 0;
  view.ballMeshes.forEach(m => view.scene.remove(m));
  view.ballMeshes.clear();

  // Cue ball at the head spot.
  world.add(new Ball(0, -HX * 0.5, 0, 0xffffff, 'cue'));

  // Triangle rack at the foot spot. Standard-ish arrangement with the
  // 8-ball in the center of the third row and mixed corners.
  const layout = [
    [1],
    [9, 2],
    [10, 8, 3],
    [11, 4, 12, 5],
    [6, 13, 7, 14, 15],
  ];
  const footX = HX * 0.5;
  const dRow = R * Math.sqrt(3) * 2 * 0.5 * 1.001; // row spacing
  const dCol = 2 * R * 1.001;
  for (let row = 0; row < layout.length; row++) {
    const ids = layout[row];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const x = footX + row * dRow;
      const z = (i - row / 2) * dCol;
      world.add(new Ball(id, x, z, 0, ballGroup(id)));
    }
  }
  view.sync(world);
}

// ---------------------------------------------------------------------------
// Aiming prediction (dashed guide + ghost ball)
// ---------------------------------------------------------------------------
function predictContact(cue, dir) {
  const D2 = (2 * R) * (2 * R);
  let bestT = Infinity;

  // Nearest ball along the aim ray.
  for (const b of world.balls) {
    if (!b.active || b.id === 0) continue;
    const ox = b.x - cue.x, oz = b.z - cue.z;
    const proj = ox * dir.x + oz * dir.z;
    if (proj <= 0) continue;
    const perp2 = ox * ox + oz * oz - proj * proj;
    if (perp2 > D2) continue;
    const t = proj - Math.sqrt(D2 - perp2);
    if (t > 0 && t < bestT) bestT = t;
  }

  // Cushion intersection (ball-center bounds).
  const lx = HX - R, lz = HZ - R;
  const tx = dir.x > 0 ? (lx - cue.x) / dir.x : dir.x < 0 ? (-lx - cue.x) / dir.x : Infinity;
  const tz = dir.z > 0 ? (lz - cue.z) / dir.z : dir.z < 0 ? (-lz - cue.z) / dir.z : Infinity;
  bestT = Math.min(bestT, tx, tz);

  if (!isFinite(bestT)) bestT = 0.5;
  return { x: cue.x + dir.x * bestT, z: cue.z + dir.z * bestT };
}

function updateAimVisuals() {
  const cue = world.cue();
  if (!cue || !cue.active) { view.setAim(null, null, null); view.setCue(cue, game.aimDir, 0, false); return; }
  const hit = predictContact(cue, game.aimDir);
  view.setAim(cue, game.aimDir, hit);
  const pull = game.charging ? 0.02 + game.power / MAX_POWER * 0.25 : 0.02;
  view.setCue(cue, game.aimDir, pull, game.phase === 'aiming');
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
let pointerNDC = { x: 0, y: 0 };

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('pointermove', e => {
  pointerNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointerNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;

  if (game.phase !== 'aiming') return;
  const pt = view.pickTable(pointerNDC.x, pointerNDC.y);
  if (!pt) return;
  const cue = world.cue();

  if (game.ballInHand) {
    // Preview cue-ball placement.
    const valid = validCuePlacement(pt.x, pt.z);
    if (valid) { cue.x = pt.x; cue.z = pt.z; view.sync(world); }
    return;
  }
  if (game.charging) return; // aim locks while charging

  const dx = pt.x - cue.x, dz = pt.z - cue.z;
  const len = Math.hypot(dx, dz);
  if (len > 1e-3) game.aimDir = { x: dx / len, z: dz / len };
});

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;             // left button only; right = orbit
  if (game.phase !== 'aiming') return;

  if (game.ballInHand) {
    const cue = world.cue();
    if (validCuePlacement(cue.x, cue.z)) {
      game.ballInHand = false;
      flash('Cue ball placed — take your shot.');
    }
    return;
  }
  game.charging = true;
  game.chargeStart = performance.now();
});

window.addEventListener('pointerup', e => {
  if (e.button !== 0) return;
  if (!game.charging) return;
  game.charging = false;
  if (game.power > 0.15) shoot();
  game.power = 0;
  updatePowerBar();
});

function shoot() {
  game.preGroupCleared = isGroupCleared(game.current);
  world.shoot(game.aimDir, game.power, game.spin);
  game.phase = 'shooting';
  view.setCue(world.cue(), game.aimDir, 0, false);
  view.setAim(null, null, null);
}

function validCuePlacement(x, z) {
  if (Math.abs(x) > HX - R || Math.abs(z) > HZ - R) return false;
  for (const b of world.balls) {
    if (!b.active || b.id === 0) continue;
    if (Math.hypot(b.x - x, b.z - z) < 2 * R) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Spin widget
// ---------------------------------------------------------------------------
const spinCanvas = document.getElementById('spin');
const sctx = spinCanvas.getContext('2d');
function drawSpin() {
  const w = spinCanvas.width, cx = w / 2, cy = w / 2, rad = w / 2 - 6;
  sctx.clearRect(0, 0, w, w);
  sctx.fillStyle = '#f7f7f2';
  sctx.beginPath(); sctx.arc(cx, cy, rad, 0, Math.PI * 2); sctx.fill();
  sctx.strokeStyle = 'rgba(0,0,0,0.25)';
  sctx.beginPath(); sctx.moveTo(cx - rad, cy); sctx.lineTo(cx + rad, cy); sctx.stroke();
  sctx.beginPath(); sctx.moveTo(cx, cy - rad); sctx.lineTo(cx, cy + rad); sctx.stroke();
  // Tip marker.
  const mx = cx + game.spin.x * rad, my = cy - game.spin.y * rad;
  sctx.fillStyle = '#ef4444';
  sctx.beginPath(); sctx.arc(mx, my, 7, 0, Math.PI * 2); sctx.fill();
}
function setSpinFromEvent(e) {
  const r = spinCanvas.getBoundingClientRect();
  const rad = spinCanvas.width / 2 - 6;
  let nx = (e.clientX - r.left - spinCanvas.width / 2) / rad;
  let ny = -(e.clientY - r.top - spinCanvas.height / 2) / rad;
  const m = Math.hypot(nx, ny);
  if (m > 1) { nx /= m; ny /= m; }
  game.spin = { x: nx, y: ny };
  drawSpin();
}
let spinDrag = false;
spinCanvas.addEventListener('pointerdown', e => { spinDrag = true; setSpinFromEvent(e); });
window.addEventListener('pointermove', e => { if (spinDrag) setSpinFromEvent(e); });
window.addEventListener('pointerup', () => { spinDrag = false; });

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
const bannerEl = document.getElementById('banner');
let bannerTimer = null;
function flash(msg, ms = 2400) {
  bannerEl.textContent = msg;
  bannerEl.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => bannerEl.classList.remove('show'), ms);
}
function updatePowerBar() {
  document.getElementById('power-fill').style.width =
    `${(game.power / MAX_POWER) * 100}%`;
}
function updateScoreboard() {
  for (let i = 0; i < 2; i++) {
    const el = document.getElementById('p' + i);
    el.classList.toggle('active', game.current === i && game.phase !== 'gameover');
    const g = game.players[i].group;
    document.getElementById('g' + i).textContent =
      g ? g.toUpperCase() + ` · ${remainingInGroup(i)} left` : (game.open ? 'open' : '—');
  }
}

// ---------------------------------------------------------------------------
// Rules helpers
// ---------------------------------------------------------------------------
function groupIds(group) {
  if (group === 'solid') return [1, 2, 3, 4, 5, 6, 7];
  if (group === 'stripe') return [9, 10, 11, 12, 13, 14, 15];
  return [];
}
function remainingInGroup(playerIdx) {
  const g = game.players[playerIdx].group;
  if (!g) return 7;
  return groupIds(g).filter(id => world.balls.find(b => b.id === id)?.active).length;
}
function isGroupCleared(playerIdx) {
  const g = game.players[playerIdx].group;
  if (!g) return false;
  return remainingInGroup(playerIdx) === 0;
}
function ballById(id) { return world.balls.find(b => b.id === id); }

// ---------------------------------------------------------------------------
// Shot resolution
// ---------------------------------------------------------------------------
function resolveShot() {
  const ev = world.events;
  const me = game.current;
  const opp = 1 - me;
  const potted = ev.pocketed.filter(id => id !== 0);
  const eightPotted = potted.includes(8);

  // --- The break: keep the table open, just respot the 8 if it dropped. ---
  if (game.isBreak) {
    game.isBreak = false;
    if (eightPotted) respotBall(8);
    if (ev.cueScratch) { foul('Scratch on the break.'); return; }
    if (potted.length > 0) { flash('Nice break!'); endTurnContinue(); return; }
    endTurnPass();
    return;
  }

  // --- Did the 8 go down? That decides the game one way or another. ---
  if (eightPotted) {
    if (!game.preGroupCleared) { gameOver(opp, 'Potted the 8-ball too early!'); return; }
    if (ev.cueScratch) { gameOver(opp, 'Scratched while potting the 8-ball.'); return; }
    gameOver(me, `Player ${me + 1} sinks the 8-ball — game!`); return;
  }

  // --- Foul checks. ---
  if (ev.cueScratch) { foul('Scratch — cue ball pocketed.'); return; }
  if (ev.firstHit === null) { foul('No ball was hit.'); return; }

  // Wrong-ball-first (only enforced once groups are assigned).
  if (!game.open && game.players[me].group) {
    const firstGroup = ballGroup(ev.firstHit);
    const cleared = isGroupCleared(me);
    const legalFirst = cleared ? (ev.firstHit === 8) : (firstGroup === game.players[me].group);
    if (!legalFirst) {
      foul(cleared ? 'You must hit the 8-ball first.' : 'You hit the wrong group first.');
      return;
    }
  }

  // No rail / no pot after contact.
  if (potted.length === 0 && !ev.railAfter) {
    foul('No ball reached a rail after contact.');
    return;
  }

  // --- Assign groups on the first legal pot of an open table. ---
  if (game.open && potted.length > 0) {
    const firstObj = potted.find(id => id !== 8);
    if (firstObj !== undefined) {
      const g = ballGroup(firstObj);
      game.players[me].group = g;
      game.players[opp].group = g === 'solid' ? 'stripe' : 'solid';
      game.open = false;
      flash(`Player ${me + 1} is ${g.toUpperCase()}.`);
    }
  }

  // --- Continue or pass the turn. ---
  const myGroup = game.players[me].group;
  const pottedOwn = myGroup
    ? potted.some(id => groupIds(myGroup).includes(id))
    : potted.length > 0;

  if (pottedOwn) endTurnContinue();
  else endTurnPass();
}

function endTurnContinue() {
  game.phase = 'aiming';
  startAim();
}
function endTurnPass() {
  game.current = 1 - game.current;
  game.phase = 'aiming';
  flash(`Player ${game.current + 1}'s turn.`, 1600);
  startAim();
}
function foul(msg) {
  flash(msg + ' Opponent gets ball in hand.');
  game.current = 1 - game.current;
  game.phase = 'aiming';
  // Respot the cue ball if it was scratched, then hand it over.
  const cue = world.cue();
  if (!cue.active) { cue.active = true; cue.x = -HX * 0.5; cue.z = 0; }
  cue.vx = cue.vz = cue.wx = cue.wy = cue.wz = 0;
  game.ballInHand = true;
  view.sync(world);
  startAim();
}
function gameOver(winner, msg) {
  game.phase = 'gameover';
  flash(`🏆 ${msg}`, 8000);
  updateScoreboard();
}

function respotBall(id) {
  const b = ballById(id);
  if (!b) return;
  b.active = true;
  // Place at the foot spot, nudging if occupied.
  let x = HX * 0.5, z = 0;
  let tries = 0;
  while (!validCuePlacement(x, z) && tries < 40) { x += 2 * R; tries++; }
  b.x = x; b.z = z; b.vx = b.vz = 0;
}

function startAim() {
  game.ballInHand = game.ballInHand; // keep flag
  game.power = 0;
  updatePowerBar();
  updateScoreboard();
  // Default aim toward table center if cue exists.
  updateAimVisuals();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (game.phase === 'shooting') {
    world.step(dt);
    view.sync(world);
    if (!world.anyMoving()) resolveShot();
  } else if (game.phase === 'aiming') {
    if (game.charging) {
      const held = now - game.chargeStart;
      game.power = Math.min(MAX_POWER, (held / CHARGE_TIME) * MAX_POWER);
      updatePowerBar();
    }
    updateAimVisuals();
  }

  view.render();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Buttons / boot
// ---------------------------------------------------------------------------
document.getElementById('newgame').addEventListener('click', newGame);
document.getElementById('help-btn').addEventListener('click', () =>
  document.getElementById('help').classList.remove('hidden'));
document.getElementById('help-close').addEventListener('click', () =>
  document.getElementById('help').classList.add('hidden'));

function newGame() {
  game.phase = 'aiming';
  game.current = 0;
  game.players = [{ group: null }, { group: null }];
  game.open = true;
  game.isBreak = true;
  game.ballInHand = false;
  game.spin = { x: 0, y: 0 };
  game.power = 0;
  rackBalls();
  drawSpin();
  updatePowerBar();
  updateScoreboard();
  flash('Player 1 to break. Hold left mouse to power up!', 3000);
}

newGame();
requestAnimationFrame(loop);
