# Skia rework plan

Written 2026-11-13 for Claude Code sessions that pick this work up from the GitHub repo, with no access to the
owner's PC, earlier conversations, or local notes. Read all of it before changing anything, then start at the first
stage in the [status log](#status-log) that is not done.

## The goal

Superpencil draws designs with the browser: every node is a DOM element or an SVG shape (`src/render/NodeView.tsx`).
That is why it is slower than pen.dev on big files, and why it needs a pile of workarounds (snapshots of zoomed-out
frames, zoom-sized copies of pictures, sub-pixel alignment, redraw-on-zoom-out). pen.dev draws with Skia.

The rework moves canvas drawing to Skia (`canvaskit-wasm`, Skia's WebAssembly build) in stages. Each stage ships
behind a switch, leaves the current renderer working, and ends at a gate the owner checks on their own PC.

What "done" looks like: a file with about 320 top-level frames and 41,000 nodes pans and zooms smoothly at any zoom,
uses less memory than today, and looks the same as it does today.

## What you can and cannot do from a cloud session

| | In the cloud | Only on the owner's PC |
|---|---|---|
| Typecheck, build, package | Yes | |
| Browser tests (`tests/`) | Yes, with software graphics | |
| Correctness of layout and drawing | Yes: compare against the current renderer (see [testing](#testing)) | Final look check on real designs |
| Speed and memory | **No.** Headless Chrome in a container has no GPU; numbers there mean nothing | Yes, with the benchmark from stage 0 |
| The real VS Code webview | No | Yes |
| The owner's real design files | No (private, and never to be used for tests) | Copies only |

So: build correctness in the cloud, build the measuring tools in the cloud, and leave every speed or memory claim to a
gate. Never report a performance result measured in a container as a result.

## Rules (the owner's, not negotiable)

- Work on one branch (`skia-rework`, or the branch Claude Code on the web creates). Push only to that branch. Never
  push to `main`, never merge, never create a release or tag.
- Do not rebuild or commit `release/superpen.vsix`, bump the version in `package.json`, or edit the "What's new" part
  of `README.md` on the branch. Those happen at merge time on the owner's PC.
- The current renderer stays the default until the owner says otherwise. Everything new sits behind the
  `pen.renderer` switch (stage 0). A friend installs straight from `main`; nothing half-working may reach them.
- The UI must look and behave like pen.dev in VS Code. Do not redesign panels, shortcuts or tools as part of this.
- Agents never move the user's viewport unless asked. The benchmark (stage 0) runs only when the owner starts it and
  puts the view back.
- Roblox export is experimental and must never become the default way designs reach Roblox. Do not touch it here.
- AI Pen has no sign-in and no API keys: the MCP agent is the pen. Keep it that way.
- Design work goes through the built-in MCP tools, never ad-hoc helper scripts. (Test scripts in `tests/` are fine.)
- Measure before and after any performance change, and say plainly what was measured where.
- Report honestly: failing tests with their output, skipped steps as skipped, unverified things as unverified.
- Match the surrounding code: comment density, naming, exact-pinned dependency versions.

## How the editor works today

```
.pen / .spen JSON
  -> src/model/resolve.ts      variables, themes, component refs -> RNode tree (TreeBuilder, cached by node identity)
  -> src/render/NodeView.tsx   one DOM element per node; the browser does layout (flexbox), text, clipping, effects
  -> src/ui/Canvas.tsx         #pen-world (one CSS transform for pan/zoom); Roots mounts each top-level frame
```

Around that, the workarounds this rework should make unnecessary:

| File | What it does | Fate |
|---|---|---|
| `src/editor/lod.ts` | Below 33% zoom (`LOD_ZOOM`), far frames are shown as snapshot images, with smaller copies per zoom | Replaced in stages 1 and 3 |
| `src/render/rasterize.ts` | Makes those snapshots, and MCP screenshots/exports, by wrapping live DOM in an SVG `foreignObject` | Replaced in stages 3 and 4 |
| `src/render/imageLod.ts` | Zoom-sized copies of picture fills | Replaced in stage 4 by GPU mipmaps |
| `src/render/subpixel.ts` | Corrects Chrome's whole-pixel snapping of SVG shapes | Unneeded in stage 4 |
| `src/editor/culling.ts` | `content-visibility` culling, unloading far frames, redrawing the layer on zoom-out | Shrinks in stage 4 |
| `src/render/pixels.ts` | Refuses blank snapshots (GPU canvases read back blank after a graphics hiccup) | Keep the idea: see context loss below |

Things that depend on the DOM renderer and must keep working at every stage:

- **Measuring.** About 80 calls to `getBoundingClientRect` / `worldRectOf` / `elementFromPoint` in 22 files, and
  about 70 lookups of `[data-k]` elements in 17 files: selection, snapping, gap handles, guides, comments, AI Pen,
  eyedropper, the layers panel, MCP tools. Every node's element carries `data-k="<node key>"`.
- **MCP tools** (`src/editor/agent.ts`, `extension/mcp.ts`): `screenshot`, `export_node`, `analyze_image`,
  `compare_to_reference`, `check_drawing`, `check_layout`, `ai_pen_draw`, `diagnose_editor` and the rest.
- **Text editing** (a `contentEditable` span inside the text node), **shader fills and effects**
  (`src/render/shaders.ts`, one shared WebGL engine, 30 fps cap), **script nodes** (Web Worker,
  `src/render/scripts.ts`), **browser nodes** (iframes), **prototype playback** (`src/ui/Present.tsx`),
  **performance mode** (`src/editor/perf.ts`, `perfLimits.ts`), **review mode, comments, lint, find and replace**.

Gotchas that have already cost time:

- **Import cycle:** `store -> diagnostics -> host -> agent -> ...`. Nothing in that chain may call `useStore` at
  module load (symptom: "Cannot access 'useStore' before initialization" and a blank editor). Subscribe lazily, as
  `review.ts` and `shaders.ts` do. Run `tests/errs.mjs` after any change to imports.
- Overlays that measure must do it in `useLayoutEffect`, never during render, or they lag one frame while zooming.
- Any view change must call `markUserViewChange()` / `viewChangeSource()` first or it is logged as unexpected.
- `TreeBuilder` caches by node identity. An unchanged frame keeps the same `RNode` object: use that as the cache key
  for anything derived from a frame (layout, pictures, textures).
- A background tab gets no animation frames. Anything an MCP call waits on uses `nextFrames`
  (`src/render/frames.ts`), not `requestAnimationFrame`.
- A debugger attached to the page (puppeteer) keeps a copy of every resource the page loads. Memory numbers taken
  that way are wrong. `tests/memory.mjs` measures without one (Windows only).
- GPU-backed canvases lose their contents when the graphics process restarts. Version 0.3.1 fixed frames going
  invisible because of exactly that. A Skia WebGL surface has the same weakness: see stage 0.

## Target design

```
RNode tree
  -> src/layout/     boxes for every node, computed in TypeScript (no DOM)
  -> src/skia/       paint: boxes + props -> one cached SkPicture per top-level frame
  -> one <canvas>    under the editor's overlays; redrawn only when the view or the design changes
```

Decisions already made, with reasons. Change one only if a stage proves it wrong, and write down why in the status
log.

1. **CanvasKit from npm (`canvaskit-wasm`), loaded lazily.** The wasm file is a Vite asset
   (`import url from 'canvaskit-wasm/bin/canvaskit.wasm?url'`, passed to `locateFile`). The webview's
   content-security policy (`extension/extension.ts`, `html()`) already allows it: `'unsafe-eval'` covers WebAssembly
   and `connect-src` covers fetching it. The current renderer must pay nothing for it when the switch is off.
2. **Layout in TypeScript, not Yoga.** The format's layout is a small subset of flexbox (listed in stage 2), and the
   current renderer can check every box. Add Yoga only if the comparison test finds a class of cases that cannot be
   matched.
3. **Text with Skia's paragraph API.** CanvasKit cannot see installed fonts: it needs font files. Google Fonts are
   fetched as files; one default font (Inter) ships with the extension so text always draws. A frame whose font
   cannot be loaded falls back to the current renderer.
4. **The current renderer stays** as the fallback when WebGL is unavailable or lost for good, as the reference the
   tests compare against, and for anything Skia does not draw yet. Fallback is per top-level frame: a frame is drawn
   by Skia only if everything in it is supported (`skiaEligible(frame)` returns the reason when it is not).
5. **A measuring seam before the switch.** All "where is this node" questions go through one module
   (`src/editor/measure.ts`) while it still asks the DOM; later it asks the layout tree instead. That turns the
   riskiest part of stage 4 into a one-file change.
6. **Every CanvasKit object is freed by hand** (`.delete()`): paths, paints, shaders, images, pictures, paragraphs.
   One helper owns lifetimes, and `diagnose_editor` reports the live-object count so leaks show up as a number.

## Stages

Each stage lists what to build, how to prove it in the cloud, and the gate. Do not start a stage whose previous gate
has not been passed, except that stage 2 (pure logic) may proceed while gate 1 is waiting on the owner.

### Stage 0: foundations (no visible change)

1. Add `canvaskit-wasm` at an exact version. Confirm `npm run package` puts the wasm in the vsix, and record the
   vsix size before and after (it is about 0.56 MB today; expect a few MB more).
2. `src/skia/kit.ts`: lazy loader. `src/skia/SkiaLayer.tsx`: a canvas inside `Canvas.tsx`, below the overlays,
   sized for the device pixel ratio, drawing only when something changed.
3. The switch: `localStorage` key `pen.renderer` = `dom` (default) | `overview` | `full`. Report it in
   `diagnose_editor`. No button yet.
4. Context loss: handle `webglcontextlost` / `webglcontextrestored` (rebuild the surface, re-upload textures;
   pictures live on the CPU side and survive). If Skia cannot start or recover, fall back to `dom`, log one line,
   show one toast. Frames must never go invisible.
5. The lifetime helper and the live-object count in `diagnose_editor`.
6. A benchmark the owner can run: a `benchmark` request in `src/editor/agent.ts`, exposed as an MCP tool. It plays a
   fixed zoom-out, zoom-in and pan on the open file, timing frames from inside the page (median, 95th percentile,
   worst), counts DOM elements, restores the view, and returns the numbers. It edits nothing.
7. `tests/make-big.mjs`: writes a synthetic design (seeded; N top-level frames of nested auto-layout, text, shapes,
   gradients, shadows and generated pictures) so big-file tests do not need anyone's real design.

Prove it: `tests/skia-smoke.mjs` (new) loads the editor with the switch on, draws a known rectangle, reads the
pixel back, forces a context loss with the `WEBGL_lose_context` extension and checks drawing recovers. Existing
suites unchanged with the switch off.

### Stage 1: overview on one canvas

With `pen.renderer=overview`, below `LOD_ZOOM` the far frames are drawn by Skia from the snapshots `lod.ts` already
makes: one texture per snapshot, GPU mipmaps, a least-recently-used byte budget (halved in performance mode via
`perfLimits()`).

- `Roots` (`src/ui/Canvas.tsx`) stops mounting `BitmapRoot` images for those frames but keeps an empty positioned
  element with the same `data-k`, so selection, labels, snapping and MCP lookups keep working.
- The scaled-copy work in `lod.ts` (`workLevels`) and the layer redraw in `culling.ts` (`reraster`) are skipped in
  this mode.
- Must still work: dragging a top-level frame while zoomed out, frames switching back to live progressively when
  zooming in (`tests/lodswitch.mjs`), performance-mode placeholders, and the guarantee from `tests/blank.mjs`: a
  failed upload or lost context shows the snapshot image instead, never nothing.

Prove it: `blank.mjs`, `lodswitch.mjs`, `stress.mjs`, `features.mjs` in `overview` mode on a `make-big` file, plus
a new check that every filled frame on screen has non-background pixels (reuse the sampling in `blank.mjs`).

**Gate 1 (owner's PC):** benchmark in `dom` and `overview` on a copy of a big real file, in real VS Code, with
performance mode off and on. Continue to stage 3 only if zoomed-out frame times and memory are clearly better. If
not, stop and write up why.

### Stage 2: layout engine and the measuring seam (no visible change)

**2a. `src/layout/layout.ts`.** Input: an `RNode` tree and a text-measuring function. Output: for every node, its
box in its parent's space and its world matrix. It must reproduce exactly what `boxStyle`, `BoxView`, `GroupView`
and `TextView` in `NodeView.tsx` ask the browser to do:

- Frames lay out `horizontal` (the default), `vertical` or `none`; `gap`, `padding` (1, 2 or 4 values),
  `justifyContent` (`start`, `center`, `end`, `space_between`, `space_around`), `alignItems` (`start`, `center`,
  `end`). No wrapping.
- Sizes are a number, `fill_container` or `fit_content`, the last two with an optional fallback in brackets
  (`parseSizing`). Fill on the main axis is `flex: 1 1 0` with a zero minimum; on the cross axis it stretches.
  Nothing else shrinks.
- Children of `layout: none` frames, and children with `layoutPosition: absolute`, sit at `x`, `y`.
- `fit_content` on a `layout: none` frame, and group sizes, come from `childExtent`.
- Rotation is counter-clockwise degrees about the top-left corner; `flipX` / `flipY` flip about the centre.
- Text: `textGrowth` `auto` (no wrapping, sized to content), `fixed-width` (wraps, height from content),
  `fixed-width-height`.
- `enabled: false` nodes take no space.

**2b. `tests/layout-diff.mjs`.** For every node of `tests/fixtures/features.pen`, `examples/showcase.spen` and a
`make-big` file, compare the computed box with the DOM's box. For this test the text-measuring function returns
the DOM's own measurement, so it checks layout logic alone. Tolerance 0.5 design px; print the worst offenders.

**2c. `src/editor/measure.ts`.** Move every DOM measurement and `[data-k]` lookup behind functions such as
`nodeRect(key)`, `nodeAtPoint(x, y)`, `nodesInRect(rect)`. Pure refactor, small commits, no behaviour change.

Prove it: `layout-diff` at zero offenders on all three files; `features.mjs` 20/20, `aipen.mjs` 16/16,
`drawcheck.mjs` 7/7, `stress.mjs` clean after the refactor.

### Stage 3: draw frames from the design

`src/skia/` painter: box and layout from stage 2, props to Skia calls, recorded as one `SkPicture` per top-level
frame, cached by `RNode` identity plus a font/picture epoch.

Coverage, in this order, each mirroring the named code so results match:

1. Boxes: fills (`fillToLayers` in `paint.ts`: colour, linear via `linearEndpoints`, radial, angular, the
   three-gradient approximation of mesh gradients, images with `cover` / `contain` / `stretch`, blend modes via
   `cssBlend`, fill opacity; the last fill paints on top), corner radii (single or four), clipping, opacity.
2. Strokes (`normalizeStroke`, `boxStroke`): inner / centre / outer, per-side widths, gradient strokes.
3. Effects (`shadowCss`): drop and inner shadows with spread, layer blur, background blur. In every case the
   blur's standard deviation (Skia's sigma) is the file's blur value divided by two.
4. Shapes (`ShapeView`, `geometry.ts`): ellipse (with inner radius and sweep), polygon, path (with `viewBox`), line;
   fill rule; stroke alignment by clip; caps and joins.
5. Text (`TextView`): family with Inter fallback, weight, italic, size, letter spacing, line height (a multiplier;
   use half-leading to match CSS), alignment, vertical alignment, underline, strikethrough, gradient text, text
   shadow. Font files: check early whether CanvasKit accepts the WOFF2 files Google Fonts serves to browsers; if it
   does not, fetch TTF files from another CDN already allowed by the content-security policy.
6. Icons (`IconView`): Lucide and Feather from their path data; Material Symbols and Phosphor are fonts and may stay
   unsupported at first.
7. Notes, prompts, context cards (`NoteView`).

Not drawn by Skia in this stage (the frame containing one falls back): shader fills and effects, script nodes that
are pending or failed, browser nodes, text in fonts that cannot be loaded, icon fonts.

Use it: in `overview` mode, eligible frames are drawn from their picture (rasterised once into a texture when far
out), so they never mount DOM or make a snapshot while far away. `diagnose_editor` reports how many frames are
eligible and the reasons for the rest.

Prove it: `tests/paint-diff.mjs` (new) renders each top-level frame both ways and scores them with `compare` from
`src/editor/imageTools.ts` (it ignores one pixel of anti-aliasing). Set a threshold per category; text will not be
pixel-identical, so also assert line counts and box sizes match. Keep a folder of side-by-side images for the owner
to look at.

**Gate 2 (owner's PC):** on copies of real designs, the share of eligible frames (aim for nine in ten), a side-by-side
look check, the benchmark, and memory with `tests/memory.mjs`. Stage 4 only starts on a clear yes.

### Stage 4: everything on the canvas

With `pen.renderer=full`, near frames are drawn by Skia too.

- `measure.ts` answers from the layout tree. Hit testing respects clipping, rotation and draw order.
- Text editing: a DOM editor laid over the node while it is being edited; Skia skips that node's text meanwhile.
- Shaders: the existing engine renders to its own canvas; bring that in as a texture each frame (keep the 30 fps cap
  and performance-mode limits). Converting user GLSL to Skia's shading language is out of scope.
- Browser nodes stay DOM elements laid over the canvas.
- Pictures: decode at a capped size, upload with mipmaps, keep the byte budget and the "sharp only near the
  viewport" policy. This replaces `imageLod.ts`.
- MCP `screenshot` / `export_node`, the eyedropper and prototype playback draw through Skia; `rasterize.ts` remains
  for fallback frames.
- AI Pen replay, selection, guides, comments and every overlay keep working unchanged (they sit above the canvas and
  go through `measure.ts`).

Prove it: every suite passes in `full` mode. Run `stress.mjs` with a large step count on a `make-big` file.

**Gate 3 (owner's PC):** the owner uses `full` for real work, and the friend with a 16 GB machine tries it.

### Stage 5: make it the default, then clean up

Only on the owner's say-so: add the switch to the UI, flip the default, and remove what is no longer used, one
removal per commit, asking before each (`lod.ts`, `imageLod.ts`, `subpixel.ts`, most of `culling.ts`). The current
renderer itself stays as the fallback.

## Known risks

| Risk | Why it matters | Where it gets answered |
|---|---|---|
| CanvasKit's baseline memory | The friend's machine has 16 GB; performance mode exists for it | Gate 1 |
| Text does not match the browser | Line breaks moving between renderers would shift layouts | Stage 3 tests, gate 2 |
| Fonts installed only on the PC | CanvasKit cannot use them; `queryLocalFonts` is probably unavailable in a webview | Stage 3 (fallback), check at gate 2 |
| Emoji and missing glyphs | Skia needs fallback font files named explicitly | Stage 3; load on demand |
| Drawing 41,000 nodes per frame may still be slow far out | May need per-frame textures even with Skia | Gate 1 and stage 3 |
| Context loss | Same failure as the 0.3.1 invisible-frames bug | Stage 0, tested |
| WebAssembly object leaks | Nothing is garbage-collected | Live-object count from stage 0 |
| Download size | 0.56 MB today | Recorded in stage 0 |

## Testing

```
npm install
cd tests && npm install && cd ..
mkdir -p /tmp/pen && cp tests/fixtures/features.pen examples/showcase.spen /tmp/pen/
PEN_NO_OPEN=1 node start.mjs /tmp/pen &          # editor at http://127.0.0.1:5178/?file=features.pen
node tests/errs.mjs     "http://127.0.0.1:5178/?file=features.pen"            # page errors on load
node tests/features.mjs "http://127.0.0.1:5178/?file=features.pen"            # expect 20 PASS
node tests/aipen.mjs    "http://127.0.0.1:5178/?file=features.pen" /tmp/shots # expect 16 PASS
```

The tests need a Chromium-based browser. `tests/browser.mjs` finds Edge or Chrome, or takes `PEN_BROWSER`; in a
container, `npx @puppeteer/browsers install chrome@stable` and point `PEN_BROWSER` at the binary. If the container
cannot download a browser, say so in the status log and rely on typecheck and build until the owner can run the
suites. `tests/README.md` lists every script. Always copy a fixture before opening it: several tests edit the file.

The reference for "correct" is the current renderer. Two comparison tests carry the rework: `layout-diff` (stage 2)
and `paint-diff` (stage 3). Look at the images they write; layout bugs are often only visible there.

`features.mjs` and `aipen.mjs` import `/src` modules, so they need the dev server, not `PEN_PROD=1`.

## Handing work back

At the end of every session: push the branch, then add an entry to the status log below with what was finished,
what the tests showed (with numbers), what is next, and anything the owner must check on their PC. The next session
starts with no memory of this one; the log is all it has.

For a gate, write the exact steps for the owner in the log entry: which branch, which switch value, which benchmark
to run, what to look at. The owner builds and installs with `npm run package` and
`code --install-extension release\superpen.vsix --force`, then reloads the window.

## Status log

| Date | Stage | State | Notes |
|---|---|---|---|
| 2026-11-13 | Plan | Written | Nothing built. `main` is at 0.3.1. Tests moved from the owner's PC into `tests/`. Next: stage 0. |
| 2026-11-18 | 0 | Done (cloud) | See the stage 0 notes below. Next: stage 1 (and the owner's `dom` baseline benchmark, below). |
| 2026-11-19 | 1–4 | Done (cloud) | Owner asked for every stage at once; gates 1–3 become one check on the PC. See the stages 1–4 notes below. Next: the owner's combined gate, then stage 5 on their say-so. |
| 2026-11-19 | Gate (owner's PC) | Started; full mode tuned | First benchmarks on the owner's PC, then a tuning pass there. See the gate notes at the end. Next: the owner re-runs the benchmark on the tuned build, then memory and the look check. |

### 2026-11-18, stage 0 notes

Built on `skia-rework`:

- `canvaskit-wasm` 0.42.0 (exact). Default build: has the paragraph (text) API and WebGL surfaces. The wasm is a
  separate Vite asset (7.0 MB raw); `canvaskit.js` is its own 120 KB chunk. **vsix 0.56 MB → 3.4 MB**
  (558,747 → 3,563,140 bytes). The main bundle grew by about 7 KB. The build prints two harmless warnings: Vite
  externalises `fs` and `path`, which `canvaskit.js` only uses under Node.
- `src/skia/renderer.ts` (switch: `localStorage['pen.renderer']` = `dom` | `overview` | `full`, failure → `dom`
  for the session), `kit.ts` (lazy loader), `lifetime.ts` (`own` / `free` / `Scope`, live count),
  `SkiaLayer.tsx` (canvas first child of `#pen-canvas`, under `#pen-world` and the overlays; device-pixel sized;
  draws only on view change or `requestDraw`; context loss → surface rebuilt on restore, or after 5 s without a
  restore: fallback to `dom`, one log line, one toast). Today it draws nothing but test rectangles
  (`setDebugRects`).
- `diagnose_editor` → `renderer: { requested, active, failure, skia: { surface, size, dpr, draws, lastDrawMs,
  contextLosses, restores, liveObjects } }`.
- `src/editor/benchmark.ts` + `benchmark` MCP tool (read-only; refuses in a background tab; stops by 45 s for the
  bridge's 60 s limit; restores the view).
- Tests: `tests/skia-smoke.mjs` (new), `tests/make-big.mjs` (320 frames → 40,384 nodes, seeded, deterministic).
- `src/editor/ops.ts`: `propsRect` is now exported (benchmark uses it).

Tests in the cloud (Chromium 1243 headless, software graphics, `PEN_BROWSER=/opt/pw-browsers/chromium`):

| Suite | Before (main) | After (switch off) |
|---|---|---|
| errs | 0 errors | 0 errors |
| features | 20/20 | 20/20 |
| aipen | 16/16 | 16/16 |
| drawcheck | 7/7 | 7/7 |
| subpixel | 1/1 | 1/1 |
| hiddentab (features.pen) | not run | 6/6 |
| blank (make-big file) | 6/7 | 6/7, same failure |
| stress (make-big file, 80 steps) | not run | 0 page errors, 0 unexpected view changes |
| skia-smoke (new) | | 11/11 |

- `blank` check "pictures fall back to the original" fails on `main` too with the make-big file: at 5% zoom every
  frame is a snapshot, so no live picture fill is on screen to fall back. It needs a file whose frames stay live
  zoomed out (e.g. remote pictures). Not a regression; `make-big` can't produce that yet.
- The benchmark ran in both `dom` and `overview` on the make-big file: view restored, no unexpected view changes, no
  page errors. Its numbers in the container are software rendering and mean nothing; none are recorded here.
- Gotcha: editing `src/` while the dev server runs makes Vite import modules with `?t=` timestamps, so a test's own
  `import('/src/editor/store.ts')` gets a second store and `features` fails "edits while a state is shown go to the
  state" (19/20). Restart `start.mjs` before running suites after editing.
- Seen once, not investigated: an MCP `screenshot` of a frame taken while the view was at 4% zoom came back without
  its picture fills (the same frame live at 100% shows them). Existing renderer behaviour, container only so far.

For the owner (no gate yet; this records the `dom` baseline gate 1 will compare against):

1. `git fetch && git checkout skia-rework`, `npm install`, `npm run package`,
   `code --install-extension release\superpen.vsix --force`, Reload Window. (Don't commit the rebuilt vsix.)
2. Open a **copy** of the big real file, select it in a Claude Code chat, keep the editor tab visible and ask:
   "run the benchmark". Do it with performance mode off and on. Keep the numbers (paste them into this log).
3. Optional check that Skia starts on the real GPU: in the webview devtools console,
   `localStorage.setItem('pen.renderer','overview')`, Reload Window, then ask Claude for `diagnose_editor`:
   `renderer.skia.surface` should be `ready`. Nothing looks different yet. Set it back with
   `localStorage.removeItem('pen.renderer')`.

### 2026-11-19, stages 1–4 notes

**Decision (owner, 2026-11-18):** build stages 1–4 in one go in the cloud and test everything at once on the PC,
instead of stopping at gates 1 and 2. So gates 1–3 are now one combined check on the owner's PC (steps at the end).
`dom` stays the default; nothing here changes behaviour unless `pen.renderer` is set. Stage 5 (UI switch, default flip,
cleanup) still waits for the owner's say-so.

How it was built: three parallel workers (stage 1, stage 2a/2b, stage 2c) in separate worktrees, merged into
`skia-rework`; stages 3 and 4 on top. Commits are on the branch; the merge commits name each stage.

**Stage 1 (overview).** `src/skia/scene.ts`: Roots registers zoomed-out frames; each snapshot lod.ts makes becomes one
mipmapped texture (LRU budget 256 MB, 128 MB in performance mode); an empty `<div data-k data-bitmap data-skia>`
keeps the frame's place. Snapshot `<img>` whenever a texture isn't ready, failed, or the surface is lost. Scaled
snapshot copies and the halving re-raster are skipped in overview. `?renderer=` URL knob in test builds only.

**Stage 2a/2b (layout).** `src/layout/layout.ts` (+ `measureText.ts`): the format's flexbox subset in TypeScript, API as
planned plus an optional `{ doc }` (props hold unresolved `$variables`). `MeasureText` contract: `w` is shrink-to-fit
`min(max-content, max(min-content, maxWidth))`. Chrome behaviours reproduced (found by the diff): auto-width rows give
fill items their max-content then share free space; fill-height items in auto columns are 0 tall; `space_around` with
negative free space starts at the beginning; flexed sizes floor to 1/64 px; absolute auto widths shrink to fit.
`tests/layout-diff.mjs`: **0 offenders** (0.5 px) on features.pen (14 nodes), new `fixtures/layout.pen` (254),
showcase.spen (279), make-big 40 frames (5,000) and 320 frames (40,384). `layoutAll` on 40,384 nodes: 122 ms cold,
5 ms cached (container).

**Stage 2c (measure seam).** `src/editor/measure.ts`: every node-geometry and `[data-k]` lookup behind one module;
`ops.ts` keeps `elFor`/`worldRectOf`/`screenRectOf`/`canvasRect`/`clientToWorld` as aliases. Still DOM on purpose:
culling's own root rects, lod's off-screen staging host, rasterize clones, diagnostics, Present, ShaderLayer internals.

**Stage 3 (painter).** `src/skia/painter.ts` mirrors NodeView/paint.ts: fills (last on top; colour, linear, radial —
CSS rules on boxes, SVG rules with rotation on shapes —, angular, the mesh approximation, image cover/contain/stretch,
blend modes isolated per box), corner radii, outer/inset box-shadows, background blur, clip, opacity layers, outline
and masked strokes, shapes (ellipse/polygon/path/line, fill rules, inner/centre/outer strokes, caps, joins), Lucide and
Feather icons as paths (`icons.ts`), notes, text via paragraphs. Decisions:
- Filter drop-shadows (groups, shapes, icons) use sigma = blur / 4, because the DOM renderer passes blur / 2 to CSS
  `drop-shadow()` (whose value is a radius): matching today's look won over the plan's "sigma = blur / 2" here. Box and
  text shadows and blur effects are blur / 2.
- Fonts (`fonts.ts`): CanvasKit 0.42 reads WOFF2, so Google Fonts CSS is used as browsers get it. Every weight/style of
  a family is registered under its own alias (Google's static instances can all report the same weight, which made
  Skia draw 400 text with an 800 file). Family list: exact style, then the bundled Inter at the nearest weight, then
  other weights only for missing glyphs. Inter 400–800 + 400 italic (latin, `@fontsource/inter` 5.3.0, 120 KB) ship
  with the extension. All unicode subsets of a weight are fetched (could be lazier).
- Paragraphs: rounding hack off; `line-height: normal` = the font's rounded ascent + descent, as Chrome computes it
  (Skia's default was ~0.6 px short per line). One paragraph per text node, shared by measuring and drawing.
- Pictures (`images.ts`): decoded once at the snapshot size cap (2048, 1024 in performance mode), CPU-side.
- `skiaEligible()` keeps a whole top-level frame on the DOM renderer for: shader fills/effects, script nodes not `ok`,
  browser nodes, icon fonts (Material Symbols, Phosphor), system fonts, fonts or pictures still loading, unknown node
  types. `diagnose_editor` → `renderer.skia.pictures.reasons` counts them.
- `tests/paint-diff.mjs` (frame by frame, Skia vs the DOM screenshot, `compare()` from imageTools):
  features.pen 2/2 frames 100 % (boxes from the DOM and from the layout engine); showcase Components 99.99 %;
  showcase page 94.8 % (DOM boxes) / 93.3 % (engine) — the gap is the two GPU-shader areas, and that frame stays on
  the DOM renderer anyway (reason "shader fill"); make-big, 20 frames, engine layout: 100 % average, 20/20 ≥ 95 %.

**Stage 4 (full).** With `pen.renderer=full`, every frame Skia can draw gets an empty `<div data-k data-skia
data-picture>` and is drawn from its recorded picture at any zoom (`pictureFrames.ts`); below 33 % zoom from a copy
rasterised once per zoom level (`pictureTextures.ts`, 192 MB budget). Pictures are recorded only when drawn, ~12 ms of
recording per draw, the frame's colour shown meanwhile. Layout is computed per frame on demand. `measure.ts` gets
runtime hooks (`setSkiaGeometry`): rects, sizes and the node chain under the pointer come from the layout tree
(draw order, clipping, rotation); DOM-drawn frames and overlays still win. Simplifications against the plan:
- Text editing, agent screenshots/exports (the frame is pinned live), AI Pen replay, shaders and browser nodes make the
  whole frame DOM while they apply, instead of a DOM overlay or a texture inside a Skia frame.
- Prototype playback (Present) keeps its own DOM, as before.
- Everything Skia holds (pictures, paragraphs, textures, fonts, decoded pictures) is freed when the layer goes away.

Tests (container, Chromium 1243 headless, software GL, own dev server restarted after edits):

| Suite | dom | overview | full |
|---|---|---|---|
| errs (showcase) | 0 errors | 0 errors | 0 errors |
| features | 20/20 | 20/20 | 20/20 |
| aipen | 16/16 | 16/16 | 16/16 |
| drawcheck | 7/7 | 7/7 | 7/7 |
| subpixel | 1/1 | 1/1 | 1/1 |
| hiddentab | 6/6 | 6/6 | 6/6 |
| stress (make-big, 150 steps) | 0 page errors, 0 unexpected view changes, no issues | same | same |
| blank (make-big) | 6/7 (known, as on `main`) | 5/7 ¹ | 5/7 ¹ |
| skia-smoke | 11/11 | | |
| overview.mjs | | 12/12 | |
| full.mjs (new) | | | 14/14 |

¹ The extra failure, "blank copies are detected", sabotages lod.ts's scaled snapshot copies, which overview and full
don't make (Skia mipmaps / picture copies replace them); worker A saw the same in stage 1. "Frames stay visible"
passes under every kind of sabotage in all three modes.

`set_renderer` checked live: full → overview → dom → full, each active at once (Skia canvas mounted or not, picture
frames 2 → 0 → 0 → 2 on features.pen), 0 page errors.

- `features.mjs` is now renderer-neutral (boxes via measure.ts; colours from the element, or the screen pixel for
  Skia-drawn layers). `overview.mjs` counts picture copies and decoded pictures among the live images.
- Memory bug found and fixed on the way: every paragraph had its own font collection (~5 MB per frame with Google's
  Inter subsets), so zooming out over the 320-frame file hit CanvasKit's 2 GB heap and aborted (blank frames, and in
  full mode the editor crashed). One shared FontCollection now: 120 recorded frames keep the heap at 128 MB. A
  CanvasKit failure while preparing or drawing frames, or an uncaught `Aborted(`, now falls back to `dom`.
- layout-diff after the merge: 0 offenders on features.pen, fixtures/layout.pen, showcase.spen and make-big (40,384 nodes); `layoutAll` 166 ms cold, 8 ms cached (container).
- Package: vsix 0.56 MB (main) → 3.7 MB (3,729,068 bytes): CanvasKit wasm 7.3 MB raw, its JS 120 KB, six Inter
  WOFF2 files ~146 KB; the main editor bundle grew 52 KB (1.50 → 1.55 MB). `.claude/**` added to `.vscodeignore`
  (vsce picked up local worktrees; on the PC it would ship Claude Code's local settings).
- New MCP tools: `benchmark` (stage 0) and `set_renderer` (dom / overview / full, live, only when the user asks).

Not measured (needs the owner's GPU): any speed or memory number. In software rendering, first recording costs about
200 ms per make-big frame (container CPU), so a full-mode zoom-out over 320 unseen frames fills in over ~80 s here;
expect it to be several times faster on a real machine, but that is exactly what the combined gate must check.

For the owner — the combined gate (gates 1–3 in one sitting, on copies of real files):

1. `git fetch && git checkout skia-rework`, `npm install`, `npm run package`,
   `code --install-extension release\superpen.vsix --force`, Reload Window. Don't commit the rebuilt vsix.
2. Switching renderers: Command Palette → "Developer: Open Webview Developer Tools", Console:
   `localStorage.setItem('pen.renderer','full')` (or `'overview'`, or `removeItem` for `dom`), then close and reopen
   the design. Or ask Claude to call `set_renderer` (it switches live). `diagnose_editor` → `renderer` confirms it.
3. For each of `dom`, `overview`, `full`, with performance mode off and on, on a copy of the big file: ask Claude
   "run the benchmark" (editor tab visible). Paste the numbers here.
4. Memory: `node tests/memory.mjs "<url>" [perf]` (Windows) in each mode, or Task Manager's GPU/process memory.
5. Look: in `full`, check text (wrapping, weights), shadows, gradients, pictures, icons look the same as `dom`, and
   `diagnose_editor` → `renderer.skia.pictures` (how many frames Skia draws, and why the rest fall back; aim: 9 in 10).
6. Use `full` for real work for a while: select, drag, resize, edit text, comments, AI edits, undo. Then the friend
   on the 16 GB machine tries it.
7. If anything is off, the fallback is `localStorage.removeItem('pen.renderer')`.

### 2026-11-19, gate notes (owner's PC) and the tuning pass

Machine: RTX 4090, 175 Hz screen (a frame is 5.7 ms), VS Code 1.146. File: a copy of the owner's big design with every
section shown (319 top-level frames, 22,288 nodes, 107 pictures). Performance mode off. `benchmark` tool, canvas
896×1268, warmed-up runs (two each for `dom` and `overview`, one for `full`); "slow" is a frame over 33 ms.

| | `dom` | `overview` | `full` |
|---|---|---|---|
| Zoom out: slow frames of 120 / worst | 2–5 / 57–63 ms | 10–12 / 91–97 ms | 1 / 34 ms |
| Zoom in: slow frames of 120 / worst | 2–3 / 749–846 ms | 4–8 / 520–634 ms | 0 / 17 ms |
| Pan at 50%: slow frames of 120 / worst | 0–4 / 29–40 ms | 4–5 / 40–46 ms | 0 / 5.9 ms |
| Elements on the page at 50% | 41,265 | 41,266 | 560 |

- `full`: 315 of 319 frames drawn by Skia (3 shader fills, 1 script error fall back). Clearly better than `dom`.
- `overview` is slightly worse than `dom` on zoom-out. It is a stepping stone; it has not been tuned.
- With the owner's usual hidden sections (61 frames shown) `dom` already runs at the screen's refresh rate: the
  difference only shows on the whole file.
- Not done yet: performance mode on, memory (`tests/memory.mjs`), the look check, real use, the 16 GB machine.

**Tuning pass** (same day, on the PC; measured with the new `tests/skia-prof.mjs`, headless Edge on the same RTX 4090,
`PEN_PROD=1`, 1400×1000). What the profile showed, and what changed:

| Found | Change |
|---|---|
| Every font or picture that arrived re-recorded every frame with text or pictures: 611 recordings for 315 frames | Each frame tracks the font styles and picture URLs it uses (`FrameDeps`, collected by `skiaEligible`); `fontStamp` / `imageStamp` re-record only the frames that depend on what arrived. Text with characters outside the bundled Inter's range still depends on every font |
| Once a draw's time budget was used up, frames whose picture and copy already existed were drawn as their flat colour: 27,780 placeholder draws in two benchmark runs | `peek()` returns an existing picture without work; a frame is drawn from whatever it has (a copy, even a blurrier one) and only falls to its colour when it has nothing |
| A far-zoom copy was rasterised again at each of six zoom levels: 604 for 315 frames | One copy per frame, as a chain of halved levels, reused for every smaller zoom; made again only when the zoom needs more pixels |
| Copies were rasterised on the CPU: 5–9 ms each, up to 106 ms | Copies are drawn by the GPU into textures (`surface.makeSurface`). They die with the graphics context, so `SkiaLayer` drops them on loss and they are remade from the pictures |
| Resizing the editor rebuilt the graphics context (`MakeWebGLCanvasSurface`) | One `GrDirectContext` for the life of the WebGL context; a resize only replaces the surface |
| Skia's GPU cache limit (256 MB) was below what the file's pictures need once uploaded (about 350 MB): textures were purged and uploaded again while moving around | Limit 512 MB, 256 MB in performance mode (pictures at half size use about 185 MB). `diagnose_editor` → `renderer.skia.gpu` reports usage |
| The DOM snapshot maker kept working on frames Skia draws (253 queued) | `lod.ts` skips frames drawn from a picture (`drawsFromPicture`) |
| At startup every frame went through the DOM path (mounted, queued for a snapshot) until Skia, fonts and pictures were ready | Full mode shows such a frame as its own colour (`PendingRoot`) for up to 8 s instead of building its DOM |
| Nothing was prepared before it was needed | In idle time (`requestIdleCallback`, not while the view or pointer moves) pictures are recorded and a small copy made, nearest the view first |
| Hover asked every drawn frame for its layout | `chainAt` only looks at frames whose box, or recorded picture bounds (`cullRect`), contain the point |
| Pictures of deleted frames were never freed (`pruneFrames` had no caller) | Roots prunes on every render |
| | Pictures are recorded with `computeBounds` (a spatial index: zoomed in, only what is on screen is replayed) |

Same file, `full`, performance mode off, before → after:

| | Before | After |
|---|---|---|
| Cold run, zoom out: slow frames / worst | 10 / 80 ms | 0 / 29 ms |
| Warm run, zoom out: p95 / worst | 28.7 / 57 ms | 11.5 / 11.5–17 ms |
| Warm run, zoom in: p95 / worst | 28.5 / 51 ms | 11.5 / 11.5 ms |
| Pan zoomed out: median | 11.4 ms | 5.7 ms |
| Pictures recorded for 315 frames | 611 | 318 |
| Far-zoom copies made | 604 | 318 |
| Placeholder draws over two runs | 27,780 | 3,105 |
| DOM snapshots queued | 253 | 0 |

Suites after the pass (dev server, headless Edge): features 20/20, aipen 16/16 in `dom`, `overview` and `full`;
skia-smoke 11/11; overview 12/12; full 14/14; drawcheck 7/7, subpixel 1/1, hiddentab 6/6 in `full`; layout-diff 0
offenders (features, layout, showcase); stress (make-big, 120–150 steps) clean in all three modes; blank 6/7 in `dom`
and 4 pass + 2 skipped + the same known failure in `overview` / `full`.

Behaviour that changed, and the tests that say so:
- With Skia on, no DOM snapshot exists for a frame Skia draws. If the graphics context is lost, such a frame shows its
  own fills until Skia is back or the DOM renderer takes over (it used to show a snapshot). `overview.mjs` accepts
  either; `blank.mjs` skips its two snapshot-detection checks in Skia modes.
- `start.mjs` resolves its own folder to the on-disk path. Started from a lower-case `c:` on Windows, the dev server
  served the app under `/@fs/` URLs, and tests importing `/src/...` got second copies of modules (store, measure).

Still open: the first GPU use of a big picture uploads it (tens of ms; now mostly spent in idle time); decoded
pictures take 243 MB of WebAssembly memory on this file (126 MB in performance mode), all loaded at startup because
eligibility needs to know they exist; `overview` mode is untuned.
