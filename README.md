# Carom — 3D Pool

A browser-based **3D pool (8-ball) game**, inspired by *Carom 3D*. Built with
[Three.js](https://threejs.org/) for rendering and a custom billiards physics
engine (sliding/rolling friction, spin/english, cushion banks, and pockets).

![Carom 3D Pool](docs/screenshot.png)

## Play

The game is fully self-contained — Three.js is vendored under `vendor/`, so no
internet connection or build step is required. You just need to serve the
folder over HTTP (ES modules don't load from `file://`).

```bash
# Option A: Python (built in on most systems)
python3 -m http.server 8080

# Option B: npm
npm start
```

Then open <http://localhost:8080> in a modern browser.

## Deploy

It's a fully static site with no build step, so it drops onto any static host.
`vercel.json` is included, which pins the "no build, serve the repo root" setup
and sets long-lived cache headers for the vendored Three.js.

```bash
# Vercel CLI — from the repo root
npx vercel        # preview deploy
npx vercel --prod # production
```

Or import the repo at [vercel.com/new](https://vercel.com/new) and accept the
defaults — Framework Preset **Other**, no build command, output directory `.`.

The same folder works unchanged on GitHub Pages, Netlify, Cloudflare Pages, or
any plain HTTP server.

## How to play

It's standard **8-ball**:

- **Aim:** click the table once to take the cue. The camera sits behind the
  cue with the cue ball in the center of the screen, and moving the mouse left
  or right swings your aim (and the camera) round the cue ball. Hold **Shift**
  for fine aiming.
- **View:** move the mouse forward or back to lower or raise the camera; the
  mouse wheel zooms.
- **Shoot:** **click** to lock your aim, then **pull the mouse back** to set
  power. Release to strike if you're holding the button, or click again if you
  let go. Clicking without a pull, or right-clicking, cancels the shot.
- **Spin (english):** arrow keys, or click inside the spin circle (bottom-left),
  set where the cue tip strikes the ball — top/bottom for follow/draw, sides
  for english.
- **Free the cursor:** **Esc** releases the mouse so you can use the buttons;
  click the table to take the cue again.
- **Ball in hand:** after a foul, click an open spot to place the cue ball.

Pocket all of your group (**solids** 1–7 or **stripes** 9–15), then sink the
**8-ball** to win. The table is *open* until the first ball is legally pocketed,
which assigns the groups.

**Fouls** (opponent gets ball in hand): scratching the cue ball, hitting the
wrong group first, or failing to drive any ball to a rail. Potting the 8-ball
early — or scratching on it — loses the game.

## Opponents

Play against the **computer** (default) or a second person hot-seat on the same
screen — toggle with the **vs Computer / 2 Player** button. The computer's
skill is set with the **AI: Easy / Medium / Hard** button, which controls how
much its aim can stray.

The AI (`js/ai.js`) plans with the *ghost-ball* method: for every legal ball
and pocket it computes where the cue must strike, scores the cut angle and
checks that both the cue's path and the object ball's path to the pocket are
clear, then plays the best pot it finds (or a safe contact shot if none). With
ball in hand it searches placements for an easy straight-in. It's a pure module
with no DOM/render dependencies, so it's unit-tested directly against the
physics engine.

## Project layout

```
index.html        Page shell, import map, HUD
styles.css        UI styling
js/physics.js     Headless billiards physics engine (no rendering deps)
js/ai.js          Headless shot-planning AI (no rendering deps)
js/scene.js       Three.js scene: table, balls, cue, camera rig, lighting
js/main.js        Game loop, input, AI turn controller, and 8-ball rules
vendor/three/     Vendored Three.js (module build)
```

The physics engine in `js/physics.js` has no dependency on Three.js or the DOM,
so it can be unit-tested directly under Node.

## Notes / ideas for later

- A true carom (three-cushion, pocketless) mode, closer to the original game.
- Smarter AI: position play (planning the next shot) and safety strategy.
- Number decals and reflections on the balls; sound effects.
