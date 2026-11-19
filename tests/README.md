# Tests

Browser-driven checks for the editor: puppeteer-core drives a headless Chromium-based browser against the editor
running from `node start.mjs <folder>`. None of this ships in the extension.

```
cd tests && npm install && cd ..
PEN_NO_OPEN=1 node start.mjs <folder with copies of test files>
node tests/<script>.mjs "http://127.0.0.1:5178/?file=<name>.pen" [more arguments]
```

Always work on copies: several scripts edit the file they open. `browser.mjs` picks the browser (Edge or Chrome if
installed, or the executable named in `PEN_BROWSER`).

**Renderer modes.** Add `&renderer=dom` (or `overview`, `full`) to any test URL to run a suite with that renderer
(docs/SKIA_REWORK.md); without it the editor uses `localStorage['pen.renderer']`, `full` (Skia) by default since
0.4.0. Suites about the DOM renderer's own machinery (snapshots, picture levels: `images.mjs`, `lodswitch.mjs`,
`invisible.mjs`, `zoomout.mjs`, `imgzoom.mjs`, the snapshot checks of `blank.mjs`) need `&renderer=dom`. Only test builds
(the dev server, or `PEN_PROD=1`) read the URL parameter. On Linux `browser.mjs` turns on software WebGL
(SwiftShader), so the Skia canvas and shaders also run in containers without a GPU.

`features.mjs` and `aipen.mjs` import `/src` modules and need the dev server. The memory and trace scripts are
closer to the real extension with `PEN_PROD=1 node start.mjs <folder>` (a production build with test hooks).

## Pass/fail suites

| Script | Checks | File to open | Expect |
|---|---|---|---|
| `errs.mjs <url>` | Page errors on load. Run first after changing imports | any | no errors |
| `features.mjs <url>` | States, prototypes, snapping, gap handles, mixed selection, comments, review, lint, find and replace, Roblox export | copy of `fixtures/features.pen` | 20 PASS |
| `aipen.mjs <url> <shot dir>` | AI Pen requests, drawing passes, replay | copy of `fixtures/features.pen` | 16 PASS |
| `drawcheck.mjs <url> <shot dir>` | `check_drawing` finds stroke ends just off the line they meet | copy of `fixtures/features.pen` | 7 PASS |
| `subpixel.mjs <url> <shot dir>` | Shapes at fractional coordinates line up when zoomed in | copy of `fixtures/features.pen` | 1 PASS |
| `hiddentab.mjs <url>` | Screenshots of a background tab return; background tabs unload and come back | any file with frames | 6 PASS |
| `blank.mjs <url> <shot dir>` | Frames stay visible when snapshots or their copies come out blank | a big file (10+ filled frames on screen when zoomed out) | 7 PASS |
| `images.mjs <url> <shot dir>` | Zoom-sized copies of picture fills | 15 frames with 2-4K picture fills | 13 PASS |
| `imagetools.mjs <url> <shot dir>` | `analyze_image` / `compare_to_reference` | copy of `fixtures/features.pen`; needs two reference files that are not in the repo | 16 PASS |
| `skia-smoke.mjs <url>` | Skia layer (`pen.renderer=overview`): draws and reads back, survives a lost graphics context, falls back to the DOM renderer when it never returns; switch off loads no CanvasKit | copy of `fixtures/features.pen` | 11 PASS |
| `layout-diff.mjs <url> [more urls]` | `src/layout/layout.ts` against the DOM: every node's world box, text sizes from the browser (0.5px tolerance); also reports how close the canvas text measurer gets and `layoutAll` time | copies of `fixtures/features.pen`, `fixtures/layout.pen`, `examples/showcase.spen`, a `make-big.mjs` file | PASS, 0 offenders each |
| `overview.mjs <url> <shot dir>` | Skia overview (stage 1): zoomed-out snapshot frames drawn by Skia, all visible, no `<img>` for them, a moved frame follows, zooming in goes live, a lost context puts the snapshot images back | a `make-big.mjs` file | 12 PASS |
| `full.mjs <url> [shot dir]` | Skia full mode (stage 4): frames drawn from pictures with no DOM inside, same pixels and boxes as the DOM renderer, hover/click/deep-select reach layers, text editing (frame goes DOM while edited), edits re-record, agent screenshot, far-zoom copies, fallback when the context is lost for good with 0 CanvasKit objects left | a `make-big.mjs` file | 14 PASS |
| `sharpen.mjs <url> [shot dir]` | Skia's two sizes of pictures: zoomed out only the small versions are held, a picture seen close up gets a larger one and matches the DOM renderer, larger ones are let go again when nothing needs them, and no frame flashes its flat colour meanwhile. About 90 s | a `make-big.mjs` file with big pictures (`make-big.mjs big2k.spen 60 3 12 2048`) | 11 PASS |
| `paint-diff.mjs <url> <out dir> [threshold] [layout=dom\|engine] [max frames]` | Skia painter against the DOM renderer, frame by frame (stage 3), with side-by-side images | copies of `fixtures/features.pen`, `examples/showcase.spen`, a `make-big.mjs` file | see the status log |
| `stress.mjs <url> [steps] [seed]` | Random pan, zoom, select, drag and MCP actions | a big file | 0 page errors, 0 view jumps, 0 unexpected view changes |

## Measuring and looking

| Script | Use |
|---|---|
| `make-big.mjs <out.spen> [frames] [seed] [pictures] [pictureSize]` | Writes a seeded synthetic design (320 frames ≈ 40,000 nodes by default) plus generated pictures in `images/`, for big-file tests without anyone's real design. Pictures over 512 px get a fine checker pattern, so a test can tell a sharp drawing from a blurry one |
| `fixtures/make-layout.mjs [out]` | Regenerates `fixtures/layout.pen`, the layout edge cases (justify/align, fill/fit fallbacks, absolute children, wrapping text, rotation, groups, icons, auto-width roots) |
| `skia-prof.mjs <url> [renderer=full] [perf=0\|1] [runs=2]` | Where the Skia renderer spends its time on a big file: the editor's benchmark cold and warm, with the Skia counters after each (pictures recorded, far-zoom copies made, placeholder draws, GPU memory). Use `PEN_PROD=1` and a machine with a GPU for the frame times |
| `skia-mem.mjs <url> [renderer=full] [perf=0\|1]` | What the Skia renderer holds at each step of the `memory.mjs` scenario: decoded pictures (small and larger versions), far-zoom copies, recorded pictures, Skia's GPU cache. Says what is behind the process totals `memory.mjs` gives. `PEN_PROD=1` |
| `bench.mjs <url>` | Frame times for zoom, pan and hover. Headless runs use software graphics: treat single long frames as noise |
| `memory.mjs <url> [perf=0\|1]` | Process memory without a debugger attached (a debugger inflates it). Windows only |
| `zoomout.mjs`, `imgzoom.mjs`, `tracezoom.mjs`, `prof2.mjs`, `zoomfast.mjs` | GPU memory, decode work, traces and CPU profiles during zooming |
| `lodswitch.mjs`, `panelzoom.mjs`, `precision.mjs`, `invisible.mjs` | Narrow checks: snapshot-to-live switching, Ctrl+wheel over panels, coordinate precision, frames missing while zoomed out |
| `featshot.mjs`, `svgshot.mjs`, `svgshot2x.mjs` | Screenshots to look at |
| `svgretain2.mjs` | Shows how much memory a browser holds per SVG data URL. Windows only |
