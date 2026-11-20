# Tests

Browser-driven checks for the editor: puppeteer-core drives a headless Chromium-based browser against the editor
running from `node start.mjs <folder>`. None of this ships in the extension.

```
cd tests && npm install && cd ..
PEN_NO_OPEN=1 node start.mjs <folder with copies of test files>
node tests/<script>.mjs "http://127.0.0.1:5178/?file=<name>.pen" [more arguments]
```

**Start browsers only through `browser.mjs`.** A Chromium browser (Edge, Chrome) started on a new, empty profile
tries to sign in to Windows with a blank password to see whether the account has one. Windows counts that as a failed
sign-in, and ten of them in ten minutes lock the account: this locked a developer out of their own PC. `launchOptions()`
and `newProfile()` hand out profiles that skip the check, and refuse to start a browser when failed sign-ins are
already piling up. `lockout.mjs` checks both.

Always work on copies: several scripts edit the file they open. `browser.mjs` picks the browser (Edge or Chrome if
installed, or the executable named in `PEN_BROWSER`).

**One renderer.** Since 2026-11-20 the canvas is drawn by Skia only (the DOM renderer and `&renderer=` are gone; see
docs/SKIA_REWORK.md, "Skia only"). The suites that tested the DOM renderer's own machinery or compared Skia against it
(`blank`, `images`, `invisible`, `layout-diff`, `overview`, `paint-diff`, `lodswitch`, `zoomout`, `imgzoom`, `svgretain2`)
were removed with it; their last results are in the status log.

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
| `imagetools.mjs <url> <shot dir>` | `analyze_image` / `compare_to_reference` | copy of `fixtures/features.pen`; needs two reference files that are not in the repo | 16 PASS |
| `skia-smoke.mjs <url>` | Skia layer: no layer is a page element, draws and reads back, survives a lost graphics context, draws in software (read back too) when it never returns | copy of `fixtures/features.pen` | 11 PASS |
| `full.mjs <url> [shot dir]` | Skia full mode (stage 4): frames drawn from pictures with no DOM inside, on screen the same as the off-screen render, layer boxes from the layout engine, hover/click/deep-select reach layers, text editing (frame goes DOM while edited), edits re-record, agent screenshot, far-zoom copies, fallback when the context is lost for good with 0 CanvasKit objects left | a `make-big.mjs` file | 14 PASS |
| `sharpen.mjs <url> [shot dir]` | Skia's two sizes of pictures: zoomed out only the small versions are held, a picture seen close up gets a larger one and matches a page opened close up, larger ones are let go again when nothing needs them, and no frame flashes its flat colour meanwhile. About 90 s | a `make-big.mjs` file with big pictures (`make-big.mjs big2k.spen 60 3 12 2048`) | 11 PASS |
| `htmlexport.mjs <url> [out dir] [threshold=97] [max frames=200]` | The HTML exporter (`src/export/html.ts`, boxes from the layout engine) against how Skia draws the same frame (the agent's screenshot): the exported page rendered in a fresh tab at the screenshot's size and scored with `compare()`, per top-level frame; writes the HTML and a side-by-side image. Shader fills and effects can't be HTML, so frames with them score lower | copies of `fixtures/features.pen`, `examples/showcase.spen` (with its `scripts/` and `shaders/`) | features 100%, showcase 97.7% (2026-11-20; against the old DOM-clone export it was 100% / 99.7%, layout.pen 98.0%) |
| `v1.mjs <url> [shot dir]` | The 1.0 features: Scale tool, Alt + hover distances, image crop, masks, gradient and mesh handles, path point editing and pen curves, slots, libraries, remove background, HTML import, Figma import (file, dialog, paste, hand-over from the MCP tool). Adds its own layers far from the file's content. Run it with `&renderer=dom` and without. Needs the dev server. The Figma checks are skipped unless `dev/fixtures/figma/` holds `structure.fig`, `stacks_wrap.fig` (from sketch-hq/fig2sketch `tests/data/`) and `frame-with-r-g-b-rect.clipboard.html` (from gridaco/grida `fixtures/test-fig/clipboard/`); they are other people's files, so they are not in this repository | copy of `fixtures/features.pen` | 55 PASS (49 without the Figma samples) |
| `skills.mjs [mcp.cjs]` | Design skills through the built MCP server: the index, each skill whole, aliases, unknown names, the prompts, and that every tool a skill mentions exists. No browser; run `npm run build:mcp` first | none | 11 PASS |
| `fig-import.mjs [--out <folder>] [--page <name>] [--all-pages] <file.fig \| clipboard.html> ...` | Figma import on real files: converts each one, checks the result is a valid design (unique ids, known node types, numbers that are numbers, pictures present) and reports how many auto layout children land where Figma had them. No browser. Bring your own `.fig` files | none | `invariants: OK` per file |
| `csp-srcdoc.mjs` | HTML import's sandboxed iframe loads and can be measured under the VS Code webview's content security policy (keep the list in the script the same as `extension/extension.ts`) | none | 3 PASS |
| `firstshot.mjs <url> [delay ms]` | The first capture of a picture layer is not blank: picture files are made to arrive late (as inside VS Code), then a picture layer is measured and screenshotted straight after the page opens. Run it with `&renderer=dom` and without | a design with picture fills from files (`img15.pen`) | 3 PASS |
| `docindex.mjs [edits] [seed]` | The shortcuts that keep editing fast on big designs give the same answers as the plain versions: the document index and the layer-tree index brought up to date after an edit against ones built whole, and `locate()` inside an edit against a plain search, over thousands of random edits (properties, add, remove, move, reorder, components, repeated ids, undo). No browser | none | 4 PASS |
| `shaderfill.mjs <url> [shot dir]` | Still shader fills drawn by Skia: every frame of a design full of them is drawn by Skia, the fill is on the canvas, a larger version is made when it is shown large, changing a uniform redraws it without the frame leaving Skia, and a frame with an animated shader stays with Skia and moves (a live texture). Also run `paint-diff.mjs` on the same design (100% expected) | a `make-shaders.mjs` design | 8 PASS |
| `sksl.mjs <url> <shader files...>` | Design shaders translated to SkSL (`src/skia/sksl.ts`) against the WebGL engine: each shader run both ways with the same inputs and the pixels compared; animated ones only checked to compile; one that can't be translated or that Skia rejects keeps WebGL | a design in the shaders' folder | PASS per shader (99%+ of pixels within 6/255) |
| `lockout.mjs` | Starting test browsers makes no failed Windows sign-ins, and no script starts a browser on a profile of its own. Run it after touching `browser.mjs` or adding a script that launches a browser. Windows only | none | 2 PASS |
| `stress.mjs <url> [steps] [seed]` | Random pan, zoom, select, drag and MCP actions | a big file | 0 page errors, 0 view jumps, 0 unexpected view changes |

## Measuring and looking

| Script | Use |
|---|---|
| `make-big.mjs <out.spen> [frames] [seed] [pictures] [pictureSize]` | Writes a seeded synthetic design (320 frames ≈ 40,000 nodes by default) plus generated pictures in `images/`, for big-file tests without anyone's real design. Pictures over 512 px get a fine checker pattern, so a test can tell a sharp drawing from a blurry one |
| `make-shaders.mjs <out.spen> [frames] [sdfPaths=0] [broken=0]` | Writes a design with many shader fills (three per frame, a still shader) and its `.glsl` files, for timing what zooming costs with lots of shader canvases: run `skia-prof.mjs` on it. `sdfPaths`: that many icon-sized paths per frame filled with a still shader that reads the outline (`@sdf`), like the chrome/steel case of 2026-11-20 (`make-shaders.mjs sdf28.spen 28 30`, then `farzoom.mjs`). `broken=1`: those paths use a shader that does not compile (`sdf-broken.glsl`), for the error-marker case. 2026-11-19, 64 frames / 192 fills: worst zoom frame 300-360 ms before, 29 ms (out) and about 55 ms (in) after |
| `fixtures/make-layout.mjs [out]` | Regenerates `fixtures/layout.pen`, the layout edge cases (justify/align, fill/fit fallbacks, absolute children, wrapping text, rotation, groups, icons, auto-width roots) |
| `farzoom.mjs <url> [renderer=full] [perf=0\|1] [zooms=0.02,0.09]` | Far zoom with every frame on screen (the "10 fps at 2%" report, 2026-11-20): at each zoom, after Skia has stopped drawing, frame times, Skia draws and draw time, DOM changes, long tasks and the Skia counters while idle, stepping the zoom and panning. `PROFILE=idle,zoom,pan` adds top self-time functions (dev server for names), `PEN_CPU_SLOW=4` a slower processor, `HIDE_LABELS=1` frame labels hidden. `PEN_PROD=1`; frame times mean little without a GPU, compare counts and long tasks |
| `skia-prof.mjs <url> [renderer=full] [perf=0\|1] [runs=2]` | Where the Skia renderer spends its time on a big file: the editor's benchmark cold and warm, with the Skia counters after each (pictures recorded, far-zoom copies made, placeholder draws, GPU memory). Use `PEN_PROD=1` and a machine with a GPU for the frame times |
| `skia-mem.mjs <url> [renderer=full] [perf=0\|1]` | What the Skia renderer holds at each step of the `memory.mjs` scenario: decoded pictures (small and larger versions), far-zoom copies, recorded pictures, Skia's GPU cache. Says what is behind the process totals `memory.mjs` gives. `PEN_PROD=1` |
| `dragbench.mjs <url> [runs] [moves]` | Frame times while dragging the last top-level frame of a big design with the mouse, and the cost of one edit on its own. Run before and after any change to dragging or to how edits find their layer. `PEN_PROD=1`; `PEN_CPU_SLOW=4` slows the page's main thread 4x to see what a weaker PC would feel (also works with `skia-prof.mjs`). 2026-11-19 on the 40,000-layer `make-big.mjs` file: 68 ms a frame before, 11.5 ms after |
| `picload.mjs <url> [perf=0\|1]` | How pictures load in the Skia renderer: time from opening until every picture is in and every frame is drawn, time until pictures are sharp after the first zoom-in, the longest frame in each, and the same zoom-in twice more (what only happens the first time is over by then). `PEN_PROD=1`; `PEN_CPU_SLOW=4`; `PEN_LINKS=1` lists the programs the graphics card had to compile during the zoom-in; `PEN_PROFILE=1` (dev server) prints where the time went. Needs a design with many large pictures (`make-big.mjs pics.spen 60 3 48 2048`). 2026-11-19: first zoom-in worst frame 183 ms before, 29-34 ms after |
| `bench.mjs <url>` | Frame times for zoom, pan and hover. Headless runs use software graphics: treat single long frames as noise |
| `memory.mjs <url> [perf=0\|1]` | Process memory without a debugger attached (a debugger inflates it). Windows only |
| `tracezoom.mjs`, `prof2.mjs`, `zoomfast.mjs` | Traces and CPU profiles during zooming |
| `panelzoom.mjs`, `precision.mjs` | Narrow checks: Ctrl+wheel over panels, coordinate precision |
| `featshot.mjs`, `svgshot.mjs`, `svgshot2x.mjs` | Screenshots to look at |
| `uishot.mjs <url> <out prefix>` | The whole interface to look at: both themes, the menus, layer search, the FPS readout, a narrow window |
| `figshot.mjs <url> <out prefix> [max]` | An imported Figma page to look at: its top-level layers and close-ups of cropped pictures. Convert with `fig-import.mjs --out` into the folder the dev server serves first |
