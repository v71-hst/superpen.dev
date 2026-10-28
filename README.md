<p align="center">
  <img src="media/banner.png" alt="Superpencil: design .pen UIs inside VS Code" width="100%">
</p>

# Superpencil

**Superpencil** (from the superpen.dev repo) is a VS Code extension for designing UIs in `.pen` files (the pen.dev file format), with a pen.dev-style editor:
layers, components, auto layout, variables and themes, script-generated content, GPU shaders, SVG import, and an
MCP server so Claude or Codex can design alongside you.

Your `.pen` files stay plain pen.dev JSON, so they keep working in pen.dev too.

---

## What's new

- **Eyedropper** (I): click any layer to copy its colour, or apply it to the selected layers (Shift: as stroke).
  The colour picker has a pipette too (picks a layer's colour and keeps `$variable` links) and, where supported, a
  button to pick any pixel on screen.
- **Codex support**: **"Superpencil: Register MCP Server with Codex"** adds the MCP server to Codex's
  `~/.codex/config.toml`, so Codex chats (CLI or VS Code extension) can read and edit designs like Claude Code.
- **New name and icon**: the extension is now called **Superpencil** (it was "Pen Editor (Remake)"). Updating
  from the old build replaces it in place; your MCP registration keeps working.
- **Sidebar**: a Superpencil icon in the activity bar opens a **Designs** list of every `.pen` file in your
  workspace (click to open), with buttons for a new design and for registering the MCP server.
- **Sharper, lighter zoomed-out view**: below 33% zoom, frames are drawn from images that are pixel-sharp at 33%
  and drop to half resolution each time you halve the zoom, so far-out views use far less memory. Small UI screens
  (8+ layers) now get this too instead of staying full live layouts.
- **Smoother zooming**: the canvas no longer re-measures every frame on each zoom step, skips pointer hit-testing
  while the view is moving, and keeps the design out of the accessibility tree. On a large file this cut the time
  spent in slow frames by about 40% and the worst hitch from 90–150 ms to about 60 ms.

---

## Install (2 minutes)

You need **VS Code 1.90 or newer**.

1. Download [`release/superpen.vsix`](release/superpen.vsix) from this repo (open it on GitHub → **Download raw file**).
2. In VS Code open the Extensions view (**Ctrl+Shift+X**), click the **`…`** menu at the top → **Install from VSIX…**,
   and pick the downloaded file.
   *Or* in a terminal: `code --install-extension path\to\superpen.vsix --force`
3. **Ctrl+Shift+P → Reload Window**.

It shows up in the Extensions list as **Superpencil**. Open any `.pen` file and it opens in the visual editor.
The Superpencil icon in the activity bar (left) lists your workspace's designs, and there's also a pen button in the
editor title bar (top right) that opens or creates `.pen` files.

> If you also have the official pen.dev extension installed, VS Code may ask which editor to use. Right-click the
> tab → **Reopen Editor With…** to switch.

Try it on the demo: open [`examples/showcase.pen`](examples/showcase.pen) (keep the `scripts/` and `shaders/`
folders next to it — the showcase uses them).

---

## Using Claude or Codex with it (optional)

The extension includes an MCP server, so Claude Code chats can read and edit your designs.

1. Install [Claude Code](https://claude.com/claude-code) so the `claude` command works in a terminal.
2. In VS Code: **Ctrl+Shift+P → "Superpencil: Register MCP Server with Claude Code"** (you're also asked once on
   first start).
3. Start a new Claude chat and ask it to work on one of your open `.pen` files.

**Using Codex instead?** Run **Ctrl+Shift+P → "Superpencil: Register MCP Server with Codex"**. It adds a
`[mcp_servers.pen-editor]` entry to `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), keeping a `.bak` copy
of the old file, then works the same way in a new Codex chat. The editor's lock badge shows which chat
("Claude chat …" / "Codex chat …") holds a file.

How it works:

- `list_open_files` shows every `.pen` file open in any VS Code window.
- `select_file` picks the file a chat works on and takes an **edit lock**, so several chats can each edit a
  different file at the same time without clobbering each other. Other chats can still read it.
- The chat holding the lock is shown at the top right of the editor — click it to revoke the lock.
- Claude can edit with batched operations (one undo step each), take screenshots to check its work,
  check layouts, draw vector artwork (`insert_svg`), trace images into vectors, and write scripts and shaders.
- **Review mode** (checklist button in the tool column): Claude's edits show up straight away but wait in a
  banner until you **Accept** or **Reject** them.
- **Comments** (C): pin a comment anywhere on the canvas. Claude is told about open comments, reads them with
  `get_comments`, does the work and answers in the thread (`reply_comment`).
- **Design lint**: `lint_design` (or the shield button) finds hard-coded colours that should be variables, tiny or
  low-contrast text, fractional positions, overflowing text, missing components and fonts, with one-click fixes.

---

## Features

- **Canvas**: pan (scroll / Space-drag / middle mouse), zoom (Ctrl+scroll, pinch), Shift+1 fit, Shift+2 zoom to
  selection. Very large files stay smooth: off-screen frames are skipped, and below 33% zoom frames are drawn as
  images whose resolution follows the zoom (sharp at 33%, half size at each halving). Selecting a frame or zooming
  back in switches it back to the live, editable layout.
- **Editing**: select / deep-select (Ctrl+click), move, resize, draw shapes, text, frames, notes and pen paths,
  auto layout, components and instances, variables and themes, undo/redo through VS Code.
- **Smart guides**: dragged layers snap to the edges and centres of their neighbours and parent, and to equal
  spacing (pink distance labels). Hold Ctrl to move freely. Drag the pink handles between auto-layout children to
  change the gap.
- **Component states**: give a component states like *hover*, *pressed* or *disabled* in the Design panel, edit each
  one on the canvas, and pick which state an instance shows.
- **Prototypes**: link any layer to another frame (Design panel → Prototype) with a transition. In Present mode
  links are clickable and hover/pressed states play automatically.
- **Eyedropper** (I): click a layer to copy its colour, or apply it to the selection (Shift: as stroke). The
  pipette in the colour picker fills that colour field from a layer, keeping variable links.
- **Mixed selections**: select shapes and text together and edit fill, stroke and typography at once; each change
  goes only to the layers it applies to.
- **Find & replace** (Ctrl+F) across text, layer names and variable references.
- **Script nodes**: JavaScript files that generate content (charts, rings, patterns). Inputs show up as controls in
  the Design panel. Shapes menu → **Script** creates a starter file.
- **Shaders**: WebGL fills and effects (`.glsl`) with animation, mouse, shape-aware SDF, content and backdrop
  textures. Settings get sliders and colour pickers automatically.
- **SVG**: paste SVG code or import an `.svg` file and it becomes editable vector shapes. Image fills can be
  traced into vectors (logo / illustration / detailed).
- **Export**: PNG / JPG / SVG / HTML per layer, slides presentation mode.
- **Roblox export (experimental)**: Export → *Roblox Luau* turns a frame into a script that rebuilds it as Roblox
  GUI objects (Frame / TextLabel / ImageLabel with UICorner, UIStroke and UIGradient). Vector art and images become
  placeholders you upload yourself. Claude only uses it (`export_roblox`) when you ask for it.

Editing a `.js` / `.glsl` / image file next to your `.pen` file updates the canvas automatically.

---

## Troubleshooting

- **Something looks broken** → there's a "Reload editor" button if the editor ever hits an error, or
  Ctrl+Shift+P → **Reload Window**. Your document is never lost.
- **Logs**: VS Code → Output panel → **Superpencil**, or the file `~/.pen-editor/logs/webview.log`.
  A Claude chat can also read the live state with the `diagnose_editor` tool.
- **"claude" not found when registering MCP** → the registration command is copied to your clipboard; run it in a
  terminal where Claude Code is installed.
- **Is it safe / will antivirus mind?** The extension is plain JavaScript (no `.exe` or native code). Its only
  network server listens on `127.0.0.1` (your own PC) so Claude chats can reach the editor, it writes only to
  `~/.pen-editor`, and the only commands it runs are `node --version` and `claude mcp add/remove` when you register
  the MCP server. If Node.js isn't installed it starts the MCP server with VS Code's own runtime
  (`ELECTRON_RUN_AS_NODE`), which some strict corporate security tools flag; installing Node.js avoids that.

---

## Building from source

Needs Node.js 18+.

```
npm install
npm run package        # builds and writes release/superpen.vsix
npm start [folder]     # optional: run the editor in a browser against a folder of .pen files (defaults to ./examples)
```

Set `PEN_PROD=1` before `npm start` to serve the production build instead of the dev server (useful for measuring
performance, since React's dev mode is much slower).

Project layout:

- `src/` – the editor (React): `model/` .pen format, ref/variable resolution, operations and SVG import;
  `render/` canvas renderer, shaders, scripts; `editor/` state, file sync, culling, agent handler; `ui/` panels.
- `extension/` – the VS Code extension (custom editor, per-window MCP bridge with locking) and the MCP server.
- `examples/` – demo design plus its scripts and shaders.
