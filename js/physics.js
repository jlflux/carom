// physics.js
// A self-contained billiards physics engine for a pool table with pockets.
//
// Coordinate system (table plane is X/Z, Y is up):
//   x: along the length of the table  (range roughly [-HX, +HX])
//   z: across the width of the table  (range roughly [-HZ, +HZ])
//   y: up (constant ball center height = R)
//
// Each ball carries a linear velocity (vx, vz) and a 3D angular velocity
// (wx, wy, wz). Side-spin lives on wy; follow/draw lives on wx/wz. This lets
// us model sliding vs. rolling, english off the cushions, and throw — the
// things that make a pool table feel alive.

export const TABLE = {
  // Playing surface half-dimensions (meters). Roughly a 9-foot table.
  HX: 1.27,
  HZ: 0.635,
  R: 0.0286,        // ball radius (~57mm diameter)
  M: 0.17,          // ball mass (kg)
  POCKET_R: 0.075,  // capture radius at a pocket mouth
  JAW: 0.11,        // near a pocket, cushions stop reflecting (the "jaws")
};

// Pocket centers: 4 corners + 2 sides (middle of the long rails).
export const POCKETS = [
  { x: -TABLE.HX, z: -TABLE.HZ },
  { x:  TABLE.HX, z: -TABLE.HZ },
  { x: -TABLE.HX, z:  TABLE.HZ },
  { x:  TABLE.HX, z:  TABLE.HZ },
  { x: 0,         z: -TABLE.HZ },
  { x: 0,         z:  TABLE.HZ },
];

// Physical constants (tuned for feel, not strict realism).
const G = 9.8;
const MU_SLIDE = 0.20;   // sliding friction (ball skidding on cloth)
const MU_ROLL  = 0.012;  // rolling resistance
const MU_SPIN  = 6.0;    // angular decay of vertical (side) spin
const E_CUSHION = 0.80;  // cushion restitution
const E_BALL = 0.95;     // ball-ball restitution
const CUSHION_SPIN = 0.6; // how much side-spin throws off a cushion
const STOP_V = 0.006;    // below this speed a ball is considered stopped
const STOP_W = 0.2;      // below this spin a ball is considered still

const { R } = TABLE;

export class Ball {
  constructor(id, x, z, color, group) {
    this.id = id;
    this.x = x; this.z = z;
    this.vx = 0; this.vz = 0;
    this.wx = 0; this.wy = 0; this.wz = 0;
    this.color = color;
    this.group = group;     // 'cue' | 'solid' | 'stripe' | 'eight'
    this.active = true;     // false once pocketed
  }
  speed() { return Math.hypot(this.vx, this.vz); }
  moving() {
    return this.active && (this.speed() > STOP_V ||
      Math.abs(this.wy) > STOP_W ||
      Math.hypot(this.wx, this.wz) > STOP_W);
  }
}

export class World {
  constructor() {
    this.balls = [];
    this.resetEvents();
  }

  add(ball) { this.balls.push(ball); return ball; }
  cue() { return this.balls.find(b => b.id === 0); }

  resetEvents() {
    // Records what happened during the current shot, for the rules engine.
    this.events = {
      firstHit: null,     // id of first object ball the cue contacted
      contacts: [],       // every object-ball id the cue touched
      railAfter: false,   // a ball hit a rail after the first contact
      anyContact: false,  // cue touched any object ball
      pocketed: [],       // ids in the order they dropped
      cueScratch: false,  // cue ball was pocketed
    };
  }

  anyMoving() { return this.balls.some(b => b.moving()); }

  // Apply a stroke to the cue ball.
  //   dir   : {x, z} unit vector aiming direction
  //   power : speed magnitude (m/s)
  //   spin  : {x, y} cue tip offset in [-1, 1]; x=side english, y=follow/draw
  shoot(dir, power, spin) {
    const cue = this.cue();
    if (!cue || !cue.active) return;
    const len = Math.hypot(dir.x, dir.z) || 1;
    const dx = dir.x / len, dz = dir.z / len;

    cue.vx = dx * power;
    cue.vz = dz * power;

    // Initial angular velocity from where the tip strikes the ball face.
    // Derived from angular impulse = (contact offset) x (linear impulse):
    //   side offset (spin.x)  -> vertical spin  wy
    //   vertical offset (spin.y) -> follow/draw about the horizontal axis
    //                               perpendicular to the aim (dz, 0, -dx)
    const k = (5 * power) / (2 * R);
    cue.wy = k * spin.x;
    cue.wx = k * spin.y * dz;
    cue.wz = k * spin.y * -dx;

    this.resetEvents();
  }

  step(dt) {
    // Fixed-timestep substeps keep collisions stable at high speed.
    const h = 1 / 240;
    let remaining = dt;
    while (remaining > 1e-6) {
      const sub = Math.min(h, remaining);
      this.substep(sub);
      remaining -= sub;
    }
  }

  substep(dt) {
    for (const b of this.balls) {
      if (!b.active) continue;
      this.integrate(b, dt);
    }
    this.collideBalls();
    for (const b of this.balls) {
      if (!b.active) continue;
      this.collideCushions(b);
    }
    this.handlePockets();
  }

  integrate(b, dt) {
    // Velocity of the contact point (where ball meets cloth).
    //   u = v + w x (-R y_hat)  ->  ux = vx + R*wz,  uz = vz - R*wx
    const ux = b.vx + R * b.wz;
    const uz = b.vz - R * b.wx;
    const uSpeed = Math.hypot(ux, uz);

    if (uSpeed > 1e-4) {
      // Sliding: kinetic friction opposes the contact-point slip.
      const ax = -MU_SLIDE * G * (ux / uSpeed);
      const az = -MU_SLIDE * G * (uz / uSpeed);
      b.vx += ax * dt;
      b.vz += az * dt;
      // Friction torque spins the ball toward a pure roll.
      const c = (5 / (2 * R));
      b.wx += c * (-az) * dt;
      b.wz += c * (ax) * dt;
      // If this step overshot the rolling point, the contact slip would
      // reverse — discrete jitter that never settles. Snap to a pure roll
      // (u = 0) so rolling resistance can then bring the ball to rest.
      const ux2 = b.vx + R * b.wz;
      const uz2 = b.vz - R * b.wx;
      if (ux2 * ux + uz2 * uz < 0) {
        b.wz = -b.vx / R;
        b.wx = b.vz / R;
      }
    } else {
      // Rolling: light rolling resistance, keep spin consistent with motion.
      const sp = b.speed();
      if (sp > 1e-5) {
        const dec = MU_ROLL * G;
        const nx = b.vx / sp, nz = b.vz / sp;
        const nv = Math.max(0, sp - dec * dt);
        b.vx = nx * nv; b.vz = nz * nv;
      }
      b.wz = -b.vx / R;
      b.wx = b.vz / R;
    }

    // Vertical (side) spin always bleeds off.
    const decay = Math.exp(-MU_SPIN * dt);
    b.wy *= decay;

    b.x += b.vx * dt;
    b.z += b.vz * dt;

    // Snap to rest once moving slowly. We must also clear the rolling spin
    // (wx/wz), otherwise it keeps feeding the contact point and the ball
    // never truly stops. Side spin (wy) is left to decay on its own.
    if (b.speed() < STOP_V) {
      const slip = Math.hypot(b.vx + R * b.wz, b.vz - R * b.wx);
      if (slip < STOP_V) {
        b.vx = 0; b.vz = 0; b.wx = 0; b.wz = 0;
        if (Math.abs(b.wy) < STOP_W) b.wy = 0;
      }
    }
  }

  // Is a ball currently within the "jaws" of a pocket (where the cushion
  // opens up and should not bounce the ball back)?
  nearPocket(b) {
    for (const p of POCKETS) {
      if (Math.hypot(b.x - p.x, b.z - p.z) < TABLE.JAW) return true;
    }
    return false;
  }

  collideCushions(b) {
    if (this.nearPocket(b)) return; // let it pass into / rattle near the jaws
    const lx = TABLE.HX - R;
    const lz = TABLE.HZ - R;
    let hit = false;

    if (b.x > lx && b.vx > 0) {
      b.x = lx; b.vx = -b.vx * E_CUSHION;
      b.vz += CUSHION_SPIN * b.wy * R; b.wy *= 0.5; hit = true;
    } else if (b.x < -lx && b.vx < 0) {
      b.x = -lx; b.vx = -b.vx * E_CUSHION;
      b.vz -= CUSHION_SPIN * b.wy * R; b.wy *= 0.5; hit = true;
    }
    if (b.z > lz && b.vz > 0) {
      b.z = lz; b.vz = -b.vz * E_CUSHION;
      b.vx -= CUSHION_SPIN * b.wy * R; b.wy *= 0.5; hit = true;
    } else if (b.z < -lz && b.vz < 0) {
      b.z = -lz; b.vz = -b.vz * E_CUSHION;
      b.vx += CUSHION_SPIN * b.wy * R; b.wy *= 0.5; hit = true;
    }

    if (hit && this.events.anyContact) this.events.railAfter = true;
  }

  collideBalls() {
    const n = this.balls.length;
    const D = 2 * R;
    for (let i = 0; i < n; i++) {
      const a = this.balls[i];
      if (!a.active) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.balls[j];
        if (!b.active) continue;
        let dx = b.x - a.x, dz = b.z - a.z;
        let dist = Math.hypot(dx, dz);
        if (dist > 0 && dist < D) {
          const nx = dx / dist, nz = dz / dist;
          // Separate overlap so balls never stick.
          const overlap = (D - dist) / 2;
          a.x -= nx * overlap; a.z -= nz * overlap;
          b.x += nx * overlap; b.z += nz * overlap;

          // Relative velocity along the line of centers.
          const rel = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
          if (rel > 0) {
            const jimp = -(1 + E_BALL) * rel / 2; // equal masses
            a.vx += jimp * nx; a.vz += jimp * nz;
            b.vx -= jimp * nx; b.vz -= jimp * nz;

            this.recordContact(a, b);
          }
        }
      }
    }
  }

  recordContact(a, b) {
    // Track cue-ball contacts for the rules engine.
    let other = null;
    if (a.id === 0) other = b;
    else if (b.id === 0) other = a;
    if (!other) return;
    this.events.anyContact = true;
    if (this.events.firstHit === null) this.events.firstHit = other.id;
    if (!this.events.contacts.includes(other.id)) {
      this.events.contacts.push(other.id);
    }
  }

  handlePockets() {
    for (const b of this.balls) {
      if (!b.active) continue;
      for (const p of POCKETS) {
        if (Math.hypot(b.x - p.x, b.z - p.z) < TABLE.POCKET_R) {
          b.active = false;
          b.vx = b.vz = b.wx = b.wy = b.wz = 0;
          this.events.pocketed.push(b.id);
          if (b.id === 0) this.events.cueScratch = true;
          break;
        }
      }
    }
  }
}
