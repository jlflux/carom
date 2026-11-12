// scene.js
// Builds the Three.js world: the table, rails, pockets, balls, cue stick,
// aiming guide, lighting and camera. Pure rendering — it reads ball state
// from the physics World and draws it.

import * as THREE from 'three';
import { TABLE, POCKETS } from './physics.js';

const { HX, HZ, R } = TABLE;

// The default whole-table view. A camera pose is a point on the table to look
// at, the compass direction the camera faces (yaw, measured like atan2(z, x)),
// how steeply it looks down (pitch) and how far back it sits (dist).
export const OVERVIEW = { yaw: -Math.PI / 2, pitch: 0.73, dist: 2.55 };

// Number-ball colors (standard pool set). 9-15 reuse 1-7 as stripes.
export const BALL_COLORS = {
  0: 0xf7f7f2, // cue (white)
  1: 0xf6c915, // yellow
  2: 0x1f4ed8, // blue
  3: 0xd4282a, // red
  4: 0x6d28d9, // purple
  5: 0xe07b1b, // orange
  6: 0x15803d, // green
  7: 0x7c2d12, // maroon
  8: 0x101014, // black
};
export function ballColor(id) {
  if (id <= 8) return BALL_COLORS[id];
  return BALL_COLORS[id - 8]; // stripes share solids' colors
}
export function ballGroup(id) {
  if (id === 0) return 'cue';
  if (id === 8) return 'eight';
  return id < 8 ? 'solid' : 'stripe';
}

export class Scene3D {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0d12);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100);

    // Camera rig: `cur` is where the camera is, `goal` is where the game wants
    // it. The camera glides toward the goal; when asked to `follow`, it locks
    // on once it arrives so aiming has no lag.
    const start = { tx: 0, tz: 0, ...OVERVIEW };
    this.rig = { cur: { ...start }, goal: { ...start }, follow: false, locked: false };
    this._applyCamera();

    this.ballMeshes = new Map(); // id -> THREE.Group

    this._buildLights();
    this._buildTable();
    this._buildCue();
    this._buildAim();

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _buildLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1.2, 3.0, 1.0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = 2.2;
    key.shadow.camera.left = -s; key.shadow.camera.right = s;
    key.shadow.camera.top = s; key.shadow.camera.bottom = -s;
    key.shadow.camera.near = 0.5; key.shadow.camera.far = 8;
    key.shadow.bias = -0.0005;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xaaccff, 0.3);
    fill.position.set(-1.5, 1.5, -1.2);
    this.scene.add(fill);
  }

  _buildTable() {
    const railH = 0.04;
    const railW = 0.07;
    const bedTop = 0; // felt surface sits at y = 0; ball centers at y = R

    // Felt bed.
    const feltMat = new THREE.MeshStandardMaterial({ color: 0x0f7a4a, roughness: 0.9 });
    const bed = new THREE.Mesh(new THREE.BoxGeometry(2 * HX, 0.04, 2 * HZ), feltMat);
    bed.position.y = bedTop - 0.02;
    bed.receiveShadow = true;
    this.scene.add(bed);

    // Wooden frame under/around the felt.
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a3413, roughness: 0.6, metalness: 0.05 });
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(2 * HX + 2 * railW + 0.06, 0.16, 2 * HZ + 2 * railW + 0.06),
      woodMat
    );
    frame.position.y = -0.10;
    frame.castShadow = true; frame.receiveShadow = true;
    this.scene.add(frame);

    // Cushion rails (cut into segments so they don't cover the pockets).
    const cushMat = new THREE.MeshStandardMaterial({ color: 0x0c5e39, roughness: 0.85 });
    const gap = 0.10; // half-length of pocket opening
    const addRail = (cx, cz, w, d) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, railH, d), cushMat);
      m.position.set(cx, railH / 2, cz);
      m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m);
    };
    // Long rails (top/bottom), split by the side pocket.
    const longLen = HX - gap * 1.5;
    for (const sz of [-1, 1]) {
      addRail(-(gap * 0.5 + longLen / 2), sz * (HZ + railW / 2), longLen, railW);
      addRail( (gap * 0.5 + longLen / 2), sz * (HZ + railW / 2), longLen, railW);
    }
    // Short rails (left/right).
    const shortLen = 2 * HZ - gap * 2;
    for (const sx of [-1, 1]) {
      addRail(sx * (HX + railW / 2), 0, railW, shortLen);
    }

    // Wooden top caps on the rails for a finished look.
    const capMat = new THREE.MeshStandardMaterial({ color: 0x6b4017, roughness: 0.5 });
    const capH = 0.025;
    const addCap = (cx, cz, w, d) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, capH, d), capMat);
      m.position.set(cx, railH + capH / 2, cz);
      m.castShadow = true;
      this.scene.add(m);
    };
    for (const sz of [-1, 1]) addCap(0, sz * (HZ + railW + 0.03), 2 * HX + 2 * railW + 0.06, 0.06);
    for (const sx of [-1, 1]) addCap(sx * (HX + railW + 0.03), 0, 0.06, 2 * HZ + 2 * railW + 0.06);

    // Pocket holes.
    const holeMat = new THREE.MeshStandardMaterial({ color: 0x05060a, roughness: 1 });
    for (const p of POCKETS) {
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(TABLE_POCKET_VIS, TABLE_POCKET_VIS, 0.05, 24), holeMat);
      hole.position.set(p.x, 0.001, p.z);
      this.scene.add(hole);
    }

    // Floor.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: 0x14161d, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.20;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  makeBall(id) {
    const group = new THREE.Group();
    const isStripe = id > 8;
    const baseColor = isStripe ? 0xf2f2ec : ballColor(id);

    const mat = new THREE.MeshStandardMaterial({
      color: baseColor, roughness: 0.18, metalness: 0.0,
    });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 24), mat);
    sphere.castShadow = true; sphere.receiveShadow = true;
    group.add(sphere);

    if (isStripe) {
      // Colored band around the equator.
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 1.001, R * 1.001, R * 0.9, 32, 1, true),
        new THREE.MeshStandardMaterial({ color: ballColor(id), roughness: 0.18 })
      );
      group.add(band);
    }

    if (id !== 0) {
      // Number patch (two white discs on opposite poles for visibility).
      const patchMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
      for (const s of [1, -1]) {
        const patch = new THREE.Mesh(new THREE.CircleGeometry(R * 0.42, 24), patchMat);
        patch.position.set(0, 0, s * R * 1.002);
        if (s < 0) patch.rotation.y = Math.PI;
        group.add(patch);
        const label = makeNumberSprite(id);
        label.position.set(0, 0, s * R * 1.02);
        if (s < 0) label.rotation.y = Math.PI;
        group.add(label);
      }
    }

    group.position.set(0, R, 0);
    this.scene.add(group);
    this.ballMeshes.set(id, group);
    return group;
  }

  _buildCue() {
    const len = 1.45;
    // Local +Y runs from the tip (y = 0, thin) to the butt (y = len, thick).
    const geo = new THREE.CylinderGeometry(0.014, 0.006, len, 16);
    geo.translate(0, len / 2, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb5853f, roughness: 0.4 });
    this.cue = new THREE.Mesh(geo, mat);
    this.cue.castShadow = true;
    // Blue tip.
    const tip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.006, 0.02, 16),
      new THREE.MeshStandardMaterial({ color: 0x2563eb })
    );
    tip.position.y = -0.01;
    this.cue.add(tip);
    this.cue.visible = false;
    this.scene.add(this.cue);
  }

  _buildAim() {
    const mat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.03, gapSize: 0.02, transparent: true, opacity: 0.8 });
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, R, 0), new THREE.Vector3(0, R, 1),
    ]);
    this.aimLine = new THREE.Line(geo, mat);
    this.aimLine.computeLineDistances();
    this.aimLine.visible = false;
    this.scene.add(this.aimLine);

    // Ghost ball showing where the cue ball will be at first contact.
    this.ghost = new THREE.Mesh(
      new THREE.SphereGeometry(R, 20, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, wireframe: true })
    );
    this.ghost.visible = false;
    this.scene.add(this.ghost);
  }

  // Update the dashed aim guide + ghost ball.
  setAim(cue, dir, hit) {
    if (!hit) { this.aimLine.visible = false; this.ghost.visible = false; return; }
    const from = new THREE.Vector3(cue.x, R, cue.z);
    const to = new THREE.Vector3(hit.x, R, hit.z);
    this.aimLine.geometry.setFromPoints([from, to]);
    this.aimLine.computeLineDistances();
    this.aimLine.visible = true;
    this.ghost.position.copy(to);
    this.ghost.visible = true;
  }

  // Position the cue stick behind the cue ball, pulled back by `pull` meters.
  setCue(cue, dir, pull, visible) {
    this.cue.visible = visible;
    if (!visible) return;
    const back = 0.02 + pull;
    this.cue.position.set(cue.x - dir.x * back, R, cue.z - dir.z * back);
    // lookAt points local +Z at the ball; rotating -90deg about X then swings
    // the stick's length (+Y) to trail away behind it. The small extra angle
    // lifts the butt slightly, the way a cue is actually held.
    const target = new THREE.Vector3(cue.x, R, cue.z);
    this.cue.lookAt(target);
    this.cue.rotateX(-Math.PI / 2 + 0.07);
  }

  // Tell the camera where it should be. With `follow`, it glides there once
  // and then tracks the goal exactly (used while the player is aiming).
  setCameraGoal(tx, tz, yaw, pitch, dist, follow) {
    const g = this.rig.goal;
    g.tx = tx; g.tz = tz; g.yaw = yaw; g.pitch = pitch; g.dist = dist;
    if (!follow) this.rig.locked = false;
    this.rig.follow = follow;
  }

  // Leave the camera where it is heading and stop tracking.
  holdCamera() {
    this.rig.follow = false;
    this.rig.locked = false;
  }

  updateCamera(dt) {
    const { cur, goal } = this.rig;
    // Shortest way round for the heading.
    let dyaw = goal.yaw - cur.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));

    if (this.rig.locked) {
      cur.tx = goal.tx; cur.tz = goal.tz; cur.yaw = goal.yaw;
      cur.pitch = goal.pitch; cur.dist = goal.dist;
    } else {
      const k = 1 - Math.exp(-dt * 7);
      cur.tx += (goal.tx - cur.tx) * k;
      cur.tz += (goal.tz - cur.tz) * k;
      cur.yaw += dyaw * k;
      cur.pitch += (goal.pitch - cur.pitch) * k;
      cur.dist += (goal.dist - cur.dist) * k;
      const settled = Math.hypot(goal.tx - cur.tx, goal.tz - cur.tz) < 0.004 &&
        Math.abs(dyaw) < 0.004 && Math.abs(goal.pitch - cur.pitch) < 0.004 &&
        Math.abs(goal.dist - cur.dist) < 0.004;
      if (settled && this.rig.follow) this.rig.locked = true;
    }
    this._applyCamera();
  }

  _applyCamera() {
    const c = this.rig.cur;
    const flat = Math.cos(c.pitch) * c.dist;
    this.camera.position.set(
      c.tx - Math.cos(c.yaw) * flat,
      R + Math.sin(c.pitch) * c.dist,
      c.tz - Math.sin(c.yaw) * flat
    );
    this.camera.lookAt(c.tx, R, c.tz);
  }

  sync(world) {
    for (const b of world.balls) {
      let mesh = this.ballMeshes.get(b.id);
      if (!mesh) mesh = this.makeBall(b.id);
      mesh.visible = b.active;
      if (b.active) mesh.position.set(b.x, R, b.z);
    }
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Raycast the pointer onto the table plane (y = R). Returns {x, z} or null.
  pickTable(ndcX, ndcY) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -R);
    const pt = new THREE.Vector3();
    if (ray.ray.intersectPlane(plane, pt)) return { x: pt.x, z: pt.z };
    return null;
  }

  render(dt = 0) {
    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  }
}

const TABLE_POCKET_VIS = TABLE.POCKET_R * 0.95;

// Build a sprite showing a ball's number.
function makeNumberSprite(n) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#111';
  g.font = 'bold 80px Arial';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(R * 0.7, R * 0.7, 1);
  return sprite;
}
