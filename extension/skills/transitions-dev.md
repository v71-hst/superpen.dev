# Transitions for developers

> Use when: motion has to leave the design file — writing a motion spec a developer can build from, turning designed transitions into code (CSS / web, or Roblox TweenService), or reviewing whether built motion matches the design. Read the transitions skill first; this one is about precision and implementation.

## The idea

Motion is lost in handoff more than anything else, because a static frame cannot show it and "make it feel smooth" cannot be built. A developer needs five facts per animation: what triggers it, which properties change, from what to what, how long, and with what curve. Give those as named values that are reused, the same way colours and spacing are, and the built result matches the intent.

## Motion values: define once, use everywhere

Give the product a small set and name it. A dependable default:

| Name | Value | Use |
|---|---|---|
| `duration-instant` | 0 ms | pressed states, anything under the finger |
| `duration-fast` | 120 ms | hover, toggles, colour and opacity changes |
| `duration-base` | 200 ms | menus, popovers, small panels, expand/collapse |
| `duration-slow` | 300 ms | dialogs, sheets, large panels, page changes |
| `duration-slower` | 500 ms | rare: celebration, onboarding |
| `ease-out` | cubic-bezier(0.2, 0, 0, 1) | entering, responding |
| `ease-in` | cubic-bezier(0.4, 0, 1, 1) | leaving |
| `ease-in-out` | cubic-bezier(0.4, 0, 0.2, 1) | moving between two places on screen |
| `ease-overshoot` | cubic-bezier(0.34, 1.56, 0.64, 1) | playful emphasis only |
| `distance-small` | 8 px | fades with a nudge |
| `distance-large` | 24 px | panels and sheets settling |
| `stagger` | 30 ms per item, max 6 items | lists entering |

Exits use the next duration down (a 300 ms dialog closes in 200 ms).

## The spec format

One row per animation. Put it in a `note` beside the frames in the design file and repeat it in your handoff message.

| Element | Trigger | Property | From → To | Duration | Easing | Delay | Notes |
|---|---|---|---|---|---|---|---|
| Shop panel | Shop button pressed | position Y, opacity | +24 px → 0, 0 → 1 | slow (300) | ease-out | 0 | origin: bottom; backdrop fades 0 → 60% over the same time |
| Shop panel | Close / backdrop / Esc | position Y, opacity | 0 → +24 px, 1 → 0 | base (200) | ease-in | 0 | then remove from the tree |
| Item card | pointer down | scale | 1 → 0.96 | instant | – | 0 | |
| Item card | pointer up | scale | 0.96 → 1 | fast (120) | ease-overshoot | 0 | |
| Item cards | panel opened | opacity, position Y | 0 → 1, +8 → 0 | base (200) | ease-out | 30 ms × index, first 6 | the rest appear with the sixth |

Also state, once per spec:

- **Interruption:** what happens if the trigger reverses mid-way (default: reverse from the current value, do not restart).
- **Reduced motion:** what replaces each row (default: position and scale changes removed, opacity kept at `duration-fast`).
- **Initial state:** what is rendered before the animation starts, so nothing flashes at its final position first.
- **Layering:** what is above what during the transition (the entering screen above the leaving one; backdrops below sheets).

## Rules for building it

1. **Animate only what is cheap.** Position (as a transform), scale, rotation, opacity. Avoid animating width, height, padding, margins, shadows blur, or layout properties: they force layout every frame and stutter. To grow a box, animate a transform or a clip, or animate layout only for one small element.
2. **Never animate from an unknown state.** Set the start values explicitly before starting; when interrupted, start from the current computed value.
3. **No `transition: all`.** List the properties. Unlisted properties must change instantly.
4. **Hit 60 fps on the weakest target device.** Test there, not on the development machine. If it drops frames, shorten and simplify before optimising.
5. **Input stays live.** Do not disable controls while something animates unless pressing them mid-flight would break state; if it would, make the animation shorter.
6. **Remove what has left.** After an exit animation completes, take the element out of the tree / hide it so it cannot be focused or pressed.
7. **One source of truth.** Durations and curves live in one module or token file; no literal 0.25 scattered through the code.
8. **Honour the reduced-motion setting** of the platform, everywhere, from the first version.

## Web (CSS)

```css
:root {
  --duration-fast: 120ms; --duration-base: 200ms; --duration-slow: 300ms;
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
}
.panel { opacity: 0; transform: translateY(24px);
  transition: opacity var(--duration-base) var(--ease-in), transform var(--duration-base) var(--ease-in); }
.panel[data-open] { opacity: 1; transform: none;
  transition-duration: var(--duration-slow); transition-timing-function: var(--ease-out); }
.button { transition: background-color var(--duration-fast) linear, transform var(--duration-fast) var(--ease-out); }
.button:active { transform: scale(0.97); transition-duration: 0ms; }
@media (prefers-reduced-motion: reduce) {
  .panel { transform: none; transition: opacity var(--duration-fast) linear; }
  .button:active { transform: none; }
}
```

Note the pattern: the transition declared on the *resting* rule describes the way back (the exit); the one on the *active* rule describes the way in. Use `transform` and `opacity`; reach for `@starting-style` or a mount class for enter animations of newly inserted elements; use the View Transitions API or FLIP (measure first and last positions, invert with a transform, play) for elements that move between layouts.

## Roblox (TweenService)

```lua
local TweenService = game:GetService("TweenService")
local GuiService = game:GetService("GuiService")

local Motion = {
	Fast = 0.12, Base = 0.2, Slow = 0.3,
	Out = function(t) return TweenInfo.new(t, Enum.EasingStyle.Quint, Enum.EasingDirection.Out) end,
	In = function(t) return TweenInfo.new(t, Enum.EasingStyle.Quad, Enum.EasingDirection.In) end,
	Overshoot = function(t) return TweenInfo.new(t, Enum.EasingStyle.Back, Enum.EasingDirection.Out) end,
}

local function openPanel(panel: CanvasGroup, restPosition: UDim2)
	local reduced = GuiService.ReducedMotionEnabled
	panel.Visible = true
	panel.GroupTransparency = 1
	panel.Position = if reduced then restPosition else restPosition + UDim2.fromOffset(0, 24)
	TweenService:Create(panel, Motion.Out(if reduced then Motion.Fast else Motion.Slow), {
		GroupTransparency = 0,
		Position = restPosition,
	}):Play()
end

local function closePanel(panel: CanvasGroup, restPosition: UDim2)
	local tween = TweenService:Create(panel, Motion.In(Motion.Base), {
		GroupTransparency = 1,
		Position = restPosition + UDim2.fromOffset(0, 24),
	})
	tween.Completed:Once(function(state)
		if state == Enum.PlaybackState.Completed then panel.Visible = false end
	end)
	tween:Play()
end
```

Mapping the spec to Roblox:

- **Curves:** `ease-out` → `Quint`/`Quart` + `Out` (use `Quad` + `Out` for a softer one); `ease-in` → `Quad` + `In`; `ease-in-out` → `Quad`/`Sine` + `InOut`; `ease-overshoot` → `Back` + `Out`. Durations are in seconds.
- **Fading a whole panel:** put it in a `CanvasGroup` and tween `GroupTransparency`; otherwise every descendant's `BackgroundTransparency`, `TextTransparency`, `ImageTransparency` and each `UIStroke.Transparency` must be tweened separately.
- **Scale (press feedback, pop-in):** add a `UIScale` and tween `UIScale.Scale`; set the element's `AnchorPoint` to `(0.5, 0.5)` so it scales from its centre. Do not tween `Size` for press feedback: it re-lays-out children and shifts text.
- **Position:** tween `Position` (UDim2). Elements inside a `UIListLayout`/`UIGridLayout` are positioned by the layout, so animate a child wrapper or a `UIScale`/`UIPadding` instead.
- **Interruptions:** creating and playing a new tween on the same property replaces the old one from the current value; keep a reference and `:Cancel()` when both directions can overlap, and check `PlaybackState` in `Completed` (as above) so a cancelled close does not hide a reopened panel.
- **Stagger:** `task.delay(i * 0.03, function() ... end)` for the first six items.
- **Count-ups:** tween a `NumberValue` and update the label on `Changed`, or drive it from `RunService.RenderStepped` with an ease-out curve.
- **Springs** (when a tween's fixed duration feels wrong for drag or follow motion): use a spring module driven per frame; keep damping near critical for UI.
- Run UI tweens on the client only.

## Reviewing built motion against the design

- Record the screen at 60 fps and step through frames: is the first frame the specified start state? Does it settle without a jump?
- Count frames for the duration (300 ms ≈ 18 frames at 60 fps).
- Trigger and immediately reverse: does it reverse smoothly from where it was?
- Spam the trigger: does anything end in a wrong state (panel hidden while open, scale stuck at 0.96)?
- Turn on reduced motion: do movements disappear and information remain?
- Try it on the slowest supported device.

## In Superpencil

- The design file holds the *states*: from and to frames (or component `states`), and `link` transitions for navigation. Name frames so pairs are obvious ("Shop – closed", "Shop – open").
- Put the spec table in a `note` node next to those frames (`{ "type": "note", "content": "…" }`) so it travels with the design.
- Read exact from/to values off the design with `get_nodes` (positions, sizes, opacity, fills) rather than estimating from a screenshot; quote them in the spec.
- `export_node` gives images of the two states for the handoff message if the developer does not have the file open.
- Roblox export in Superpencil is experimental and does not produce animation; the Luau above is written by hand against the built GUI.

## Check before you finish

- [ ] Every animation has all five facts (trigger, properties, from → to, duration, easing), using the named values.
- [ ] Interruption, reduced motion, initial state and layering are stated.
- [ ] Only transform/position, scale, rotation and opacity are animated, with any exception justified.
- [ ] Exit animations end with the element removed or hidden.
- [ ] Durations and curves are defined once in the code.
- [ ] The built result was checked frame by frame against the spec, or the handoff says it has not been.

## Common mistakes

- "Animate in nicely" as the whole specification.
- Tweening `Size` or CSS `height` for everything, then fighting jitter.
- Forgetting the exit, so things pop out after gliding in.
- A fresh tween from the designed start value while a previous one is mid-way: visible jump.
- Different magic numbers in every script.
- Hiding a panel in a `Completed` handler that also fires when the tween was cancelled.
- No reduced-motion path.
