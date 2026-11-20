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
| 2026-11-19 | Gate (owner's PC) | Memory fixed | Pictures in two sizes; `full` now uses less memory than `dom` in normal mode at every step. See the last section. Next: the owner tries it in VS Code, then the look check, real use and the 16 GB machine. |
| 2026-11-19 | 5 | Default switched (owner's decision) | Merged to `main` as 0.4.0 with `full` as the default; the `skia-rework` branch is gone. `dom` and `overview` stay selectable. The clean-up half of stage 5 is not started. See the last section. |
| 2026-11-20 | After 1.0.1 | Far-zoom speed fix (branch `far-zoom-perf`) | "About 10 fps at 2%": far-zoom copies drawn from shared atlas pages, frame labels moved as one box, and frames with outline-reading (`@sdf`) shaders on paths, or shaders with an error, now drawn by Skia (the friend's file). See the last section. Not merged. |

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

### 2026-11-19, tuned build measured in VS Code, and memory

`benchmark` in VS Code on the tuned build, same file and window, **performance mode on**, warmed-up runs:

| | `dom` | `full` |
|---|---|---|
| Zoom out: slow frames of 120 / worst | 1 / 40–46 ms | 0 / 28.5 ms |
| Zoom in: slow frames of 120 / worst | 0 / 17–23 ms | 0 / 17–23 ms |
| Pan at 50%: worst | 6–11 ms | 6 ms |

With performance mode on the two are close: `dom` gets there by unloading frames away from the view, `full` keeps all
315 drawn. `full` with performance mode off has not been re-run in VS Code on the tuned build yet.

Found there: idle pre-recording barely ran in VS Code's webview (12 frames in 12 s; a few seconds for all 315 in
headless Edge). `requestIdleCallback` only fired on its timeout. It now runs in 5–10 ms slices on a timer while the
view and pointer are still.

**Memory** (`tests/memory.mjs`, plain Edge 1920×1080, no debugger, same file, performance mode off; process memory
in MB as total / renderer / GPU process):

| Step | `dom` | `full` |
|---|---|---|
| Opened, fit to screen | 1,021 / 579 / 219 | 1,615 / 653 / 864 |
| Zoomed to 100% | 1,150 / 617 / 255 | 1,667 / 594 / 964 |
| Zoomed to 50%, panned | 1,104 / 564 / 287 | 1,561 / 616 / 836 |
| Zoomed out to 12% | 1,037 / 509 / 274 | 1,563 / 610 / 840 |
| Same, 45 s idle | 885 / 357 / 272 | 1,506 / 562 / 839 |

`full` uses 500–600 MB more, nearly all of it in the GPU process. This fails the goal ("uses less memory than
today"). Cause: every picture fill of the file is decoded at up to 2048 px at startup (243 MB in WebAssembly memory),
and making even a thumbnail-sized far-zoom copy of a frame uploads its pictures to the graphics card at full size,
where the 512 MB cache keeps them. Performance mode (pictures at half size) not measured yet.

Planned fix, not built: two tiers of pictures. A small copy of each picture (256 px or so) loaded at startup and used
for eligibility and for every far-zoom copy; the full-size picture decoded only when a frame is seen up close, kept in
a least-recently-used budget, with the frame drawn from the small ones until it arrives.

`tests/memory.mjs` used to stay alive for 15 minutes after a run ended (the losing timer of a `Promise.race`); fixed.

### 2026-11-19, pictures in two sizes (the memory fix)

Built the planned fix, on the owner's PC. `src/skia/images.ts` now keeps each picture in two sizes:

- **Small** (256 px on the longest side), decoded as soon as a frame asks. It decides eligibility, and it is all a
  zoomed-out frame and every ahead-of-need copy uses.
- **Larger**, only while a frame in view shows the picture bigger than the small version: sizes double from 512 px up
  to the original or the decode limit (2048 px, 1024 px in performance mode). Dropped when nothing in view has needed
  it for 30 s, or least recently needed first over a 128 MB budget (64 MB in performance mode); never one that is on
  screen.

How it fits together:

| Piece | What it does |
|---|---|
| `painter.ts` `ImageUse` | A recording notes where it draws each picture and how long its longest side is there |
| `scene.ts` `noticeVisible` | 150 ms after the view stops, and every 5 s, tells each frame in view (plus a quarter of the view around it) its scale on screen. Not while moving: that would decode pictures that are only passing by |
| `frames.ts` `frameSeen` / `relaxFrames` | Turns that into `wantImage(url, pixels)`. A frame that shows a picture larger than its small version is marked `detail`: only those frames are recorded with larger versions, and again when one arrives or goes. 30 s after it was last seen that way a frame goes back to the small ones |
| `images.ts` | Decodes off the main thread, three at a time, small ones first. The swap to a Skia image copies pixels on the main thread, so it waits until the view and pointer have been still for 120 ms, one picture at a time |
| `pictureTextures.ts` `stalePictureCopy` | A frame's far-zoom copy is kept when its picture is recorded again and drawn until the new one is made: no flash of the frame's flat colour (this also covers edits made while zoomed out) |
| `SkiaLayer.tsx` | GPU cache limit 256 MB (160 MB in performance mode), down from 512 / 256. After 15 s without a draw the cache is emptied of what nothing holds (offscreen layers, shadow textures, uploaded pictures) by lowering the limit for a moment |

Geometry (`cover` / `contain`) is computed from the original's size whichever version is drawn, so a picture does not
shift when a sharper one arrives. Agent screenshots and exports copy the DOM, as before, so they never see a small
version.

**Memory**, same scenario as above (`tests/memory.mjs`, plain Edge 1920×1080, no debugger, the copy of the owner's big
design with every section shown; total process memory in MB):

| Step | `dom` | `full` before | `full` now | `dom`, performance mode | `full` now, performance mode |
|---|---|---|---|---|---|
| Opened, fit to screen | 1,021 | 1,615 | 897 | 853 | 827 |
| Zoomed to 100% | 1,150 | 1,667 | 1,002 | 890 | 860 |
| After panning at 100% | 1,076 | 1,518 | 811 | 850 | 762 |
| Zoomed to 50%, panned | 1,104 | 1,561 | 875 | 942 | 807 |
| Zoomed out to 12% | 1,037 | 1,563 | 877 | 943 | 828 |
| Same, 45 s idle | 885 | 1,506 | 831 | 732 | 777 |

`full` is now below `dom` at every step in normal mode (it was 500–600 MB above), and at every step but the idle one
in performance mode (45 MB above). What is left is the GPU process: about 385 MB in `full` against 220–290 MB in
`dom`, of which Skia's own cache is 14–130 MB and the copies 13–21 MB; the rest is what a WebGL context of this size
costs. The renderer process is 100–250 MB smaller in `full`.

Behind those totals (`tests/skia-mem.mjs`, same file): decoded pictures 16.5 MB for all 107 (was 243 MB), plus
7–16 MB in 1–4 larger versions while zoomed in; GPU cache 49 MB after opening, 127–131 MB while moving around, 14 MB
after 45 s idle (was 353 MB).

**Speed** (`tests/skia-prof.mjs`, as in the tuning pass): unchanged. First run after opening: zoom out 0 slow frames,
worst 28.6 ms; warmed up: zoom out and in p95 11.5 ms, worst 17.2 ms; pan at 50% 5.8 ms.

Found on the way:
- The owner's file shares a few pictures between about 200 frames. When a larger version arrived, every one of those
  frames was recorded and copied again (684 recordings in the scenario). With the per-frame `detail` mark it is 338.
- Skia's GPU cache kept 146–171 MB of textures nothing was using while the editor sat still; hence the idle purge.

Suites on the final code (dev server, headless Edge): features 20/20 and aipen 16/16 in `dom`, `overview` and `full`;
skia-smoke 11/11; overview 12/12; full 14/14; the new `sharpen.mjs` 11/11; drawcheck 7/7, subpixel 1/1, hiddentab
6/6 in `full`; stress clean in all three modes and on a file with 2048 px pictures; paint-diff on that file 99.98%.
`layout-diff.mjs` and `blank.mjs` not re-run (layout and the snapshot path are untouched).

New in `tests/`: `sharpen.mjs` (the behaviour above; needs `make-big.mjs big2k.spen 60 3 12 2048`), `skia-mem.mjs`
(what Skia holds at each step of the memory scenario). `make-big.mjs` gives pictures over 512 px a fine checker
pattern so a test can tell sharp from blurry; files made with the default 512 px are unchanged.

What the user sees that is new: zooming in on a frame, its pictures are soft for a moment (typically 0.2–0.5 s after
the view stops) and then sharpen in place.

Still open:
- The swap to a Skia image is on the main thread (a few ms for a 1024 px picture, tens for 2048 px). It only happens
  while nothing moves; moving it to a worker would let pictures sharpen during a slow zoom.
- Not measured in VS Code yet (these are headless and plain-Edge numbers), nor on the 16 GB machine.
- `overview` mode is still untuned.

### 2026-11-19, merged to main as 0.4.0, `full` is the default

The owner tried the build with two-size pictures, called it good and asked for it to become the main version:
`skia-rework` was fast-forwarded into `main`, `full` made the default (`DEFAULT` in `src/skia/renderer.ts`), the
version set to 0.4.0, and the branch deleted. The rules near the top of this file about the branch and the default
renderer describe the work up to here; from now on Skia work happens on `main` under the usual rules (ask before
pushing).

What was not done before the switch, by the owner's choice: the look check frame by frame in VS Code, a period of real
use, and the 16 GB machine. The safety net is the automatic fallback to `dom` when Skia cannot start or loses its
graphics context for good, and `set_renderer` (there is no button for it yet).

For tests: a URL without `&renderer=` now runs in `full`. The suites about the DOM renderer's own machinery need
`&renderer=dom` (tests/README.md).

Left of stage 5: nothing of the DOM renderer has been removed (`lod.ts`, `imageLod.ts`, `subpixel.ts`, `culling.ts`
are all still needed by `dom` mode, by frames Skia cannot draw, and by screenshots and exports). Removing any of it
waits until `full` has been the default for a while without reports.


### 2026-11-20, slow far out (about 10 fps at 2%): cause and fix

The report: a friend on a 16 GB PC with a large design, on 1.0.1: about 10 fps at 2% zoom (the whole design on
screen, as before 1.0.1), twice as fast as before at 9%, performance mode makes no difference. No file, frame count or
diagnostics from them. Branch `far-zoom-perf` (from `main` at `738601a`).

**Reproduced** on generated designs: `make-big.mjs` 600 frames (75,552 nodes), `make-shaders.mjs` 300 frames, and a
copy of it where half the frames use the animated `moving.glsl`. New script `tests/farzoom.mjs` (zoom to 2% and 9%,
wait until Skia stops drawing, then idle / 30 Ctrl+wheel zoom steps / 30 pans, counting long tasks, Skia draw time,
DOM changes, and the Skia counters). Container numbers (Chromium headless, SwiftShader): compare counts and long tasks,
not absolute frame times. With the processor slowed 4× (`PEN_CPU_SLOW=4`) the old code ran at 13 fps at 2%, close to
the report, and performance mode changed nothing, also as reported.

**Cause: drawing hundreds of separate far-zoom copies.** Far out each frame is drawn from its own small copy
(`pictureTextures.ts`), one texture per frame: one texture switch per frame per draw. Experiments at 2%, 600 frames:
Skia drawing 0 frames → 0 long tasks per 30 steps; 150 frames → 1; 600 frames → 30 (every step). The same 600 draws
all from one texture → 1 long task and 2 ms of Skia work per draw instead of 18 ms. So the cost is the number of
textures, not the pixels, React or the labels.

The theories in the brief, checked:
1. Frames handed to the DOM renderer: not it on these files. 150 of 300 frames with an animated shader go to the DOM
   renderer (reason "animated shader fill"); at 2% they are snapshots: panning 60 → 45 fps, 0–1 long tasks.
2. Frame labels: real but secondary. Not drawing Skia frames at all (labels and React still running) gave 0 long tasks
   on the normal processor; with the processor 4× slower the labels were about a third of what was left per pan step
   (fixed below).
3. Far-zoom copies over budget: not it. 600 frames at 2% use 4 MB of the 192 MB budget, 0 evictions, 0 replays.
4. No graphics card: cannot be checked here (no GPU in the container); still a question for the friend.

Also seen: for about 40 s after opening the 600-frame file, the close-up warm-up (`takeProgramStep`, 424 steps) redraws
the whole scene once per step, so far zoom is busy until it finishes (85 draws per 5 s, then 0). Not changed.

**Fixes** (speed only; same pixels):
- `src/skia/farAtlas.ts`: far-zoom copies are packed into up to four 2048-px atlas pages (two in performance mode,
  16 MB each on the graphics card) and drawn with one `drawAtlas` per page. Packing waits until the view is still
  (scene's settle timer): packing during a pan made the graphics context copy the whole page every draw, which first
  made 9% panning slower than before (7–8 long tasks vs 1–4); deferred, it is back to parity. Copies not packed yet,
  too large (> 512 px), or with no room are drawn on their own as before; anything drawn another way flushes the
  queued sprites first, so frame order is kept. Pages are cleared and refilled when full.
- Frame labels (`Canvas.tsx` Overlay): placed relative to the view's origin in one box translated by the view's
  offset, each label memoized, so a pan changes one style instead of 600. A `will-change` layer on the box made zoom
  9% slower and was dropped.
- `diagnose_editor`: `renderer.skia.drawMs` / `sceneMs` (time spent drawing) and `overview.atlas` (pages, slots,
  packed, resets, unpacked).

**Numbers** (600 frames, 2%, 30 steps each, before → after; two runs each where shown):

| | Before | After |
|---|---|---|
| Zoom: long tasks | 29, 29 | 0, 0 |
| Pan: long tasks | 30, 30 | 0, 2 |
| Skia draw time (30 draws) | 386–552 ms | 35–42 ms |
| Page frame rate (zoom / pan) | ~35 / ~35 fps | ~54 / ~56 fps |
| Processor 4× slower: frame rate | 13 / 12 fps | 19–24 fps |
| Processor 4× slower: Skia draw time | 2,129 ms | 150–180 ms |
| Processor 4× slower: pan long tasks | 6.3 s | 3.0–3.2 s |
| Performance mode: zoom long tasks | 30 | 0 |
| 9%: Skia draw time | 114–141 ms | 78–90 ms |
| 9%: long tasks (zoom / pan) | 15, 9 / 4, 1 | 10, 13 / 1, 3 (same range) |

**The friend's own file: shaders that read a path's outline.** After the above, the friend found it in their file:
28 frames with shaders do the damage. `lod.ts` never snapshots a frame that contains a shader, and Skia handed those
frames to the DOM renderer, so all 28 kept 3,875 nodes and 840 shader canvases live at every zoom. 811 of the canvases
are paths filled with chrome, steel, slate, halftone or crt, and all five declare `/** @sdf */` (the shader reads the
shape's outline). In `src/skia/shaderFills.ts`, `shapeFor` only built that outline for rectangles, frames and full
ellipses; for a path, polygon, partial ellipse or line it gave up, and the whole frame left Skia with the reason "shader
fill on … reads the outline of a path".

Fix: `shapeFor` builds the outline for those shapes too, from the same geometry the DOM renderer uses
(`pathGeometry`, `polygonGeometry`, `ellipseGeometry` in `src/render/geometry.ts`; even-odd for rings and paths that
ask for it). The frames are then Skia-eligible, so far out they are drawn from far-zoom copies like any other frame
(and packed in the atlas), and no shader canvases stay live. Same pixels: `paint-diff.mjs` on a 3-frame version
(90 outline-reading paths) is 100% / 100% / 100%, checked by eye in the side-by-side images too.

Reproduced with `make-shaders.mjs sdf28.spen 28 30` (28 frames, 840 paths with an `@sdf` still shader, plus 84 other
shader fills), `farzoom.mjs`, normal processor:

| 28 `@sdf` frames | Before (`738601a`) | After |
|---|---|---|
| Frames drawn by Skia | 0 of 28 (all "reads the outline of a path") | 28 of 28 |
| 2% zoom: 30 steps took | 6.8 s, 24 fps, 23 long tasks (1.3 s) | 2.0 s, 60 fps, 0 long tasks |
| 2% pan: frame rate / median frame | 23 fps / 50 ms | 60 fps / 16.7 ms |
| 9% zoom: 30 steps took | 7.1 s, 23 fps, 26 long tasks (1.7 s) | 2.0 s, 60 fps, 0 long tasks |
| 9% pan: frame rate / median frame | 23 fps / 50 ms | 60 fps / 16.7 ms |
| Skia draw time (30 zoom draws, 2%) | 0 (nothing drawn by Skia) | 16 ms |

This matches the report better than the 600-frame case (slow at 2% and at 9%, performance mode no help: the DOM
renderer's shader canvases don't depend on it). `lod.ts` still never snapshots shader frames on the DOM renderer
(`?renderer=dom`); that is the DOM renderer's behaviour and unchanged here. Frames with an animated shader, or one that
reads the backdrop, still go to the DOM renderer as before.

Still costing time on a slow processor at 2% (4× slower: ~100 ms per pan step left): React and the browser's paint
lifecycle (layerize and commit) for the 600 frame stand-ins and labels. On the normal container processor this was
under a frame. The browser's `GLES2::ReadPixels` in traces is the container's software compositing, not the editor.

**Shaders with an error (the friend's second finding).** A still shader fill that fails (a compile error, a file that
cannot be read, no WebGL) also sent its whole frame back to the DOM renderer, only so that renderer could show its
error marker, and that frame then stayed live at every zoom like the `@sdf` ones above, its working shaders included.
Now Skia draws the marker itself (`errorFill` in `shaderFills.ts`): the same dashed red box with "Shader error: …"
over the node's whole box (not clipped to the outline, as on the DOM renderer; `drawErrorMarkers` in `painter.ts`),
made as a picture like a still shader's output. The design check (`checkLayout`) still lists every shader error: it
renders the checked frames as page elements and reads their markers, on both renderers (30 of 30 on the test file).
Animated shaders and shaders that read the backdrop are unchanged (they go back to the DOM renderer anyway).

Test file: `make-shaders.mjs broken28.spen 28 30 1` (the same 28 frames, the 840 paths on `sdf-broken.glsl`, which
does not compile). `farzoom.mjs`, normal processor:

| 28 frames with failing shaders | Before (`f4196b9`) | After |
|---|---|---|
| Frames drawn by Skia | 0 of 28 ("the shader has an error") | 28 of 28 |
| 2% zoom: 30 steps took | 11.2 s, 12 fps, 60 long tasks (5.5 s) | 2.0 s, 60 fps, 0 long tasks |
| 2% pan | 16 fps, 29 long tasks | 60 fps, 0 long tasks |
| 9% zoom: 30 steps took | 13.4 s, 10 fps, 71 long tasks (7.1 s) | 2.0 s, 60 fps, 0 long tasks |
| 9% pan | 16 fps, 30 long tasks | 60 fps, 0 long tasks |

Slower than the working-shader case before its fix (the 840 error boxes are text the browser lays out), and the
closest to the reported 10 fps of anything measured here. Look: `paint-diff.mjs` on a 3-frame version, 98.7 / 98.4 /
98.2% (text anti-aliasing in the boxes; checked by eye); the working `@sdf` version still 100%.

**Suites** on the final branch (dev server; `stress`, `shaderfill`, `sharpen` on generated files): `features` 20/20
(default and `&renderer=dom`), `v1` 49/49 (the other 6 need the Figma samples, not in the repo), `skia-smoke` 11/11,
`shaderfill` 8/8, `sharpen` 10/11, `stress` no errors (default and `&renderer=dom`). The `sharpen` failure ("fine
detail: dom 3.79, full 2.35") is the same, with the same numbers, on `main` at `738601a`: not from this branch.

**Unverified:** the friend's file and PC. The `@sdf` fix is checked on generated shaders (one brushed-metal
shader), not on their chrome, steel, slate, halftone and crt: if any of those also reads the time or the backdrop, its
frame still goes to the DOM renderer, by design. No GPU numbers: everything here is software rendering. Whether
their slowness was during the first minute after opening (the warm-up above) or all the time.

Questions for the friend, with this build:
1. `diagnose_editor` → `renderer.skia.pictures`: is `eligible` now 28 more than before, and what does `reasons` still
   list? Any frame left there is still on the DOM renderer, and the reason says why.
2. Do chrome, steel, slate, halftone or crt use `@time` or read the backdrop? (Those frames stay on the DOM renderer.)
   Do any of their shapes show the red "Shader error" box? (Now drawn by Skia, but fixing the shader is still best.)
3. Still slow? Only while zooming/panning, or also when nothing moves? Only in the first minute after opening?
4. If so, `diagnose_editor` while it is slow (`renderer.skia.overview.atlas`, `gpu`, `drawMs`), and whether VS Code
   uses the graphics card at all: Windows Task Manager, the GPU column for "Code" while zooming (theory 4).
