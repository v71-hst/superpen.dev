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
| `stress.mjs <url> [steps] [seed]` | Random pan, zoom, select, drag and MCP actions | a big file | 0 page errors, 0 view jumps, 0 unexpected view changes |

## Measuring and looking

| Script | Use |
|---|---|
| `bench.mjs <url>` | Frame times for zoom, pan and hover. Headless runs use software graphics: treat single long frames as noise |
| `memory.mjs <url> [perf=0\|1]` | Process memory without a debugger attached (a debugger inflates it). Windows only |
| `zoomout.mjs`, `imgzoom.mjs`, `tracezoom.mjs`, `prof2.mjs`, `zoomfast.mjs` | GPU memory, decode work, traces and CPU profiles during zooming |
| `lodswitch.mjs`, `panelzoom.mjs`, `precision.mjs`, `invisible.mjs` | Narrow checks: snapshot-to-live switching, Ctrl+wheel over panels, coordinate precision, frames missing while zoomed out |
| `featshot.mjs`, `svgshot.mjs`, `svgshot2x.mjs` | Screenshots to look at |
| `svgretain2.mjs` | Shows how much memory a browser holds per SVG data URL. Windows only |
