# Better accessibility

> Use when: designing or reviewing anything people must read, press or fill in — and always before calling a screen finished. Also when asked about contrast, colour blindness, touch targets, focus, or "can everyone use this?".

## The idea

Accessibility is not a layer added at the end; it is the floor the design stands on. Most of it is decided in the design file: whether text can be read, whether a control can be hit, whether a state can be told apart without colour, whether the order of things makes sense. Designs that pass are also simply clearer for everyone — in sunlight, on a small phone, in a hurry.

The target is WCAG 2.2 level AA. The numbers below are that standard's; do not soften them.

## Rules

1. **Text contrast: 4.5 : 1.** For large text — 24 px and up, or 18.7 px and up when bold — 3 : 1. This covers placeholder text, text on buttons, text over images and "muted" text. Only disabled controls and pure decoration are exempt.
2. **Non-text contrast: 3 : 1.** The outline or fill that makes a control recognisable (an input's border, a checkbox, a toggle's track), icons that carry meaning, focus rings, and the parts of a chart that must be told apart.
3. **Never colour alone.** An error is red *and* has an icon and a message. A selected tab has a colour *and* an underline or weight change. A required field has a word or an asterisk explained once. Chart series differ in shape, label or pattern as well as hue. Test: would it still work in greyscale?
4. **Targets: 44 × 44 for touch, 24 × 24 as the absolute floor for anything.** The visible shape can be smaller (a 20 px icon) if the pressable frame around it is big enough. Adjacent targets need at least 8 px between them unless each is already 44+.
5. **Every state is visible.** Default, hover, focus, pressed, selected, disabled, loading, error. Focus is the one most often forgotten: a 2 px ring with at least 3 : 1 against what is around it, offset 2 px from the control. Never remove a focus indicator without replacing it.
6. **Text over pictures needs help.** A scrim (a dark gradient or a 40–60% overlay behind the text), a solid plate, or a spot in the picture that is reliably plain. Check contrast against the *lightest* part behind white text and the *darkest* part behind dark text.
7. **Text must survive growing.** People enlarge text to 200%. Containers hug their content and wrap; nothing depends on a label fitting on one line. No text baked into images.
8. **Labels are visible and stay visible.** Every field has a label outside the field. Placeholder text is a hint, not a label: it vanishes on typing and usually fails contrast.
9. **Errors say what and how.** Next to the field, in words, with the fix: "Enter a date in the future", not "Invalid". Do not rely on a red border alone, and do not clear what the person typed.
10. **Order is meaning.** The layer order of a frame is the reading and focus order. Top to bottom, left to right, matching what is seen. Headings descend in order (one level-1 per screen, no skipped levels) and are not chosen for their size.
11. **Motion can be turned off.** Nothing flashes more than three times a second. Anything that moves on its own for more than five seconds can be paused. Essential information never arrives only through animation (see the transitions skills).
12. **Do not hide actions behind hover or gestures alone.** Anything revealed on hover must also be reachable by focus and by touch; any swipe or drag has a button that does the same thing.

## Contrast you can compute

Relative luminance of a colour: convert each channel c (0–1): c ≤ 0.04045 → c / 12.92, else ((c + 0.055) / 1.055)^2.4; then L = 0.2126 R + 0.7152 G + 0.0722 B. Ratio = (L_lighter + 0.05) / (L_darker + 0.05).

Anchors worth remembering: on white, #767676 is 4.54 : 1 (the lightest grey that passes for body text), #595959 is 7 : 1, #949494 is 3.03 : 1 (the lightest for large text and control borders). White text needs a background at least as dark as #767676. Semi-transparent text: compute against the colour it blends to, not the declared colour.

## Colour-blind-safe choices

- Red/green is the pair most often confused; a red and a green of the same lightness are indistinguishable for roughly 1 in 12 men. Make the two differ in lightness as well, and add an icon (✕ and ✓ shapes, not coloured dots).
- Safer status set: blue for neutral/info, orange or amber for warning, a dark red for error, with icons throughout.
- In charts, use no more than about six series before grouping or labelling directly.

## For games and HUDs

- Text is read at a distance and during action: minimum sizes rise (about 28 px for body at 1080p on TV, 18+ on phone HUDs) and contrast should aim for 7 : 1 with an outline or plate behind anything over the 3D scene.
- Team, rarity and status colours need a second cue: an icon, a shape, a border style, a letter.
- Keep critical HUD inside the safe area (outer 5% clear) and away from thumb zones on phones unless it is a control.
- Buttons for touch: 48+ px at phone scale, and never smaller than a fingertip after the UI is scaled to a small screen.

## In Superpencil

- `lint_design` computes the contrast of every text against the background behind it and names the layers that fail, and flags text under 10 px. Run it on every screen; treat "info" contrast notes as failures too.
- It cannot judge text over images or gradients reliably: `screenshot` those and check by eye at 50% size, then add a scrim.
- Sizes of targets: `get_tree` prints each node's size; look for buttons and icon buttons under 44 on touch screens.
- Build the states as component `states` (`hover`, `pressed`, `disabled`, plus `focus` and `error` where they apply) so they exist in the file rather than in someone's imagination.
- Order layers in reading order; name them for what they are ("Email field", "Submit"), since names are what a developer turns into accessible labels.
- Write anything a screen reader needs that the picture cannot show (alt text for meaningful images, the label of an icon-only button) in a `note` beside the frame, or in the layer name.

## Check before you finish

- [ ] `lint_design`: no contrast or tiny-text issues left.
- [ ] Greyscale test: looking at a screenshot, can you still tell selected from unselected, error from fine, primary from secondary?
- [ ] Every pressable thing is at least 44 × 44 on touch designs (24 × 24 elsewhere), with 8 px between neighbours.
- [ ] A focus state exists for every interactive component.
- [ ] Every field has a visible label; every error has words.
- [ ] No text sits directly on a busy picture.
- [ ] Icon-only buttons have a name written somewhere (layer name or note).
- [ ] Doubling the longest label does not break the layout (try it on one).

## Common mistakes

- Light grey placeholder used as the label.
- A beautiful low-contrast "muted" palette: #A0A0A0 on white is 2.6 : 1 and fails everything.
- White text on a mid-saturation brand colour (most oranges, yellows, light greens and sky blues fail with white; use dark text on them).
- Focus rings removed because they "look messy".
- Icon-only toolbars with 24 px hit areas on a phone.
- Red/green as the only difference between two states.
- Disabled buttons so faint the label cannot be read at all — disabled may drop below 4.5 : 1, but people still need to know what is unavailable.
