# Better colors

> Use when: choosing or fixing a palette, building light and dark themes, deciding where an accent goes, or when a design looks muddy, garish or generic.

## The idea

An interface is mostly neutral. Colour is a signal: it says "this is the brand", "this is the thing to press", "this went wrong". Every extra colour weakens those signals. A strong palette is a careful set of neutrals, one accent used sparingly, and a few semantic colours that only appear when they mean something.

## Rules

1. **Build the neutrals first.** Nine to eleven steps from background to strongest text. Tint them slightly towards the accent's hue or a deliberate warm/cool direction; pure greys look dead next to any colour. Most of the screen is drawn with steps 1–3 (surfaces), 4–6 (borders, dividers, disabled) and 9–11 (text).
2. **One accent.** One hue for primary actions, links, selection and focus. If a second strong colour appears, it needs a job the first one cannot do. A reasonable budget: about 60% background neutrals, 30% secondary neutrals and text, 10% or less accent.
3. **Semantic colours are reserved.** Red for destructive and error, green for success, amber for warning, blue for information. Never use them decoratively, and never use red as the brand accent on screens that also show errors.
4. **Every pair must pass contrast.** Text on its background: 4.5 : 1 for body, 3 : 1 for large text (24 px+, or 18.7 px+ bold) and for the edges of controls and meaningful icons. Decide the pairs when you define the palette (`text` on `bg`, `text` on `surface`, `accent-fg` on `accent`), not afterwards.
5. **Avoid pure black on pure white, and pure white on pure black, for large areas.** Use a near-black (#111–#1A1A1A range) and an off-white. The exception is a deliberate high-contrast or brutalist look.
6. **Dark themes are not inverted light themes.** Backgrounds are dark greys, not black; elevation is shown by a *lighter* surface, not a shadow; accents are a little lighter and less saturated than in the light theme; borders are low-alpha white (around 8–14%) rather than solid greys.
7. **States come from the base colour.** Hover: about 4–8% lighter or darker. Pressed: about twice that. Disabled: the neutral, not a faded accent. Focus: a 2 px ring in the accent with a 2 px gap.
8. **Saturation is a budget.** Large areas want low saturation; small areas (a button, a badge, an icon) can carry high saturation. A fully saturated background behind text is almost always a mistake.
9. **Gradients need a reason.** If used: two stops, neighbouring hues or one hue at two lightnesses, low contrast between the stops, one direction across the product. A gradient is never a substitute for choosing a colour.
10. **Do not carry meaning by colour alone.** Pair it with an icon, a label, a shape or a position (see the accessibility skill).

## A palette that works, as a starting shape

Name by role, not by look, so themes can swap the values:

| Variable | Light | Dark | Used for |
|---|---|---|---|
| `bg` | #FAFAF9 | #0F1012 | page / canvas |
| `surface` | #FFFFFF | #17181B | cards, panels |
| `surface-2` | #F3F3F1 | #1F2125 | inset areas, hover |
| `border` | #E4E4E0 | #FFFFFF1A | dividers, outlines |
| `text` | #16161A | #EDEDEF | primary text |
| `text-muted` | #5E5E66 | #A0A0A8 | secondary text |
| `text-faint` | #8C8C94 | #6E6E76 | hints, disabled |
| `accent` | one hue, 45–55% lightness | same hue, 60–68% lightness | primary actions |
| `accent-fg` | #FFFFFF | #0F1012 or #FFFFFF | text on the accent |
| `danger` / `success` / `warning` | ~45–50% lightness | ~62–68% lightness | status only |

Replace the hexes; keep the roles and check the pairs.

## In Superpencil

- Define colours once with `set_variables` and reference them as `"$accent"`. Themes: `themes: { "Mode": ["Light", "Dark"] }` and themed values `[{ "value": "#FFFFFF" }, { "value": "#17181B", "theme": { "Mode": "Dark" } }]`; set `theme: { "Mode": "Dark" }` on a frame to see that subtree in dark.
- `get_variables` before you invent anything: reuse the file's palette.
- Fills take `"#RRGGBB"` or `"#RRGGBBAA"`. Use the alpha form for borders and overlays on dark surfaces.
- Gradients: `{ type: "gradient", gradientType: "linear", rotation, colors: [{ color, position }] }`; mesh gradients for soft organic fields. Use them where the product has a reason, not on every button.
- `lint_design` flags hard-coded colours that should be variables and low-contrast text. Run it.
- When judging a palette, `screenshot` the frame and look at it at 25% size: you should see one or two spots of accent, not a mosaic.

## Check before you finish

- [ ] Count the hues on the screen, excluding neutrals: one, plus status colours only where there is a status.
- [ ] Every text/background pair you used passes 4.5 : 1 (3 : 1 for large text). Compute it; do not eyeball it.
- [ ] No hard-coded hex where a variable exists (`lint_design`).
- [ ] If there is a dark theme: surfaces get lighter with elevation, the accent was adjusted rather than reused, and borders are visible.
- [ ] The primary action is the most saturated thing on the screen, and there is only one of it.

## Common mistakes

- Purple-to-blue gradients on buttons, headings and backgrounds because it looks "modern". It looks like everything else.
- Five accent colours "for variety".
- Grey text chosen by eye that fails contrast (anything lighter than about #767676 on white fails for body text).
- Dark theme made by swapping black and white: glaring text, invisible borders, neon accents.
- Status colours as decoration (a green "Pro" badge, a red marketing banner), which trains people to ignore them.
- Opacity instead of colours for text levels on coloured backgrounds, which goes muddy.
