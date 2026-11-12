// main.js
// Glue layer: builds the world, runs the game loop, handles input (aim,
// power, spin, ball-in-hand), and enforces a simplified 8-ball ruleset.

import { World, Ball, TABLE } from './physics.js';
import { Scene3D, ballGroup, OVERVIEW } from './scene.js';
import { planShot } from './ai.js';

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
  players: [{ group: null, ai: false }, { group: null, ai: true }],
  open: true,               // table open (groups unassigned)
  isBreak: true,
  ballInHand: false,
  aimDir: { x: 1, z: 0 },
  spin: { x: 0, y: 0 },     // english tip offset, within unit circle
  power: 0,
  pulling: false,           // aim is locked and the mouse is setting power
  pullHeld: false,          // the button that started the pull is still down
  pullDist: 0,              // how far back the mouse has been pulled (px)
  mode: 'ai',              // 'ai' (vs computer) | 'pvp' (two players)
  difficulty: 'Medium',
  ai: { state: 'idle', shot: null, until: 0, chargeStart: 0 },
};

const MAX_POWER = 6.0;       // m/s at a full pull
const MIN_POWER = 0.2;       // pulls weaker than this don't count as a shot

// How far (in screen pixels) the mouse must be pulled back for full power.
function pullRange() {
  return Math.max(120, Math.min(260, window.innerHeight * 0.3));
}

// How wildly the computer's aim can stray, per difficulty (radians).
const DIFFICULTY = { Easy: 0.05, Medium: 0.022, Hard: 0.008 };

// Pacing for the computer's turn animation.
const AI_THINK_MS = 750, AI_AIM_MS = 600, AI_CHARGE_MS = 450;

function currentIsAI() { return !!game.players[game.current].ai; }

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
  const pull = 0.02 + game.power / MAX_POWER * 0.25;
  view.setCue(cue, game.aimDir, pull, game.phase === 'aiming');
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
// The camera has three modes:
//   aim      - your turn: it sits behind the cue with the cue ball centered,
//              and swings round as the mouse turns the aim.
//   hold     - balls are rolling: it stays where it was.
//   overview - the computer's turn, placing the cue ball, or game over.
const cam = {
  aimPitch: 0.36, aimDist: 1.15,
  ovYaw: OVERVIEW.yaw, ovPitch: OVERVIEW.pitch, ovDist: OVERVIEW.dist,
};
const AIM_SENS = 0.0022;     // radians of aim per pixel of mouse travel
const FINE_AIM = 0.2;        // multiplier while Shift is held
const PITCH_SENS = 0.003;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function cameraMode() {
  if (game.phase === 'shooting') return 'hold';
  if (game.phase === 'aiming' && !currentIsAI() && !game.ballInHand) return 'aim';
  return 'overview';
}

function updateCameraGoal() {
  const mode = cameraMode();
  if (mode === 'aim') {
    const cue = world.cue();
    const yaw = Math.atan2(game.aimDir.z, game.aimDir.x);
    view.setCameraGoal(cue.x, cue.z, yaw, cam.aimPitch, cam.aimDist, true);
  } else if (mode === 'overview') {
    view.setCameraGoal(0, 0, cam.ovYaw, cam.ovPitch, cam.ovDist, false);
  } else {
    view.holdCamera();
  }
  captureEl.classList.toggle('show', mode === 'aim' && !steering());
}

// Aiming steers by mouse movement rather than position, so the mouse is
// captured (pointer lock): the cursor hides and can travel without limit.
// Esc releases it. If the browser refuses the capture, movement over the
// table is used instead.
const captureEl = document.getElementById('capture');
let lockFailed = false;
const isLocked = () => document.pointerLockElement === canvas;
const steering = () => isLocked() || lockFailed;

function captureMouse() {
  if (isLocked() || lockFailed) return;
  if (!canvas.requestPointerLock) { lockFailed = true; return; }
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => { lockFailed = true; });
  } catch { lockFailed = true; }
}
function releaseMouse() {
  if (isLocked()) document.exitPointerLock();
}
document.addEventListener('pointerlockerror', () => { lockFailed = true; });
document.addEventListener('pointerlockchange', () => {
  if (!isLocked() && game.pulling) cancelPull();
});

canvas.addEventListener('contextmenu', e => e.preventDefault());

// Mouse movement: turn the aim (and the camera with it), or set the power
// while a shot is being pulled back.
window.addEventListener('pointermove', e => {
  const dx = clamp(e.movementX || 0, -150, 150);
  const dy = clamp(e.movementY || 0, -150, 150);
  const mode = cameraMode();

  if (mode === 'aim') {
    const overTable = e.target === canvas;
    if (!isLocked() && !(lockFailed && (overTable || game.pulling))) return;
    if (game.pulling) {
      // The camera is behind the cue, so pulling the mouse back (toward you)
      // draws the cue back.
      game.pullDist = clamp(game.pullDist + dy, 0, pullRange());
      game.power = game.pullDist / pullRange() * MAX_POWER;
      updatePowerBar();
    } else {
      const sens = AIM_SENS * (e.shiftKey ? FINE_AIM : 1);
      const a = Math.atan2(game.aimDir.z, game.aimDir.x) + dx * sens;
      game.aimDir = { x: Math.cos(a), z: Math.sin(a) };
      cam.aimPitch = clamp(cam.aimPitch + dy * PITCH_SENS, 0.17, 1.45);
    }
    return;
  }

  // Outside your turn, right-drag looks around the table.
  if (mode === 'overview' && (e.buttons & 2)) {
    cam.ovYaw += dx * 0.005;
    cam.ovPitch = clamp(cam.ovPitch + dy * 0.005, 0.2, 1.5);
  }
});

// With ball in hand the cursor is free: the cue ball follows it.
canvas.addEventListener('pointermove', e => {
  if (game.phase !== 'aiming' || currentIsAI() || !game.ballInHand) return;
  const pt = view.pickTable(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );
  if (pt && validCuePlacement(pt.x, pt.z)) {
    const cue = world.cue();
    cue.x = pt.x; cue.z = pt.z;
    view.sync(world);
  }
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const f = Math.exp(e.deltaY * 0.001);
  if (cameraMode() === 'aim') cam.aimDist = clamp(cam.aimDist * f, 0.45, 3.2);
  else cam.ovDist = clamp(cam.ovDist * f, 1.2, 5);
}, { passive: false });

// Shooting: a click locks the aim, then pulling the mouse back sets the power.
// It works two ways:
//   - press, pull back, release to strike; or
//   - click, pull back, click again to strike.
// A click with no pull or a right-click cancels and unlocks the aim.
canvas.addEventListener('pointerdown', e => {
  if (e.button === 2 && game.pulling) { cancelPull(); return; }
  if (e.button !== 0) return;
  if (game.phase !== 'aiming' || currentIsAI()) return;

  if (game.ballInHand) {
    const cue = world.cue();
    if (validCuePlacement(cue.x, cue.z)) {
      game.ballInHand = false;
      flash('Cue ball placed — take your shot.');
      captureMouse();
    }
    return;
  }

  // The first click on the table just captures the mouse for aiming.
  if (!steering()) { captureMouse(); return; }

  if (!game.pulling) { beginPull(); return; }
  // Second click of a click-pull-click shot.
  if (game.power > MIN_POWER) strike(); else cancelPull();
});

window.addEventListener('pointerup', e => {
  if (e.button !== 0 || !game.pulling || !game.pullHeld) return;
  game.pullHeld = false;
  // Released after pulling back: strike. Released without a pull: it was a
  // plain click, so stay in pull mode and wait for the second click.
  if (game.power > MIN_POWER) strike();
});

// Arrow keys move the cue tip (spin) so it can be set without freeing the mouse.
window.addEventListener('keydown', e => {
  const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
  if (!step || game.phase !== 'aiming' || currentIsAI()) return;
  e.preventDefault();
  let x = game.spin.x + step[0] * 0.1, y = game.spin.y + step[1] * 0.1;
  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  game.spin = { x, y };
  drawSpin();
});

function beginPull() {
  game.pulling = true;
  game.pullHeld = true;
  game.pullDist = 0;
  game.power = 0;
  updatePowerBar();
}

function cancelPull() {
  game.pulling = false;
  game.pullHeld = false;
  game.power = 0;
  updatePowerBar();
}

function strike() {
  game.pulling = false;
  game.pullHeld = false;
  shoot();
  game.power = 0;
  updatePowerBar();
}

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
    gameOver(me, `${playerName(me)} sink${me === 0 && game.mode === 'ai' ? '' : 's'} the 8-ball — game!`); return;
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
      flash(`${playerName(me)} ${me === 0 && game.mode === 'ai' ? 'are' : 'is'} ${g.toUpperCase()}.`);
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
  flash(`${playerName(game.current)}'s turn.`, 1600);
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
  if (!currentIsAI()) releaseMouse();   // the cursor is needed to place the ball
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
  game.power = 0;
  updatePowerBar();
  updateScoreboard();
  updateAimVisuals();
  maybeStartAI();
}

// ---------------------------------------------------------------------------
// Computer opponent
// ---------------------------------------------------------------------------
function maybeStartAI() {
  if (game.phase !== 'aiming' || !currentIsAI()) return;
  startAITurn();
}

function startAITurn() {
  const ctx = {
    group: game.players[game.current].group,
    cleared: isGroupCleared(game.current),
    open: game.open,
    isBreak: game.isBreak,
    ballInHand: game.ballInHand,
    maxPower: MAX_POWER,
    error: DIFFICULTY[game.difficulty],
  };
  const shot = planShot(world, ctx);

  // Place the cue ball if the computer has ball in hand.
  if (game.ballInHand && shot.place) {
    const cue = world.cue();
    cue.x = shot.place.x; cue.z = shot.place.z;
    cue.vx = cue.vz = cue.wx = cue.wy = cue.wz = 0;
    game.ballInHand = false;
    view.sync(world);
  }

  game.ai.shot = shot;
  game.ai.state = 'think';
  game.ai.until = performance.now() + AI_THINK_MS;
  flash('🤖 Computer is thinking…', AI_THINK_MS);
}

// Advance the computer's turn animation: think → settle aim → charge → strike.
function stepAI(now) {
  const ai = game.ai;
  if (ai.state === 'think') {
    if (now >= ai.until) {
      game.aimDir = ai.shot.dir;
      game.spin = ai.shot.spin;
      drawSpin();
      ai.state = 'aim';
      ai.until = now + AI_AIM_MS;
    }
  } else if (ai.state === 'aim') {
    if (now >= ai.until) { ai.state = 'charge'; ai.chargeStart = now; }
  } else if (ai.state === 'charge') {
    const f = Math.min(1, (now - ai.chargeStart) / AI_CHARGE_MS);
    game.power = ai.shot.power * f;
    updatePowerBar();
    if (f >= 1) {
      ai.state = 'idle';
      shoot();
      game.power = 0;
      updatePowerBar();
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let last = performance.now();
function loop(now) {
  const elapsed = (now - last) / 1000;
  const dt = Math.min(0.05, elapsed);      // physics step, capped for stability
  last = now;

  if (game.phase === 'shooting') {
    world.step(dt);
    view.sync(world);
    if (!world.anyMoving()) resolveShot();
  } else if (game.phase === 'aiming') {
    if (currentIsAI()) stepAI(now);
    updateAimVisuals();
  }

  updateCameraGoal();
  view.render(Math.min(0.25, elapsed)); // camera glides in real time
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

const modeBtn = document.getElementById('mode');
const diffBtn = document.getElementById('difficulty');
modeBtn.addEventListener('click', () => {
  game.mode = game.mode === 'ai' ? 'pvp' : 'ai';
  modeBtn.textContent = game.mode === 'ai' ? 'vs Computer' : '2 Player';
  diffBtn.style.display = game.mode === 'ai' ? '' : 'none';
  newGame();
});
diffBtn.addEventListener('click', () => {
  const order = ['Easy', 'Medium', 'Hard'];
  game.difficulty = order[(order.indexOf(game.difficulty) + 1) % order.length];
  diffBtn.textContent = `AI: ${game.difficulty}`;
});

function playerName(i) {
  if (game.mode === 'ai') return i === 0 ? 'You' : 'Computer';
  return `Player ${i + 1}`;
}
function updateNames() {
  for (let i = 0; i < 2; i++) {
    const el = document.querySelector(`#p${i} .pname`);
    if (el) el.textContent = playerName(i);
  }
}

function newGame() {
  game.phase = 'aiming';
  game.current = 0;
  game.players = [
    { group: null, ai: false },
    { group: null, ai: game.mode === 'ai' },
  ];
  game.open = true;
  game.isBreak = true;
  game.ballInHand = false;
  game.spin = { x: 0, y: 0 };
  game.power = 0;
  game.pulling = false;
  game.pullHeld = false;
  game.ai = { state: 'idle', shot: null, until: 0, chargeStart: 0 };
  rackBalls();
  drawSpin();
  updatePowerBar();
  updateNames();
  updateScoreboard();
  const who = game.mode === 'ai' ? 'You break' : 'Player 1 to break';
  flash(`${who}. Move the mouse to aim, click and pull back to shoot.`, 3500);
}

newGame();
requestAnimationFrame(loop);

// Optional debug hook (append ?debug=1 to the URL) for inspecting state and
// scripting tests from the console.
if (new URLSearchParams(location.search).get('debug')) {
  window.carom = { game, world, view, cam, Ball, TABLE, startAim };
}
