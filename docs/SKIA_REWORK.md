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
