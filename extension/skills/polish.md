# Polish

> Use when: a design works and is structurally right, and it is time to make it finished — the last pass before showing it, or when asked to "polish", "clean up", "tighten", "make it feel premium". Not for fixing a wrong layout or flow: go back to the layout or interface skill for that first.

## The idea

Polish is the removal of everything that makes a design look unconsidered. No single fix is visible; together they are the difference between "fine" and "finished". It is done slowly, at high zoom, one kind of thing at a time, and it mostly consists of making almost-equal things exactly equal and deleting what is not needed. Polish never adds decoration.

Do it in this order; earlier passes change measurements that later ones depend on.

## The passes

**1. Subtract.** Before refining anything, look for what can go: a border that a gap already implies, a label that repeats its heading, an icon that decorates, a third level of nesting, a divider between things that are already apart, a shadow on something that does not float. Remove it, screenshot, and keep the removal unless something got worse.

**2. Spacing.** Read the actual `gap` and `padding` values of every container (`get_nodes`). Snap each to the scale (4, 8, 12, 16, 24, 32, 48, 64). Make equal things equal: every card of a kind has the same padding; every section the same space above its heading. Then check the rhythm: space inside a group < space between groups < space between sections.

**3. Alignment.** Text baselines in a row line up. Icons sit on the optical centre of the text beside them (usually the x-height centre, about 1 px above the geometric centre of the line box). Left edges of stacked things are the same value, not 1–2 px apart. Anything positioned with `x`/`y` is on whole pixels (`lint_design` flags fractional positions and offers the rounding). Numbers in columns align right.

**4. Optical corrections.** Where the eye and the ruler disagree, the eye wins:
- A play triangle or chevron in a circle moves 1–2 px towards its point.
- A button with an icon on one side needs a little less padding on the icon side (e.g. 12 icon side, 16 text side).
- Text in a pill or button: equal top and bottom padding often looks low; move it up 1 px if so.
- Round shapes next to square ones are drawn 2–4% larger to look the same size.
- Large headings sit a few px left of the column edge to look aligned, because of the letters' side bearings.
- A caps-only or all-digit label has no descenders: centre it on cap height, not on the line box.

**5. Type.** Tighten letter spacing on headings above 24 px (−1% to −2.5%). Fix orphans: no heading ends with a single short word on its own line (adjust width or wording). Line heights match the size (headings 1.1–1.25, body 1.4–1.6). Remove any size or weight that is used only once without a reason. Real typographic characters: ’ “ ” – … ×, not ' " - ... x.

**6. Colour.** Every colour is a variable, or deliberately not (`lint_design` lists literals that duplicate a variable). Text levels are consistent: one primary, one muted, one faint. Borders the same colour everywhere. Pure black and pure white softened unless intended. Check that the accent appears only where it means "act" or "selected".

**7. Edges and depth.** Radii nest (inner = outer − padding). One border weight. Shadows share a direction and softness; soften any that looks like a grey smudge (lower opacity, more blur, small y offset, negative spread on the wide layer). Add the subtle things that make surfaces sit right: a 1 px inner highlight at the top of a dark raised surface, a hairline border on a white card on an off-white page. Images share ratios and corner radii with their containers.

**8. Content.** Realistic, varied text and numbers; no filler. One long case and one short case in every list. Plurals and zero cases right. Avatars and pictures that are not all the same.

**9. States and edges of the system.** Hover, pressed, focus, disabled exist for each component and are consistent with each other. Empty and error frames got the same care as the main one.

**10. Housekeeping.** Layers named for what they are (no "Frame 47", "Rectangle 12"). Empty and hidden leftover layers deleted (`lint_design` lists them). Repeated things are instances. Frames arranged in order on the canvas with even gaps, and placed in sections in a large file.

**11. Fresh eyes.** Screenshot at three sizes: full, half, and thumbnail (max_size ~300). Full for details, half for balance, thumbnail for hierarchy. Flip your attention to the negative space: are the gaps themselves well-shaped? If the design has a dark and a light theme, do all of this in both.

## The 1-pixel rules

- Borders and dividers are exactly 1 px (or exactly 2). Never 1.5.
- Sizes and positions are whole numbers; icon frames are even numbers (16, 20, 24) so they centre.
- Strokes on small icons are consistent (1.5 or 2 at 20–24 px).
- Use `strokeAlignment: "inner"` on boxes so the outer size is exact.
- Anything that should be centred has equal space on both sides — verify with numbers, then check by eye.

## What premium actually is

When someone asks for a design to "feel more premium", they are almost always asking for: more generous and more consistent space; fewer colours; fewer, more deliberate type sizes with tighter large headings; softer and fewer shadows; better pictures; calmer, shorter words; and nothing misaligned. They are not asking for gradients, glows, glass, or extra ornament. Reach for subtraction and precision first.

## In Superpencil

- Zoom in with `screenshot` on a single component (`id` of the component, `scale: 2–4`) to see edges and centring; zoom out with `max_size: 300` to judge the whole.
- `get_nodes` with depth for the real numbers; batch the corrections into one `apply_operations` call per pass so the user gets one undo step per pass.
- `lint_design` supplies ready-made fixes for fractional positions and literals that match a variable; apply them as updates.
- `check_layout` after every pass that changes text or sizes.
- Fix the component, not the instance: a correction made on a component reaches every use. Check `list_components` for what should be an instance and is not.
- Do not move, rename or restyle things the user did not ask you to touch beyond what the pass needs; say what you changed, pass by pass.

## Check before you finish

- [ ] `lint_design` and `check_layout` are both clean.
- [ ] No gap, padding, size or position value is off the scale or fractional without a reason.
- [ ] Zoomed to 400% on three components: text and icons centred, radii nested, borders crisp.
- [ ] No orphaned words in headings; no straight quotes; no filler text.
- [ ] Every component state exists and matches its siblings.
- [ ] No unnamed, empty or hidden leftover layers.
- [ ] The thumbnail still shows a clear first, second and third thing.
- [ ] You removed at least one thing.

## Common mistakes

- Polishing a layout that should have been rethought.
- Adding (a gradient, a glow, another shadow) when asked to polish.
- Fixing instances one at a time instead of the component.
- Trusting the numbers when the result looks off-centre, or trusting the eye without checking the numbers.
- Stopping at the main frame and leaving the empty state and dialogs rough.
- Rounding everything to the grid and breaking an intentional optical correction.
