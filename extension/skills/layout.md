# Better layout

> Use when: placing anything on a frame — a new screen, a card, a list, a HUD — or when a design looks "off" and you cannot say why. Layout is the first thing to get right; colour and type cannot rescue a bad one.

## The idea

A layout is a set of decisions about what belongs together, what comes first, and how much room each thing gets. People read those decisions from distance and alignment before they read a single word. So: few distinct distances, used consistently; edges that line up; and space, not boxes, doing most of the grouping.

## Rules

1. **One spacing scale, nothing off it.** 4, 8, 12, 16, 24, 32, 48, 64, 96. Every gap, padding and margin is one of these. If you want 20, you want 16 or 24. Dense tools use the low end (4–16), marketing pages the high end (24–96).
2. **Inside is tighter than outside.** The space between things in a group must be clearly smaller than the space between groups: a label 4–8 from its field, fields 16 apart, sections 32–48 apart. A ratio of about 1 : 2 : 4 reads instantly. Equal spacing everywhere reads as a list of unrelated items.
3. **Padding at least as large as the gap.** A card with gap 12 between its children has padding 16 or more. Content crowding its own container is the most common sign of a rushed layout.
4. **Align to few edges.** Count the distinct left edges on a screen; aim for two or three. Left-align anything that is read (text, forms, lists). Centre only short, single things: a hero line, an empty state, a dialog title. Never centre paragraphs.
5. **Size by content, then by container.** Text and buttons hug their content; the main column fills; sidebars and rails are fixed. A row is usually one flexible child and the rest hugging.
6. **Give the primary thing more.** More room, larger size, or first position — pick one or two, not all three. If everything is the same width and weight, nothing is primary.
7. **Line length is a layout matter.** Reading text sits in a column 45–75 characters wide (roughly 480–680 px at 16 px). A paragraph stretched across 1200 px is a layout bug.
8. **Radii nest.** A rounded box inside a rounded box: outer radius = inner radius + the padding between them. An inner corner rounder than the outer one looks wrong at a glance.
9. **Optical beats mathematical where they differ.** Icons with a visual lean (play triangles, arrows, chevrons) are nudged 1–2 px so they look centred. Text in a button sits about 1 px above true centre in most fonts.
10. **Leave room.** When in doubt, remove a container and add space. A screen with three levels of nested cards almost always works better with one.

## Sizes to start from

- Phone: 390 × 844 (content margins 16–20). Tablet: 768 or 834 wide (margins 24–32). Desktop: 1440 × 900 with content capped at 1200–1280 and a 12-column grid, 24 gutters.
- Touch targets: 44 × 44 minimum, 48 for primary actions. Pointer targets: 32 high is comfortable, 24 the floor.
- Game HUD (16:9, design at 1920 × 1080): keep anything essential out of the outer 5% of each edge; group by corner; the centre stays clear.

## In Superpencil

- Use auto layout for everything that is not a free composition: `layout: "vertical" | "horizontal"`, `gap`, `padding`, `justifyContent`, `alignItems`. A frame with no `layout` key is horizontal, so always write it.
- Children: `width`/`height` of `"fill_container"` to stretch, `"fit_content"` to hug, a number only where the size is a real decision (a sidebar, an avatar, an image).
- `layout: "none"` and `x`/`y` are for overlays, illustrations and HUDs, not for stacking a form.
- Put spacing values in variables when a file has more than a couple of screens (`space-2: 8`, `space-4: 16` …) and use `"$space-4"`.
- Read distances instead of guessing: `get_nodes` gives sizes; the user can hold Alt and hover to see gaps on the canvas.

## Check before you finish

- [ ] `check_layout` on every frame you touched: no overflowing text, no clipped content, no zero-size nodes.
- [ ] `screenshot` at the frame's real size and look at it small (max_size 400): do the groups still read as groups?
- [ ] Every gap and padding is on the scale. No 13, 18, 22.
- [ ] No more than three left edges per screen region.
- [ ] The widest paragraph is under ~680 px.
- [ ] Nothing important is placed with `x`/`y` inside a frame that could have used auto layout.

## Common mistakes

- Wrapping every group in a bordered, shadowed card. Space groups; cards are for things that are objects (a product, a message, a file).
- Equal 16 px everywhere, so the screen has no rhythm.
- Centred body text, centred forms, centred lists.
- A fixed width on text that should wrap with its container, or no width at all so one long line pushes the layout apart.
- Mixing radii at random (6 here, 10 there, 14 on the button). Pick a small set and nest them.
