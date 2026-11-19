# Better UI

> Use when: drawing the parts — buttons, inputs, cards, navigation, lists, badges, icons, dialogs — or setting up a component system. This is the craft of surfaces, edges, depth and states. (What goes on the screen and how it behaves is the interface skill; spacing is layout; text is typography.)

## The idea

Good UI is a small system applied without exceptions: a few sizes, a few radii, one way of showing depth, one way of showing each state. People should be able to tell what is pressable, what is selected and what is just information without thinking. Restraint reads as quality; every extra border, shadow and colour has to be doing a job.

## Rules

1. **Decide the system before the screens.** Write down: control heights, radii, border colour and width, the elevation levels, the icon set and size, the accent. Then only use those. A workable default set:
   - Control heights: 32 (compact), 40 (default), 48 (touch / primary on phones).
   - Radii: one family — e.g. 6 for controls, 10 for cards, 16 for sheets and dialogs, full for pills and avatars. Sharp (0–2) and very round (12+ on controls) are both fine choices; mixing them is not.
   - Borders: 1 px, one neutral colour, low contrast against the surface (but 3 : 1 where the border *is* the control, as on inputs).
   - Icons: one library, one size per context (16 in dense rows, 20 beside 14–16 px text, 24 standalone), one stroke weight.
2. **Separate with the lightest thing that works.** In order: space → a background tint → a 1 px border → a shadow. Use one per boundary. A card with a border *and* a shadow *and* a different background is three answers to one question.
3. **Depth has few levels and one light.** Level 0: the page. Level 1: cards and panels (a border, or a very soft shadow). Level 2: menus, popovers, sticky bars. Level 3: dialogs. Shadows come from above (positive y offset), are low-opacity (6–16% black), blurred more than offset, and tinted towards the background rather than pure black. Two stacked shadows — a tight one and a wide one — look more real than a single one. On dark themes, raise the surface colour instead of adding shadow.
4. **Buttons have a clear ladder.** Primary: accent fill, contrasting text. Secondary: neutral fill or 1 px outline. Tertiary: text only. Destructive: red, used only at the moment of destruction. All four share height, radius, font size and weight; horizontal padding is about 1.5–2× the vertical. A label is a verb. An icon in a button sits 6–8 px from the text and matches its cap height visually.
5. **Every interactive part has all its states.** Default, hover (a small step in fill, 4–8%), pressed (a larger step, and/or 1 px down or 98% scale), focus (2 px ring, offset 2), disabled (neutral colours, no shadow, still legible), loading (spinner replaces the icon or label; width does not change), and selected/on for toggles and tabs. Draw them once on the component as states; do not improvise them per screen.
6. **Inputs look like inputs.** A visible boundary on all sides or a filled background, 40–48 high, label above, 12–14 px inner padding, text the same size as body. Focus changes the border to the accent plus a ring; error changes it to red and adds a message below. Do not style inputs as bare underlines on busy backgrounds.
7. **Cards are for objects.** A product, a message, a file, a player — something a person might pick up, open or act on. One padding value per card size (16 or 20 or 24). The whole card is pressable, or specific things inside it are; not both ambiguously. Never nest cards more than one level.
8. **Icons clarify, text names.** Use icons from one family (`icon` nodes). Pair them with labels except for the handful everyone knows (close, search, back, more, settings, add). Do not decorate every list item and heading with an icon; an icon on everything is noise.
9. **Badges, chips and tags are quiet.** Small text (11–12), tinted background of the same hue at low saturation or a plain neutral, fully rounded or matching the control radius. Reserve solid, saturated badges for counts and urgent status.
10. **Imagery is content.** Real pictures or carefully made illustration at consistent ratios (1:1, 4:3, 16:9), corners matching the card they sit in. Grey boxes are fine in a wireframe and a failure in a finished design; a tasteful placeholder (tinted fill + an icon, or initials for avatars) beats a random stock image.
11. **Dividers are a last resort.** If a list needs lines to be readable, try more row padding first. If lines stay, make them 1 px, low contrast, and inset to the text edge.
12. **Density is a decision.** Tools people use for hours: compact rows (32–40), 13–14 px text, more on screen. Consumer and marketing: generous (48–64 rows, 16 px+ text). Pick per product, not per component.

## Game UI notes

- Controls need to read over a moving 3D scene: stronger outlines, a dark plate or stroke behind text and icons, larger hit areas.
- Depth can be louder (bevels, thick borders, inner highlights, drop shadows with no blur) if the game's style is; the rule about *one consistent system* still holds: one bevel direction, one outline width, one corner style.
- Show rarity, team and currency with a consistent colour *and* shape/icon across every screen.
- Buttons need obvious pressed and disabled looks and, for controller/keyboard, a selected look that is unmistakable (thick outline or scale, not a subtle tint).
- Nine-slice-friendly shapes (flat centres, detail only at corners and edges) survive resizing in the engine.

## In Superpencil

- Make each part a component (`reusable: true`) the first time you need it twice; give it `states`; use `instantiate` afterwards. `list_components` first — the file may already have it, or an imported library may (`"alias:id"`).
- Use `slot` on the frame inside a component that holds varying content (card body, dialog actions, list rows).
- Put the system in variables: `$radius-control`, `$radius-card`, `$border`, `$surface`, `$accent`, `$shadow` colours, so components stay consistent and themes work.
- Shadows: `effect: [{ "type": "shadow", "shadowType": "outer", "offset": { "x": 0, "y": 1 }, "blur": 2, "color": "#0000000F" }, { "type": "shadow", "shadowType": "outer", "offset": { "x": 0, "y": 8 }, "blur": 24, "spread": -4, "color": "#00000014" }]`.
- Borders: `stroke` with `strokeWidth: 1` and `strokeAlignment: "inner"` so sizes stay exact.
- Icons: `{ "type": "icon", "library": "lucide", "icon": "search", "width": 20, "height": 20, "fill": "$text-muted" }`. `check_layout` reports icon names that do not exist.
- Nested radii: inner = outer − padding (a 16-radius card with 8 padding holds 8-radius children).

## Check before you finish

- [ ] List the distinct radii, border colours, shadow styles and control heights you used. Each list is three items or fewer.
- [ ] Every boundary uses one separator (space, tint, border or shadow), not a stack.
- [ ] Each interactive component has hover, pressed, focus and disabled states defined.
- [ ] One icon library, consistent sizes; no icon is doing decoration only.
- [ ] Buttons: one primary per view; all buttons share height and radius.
- [ ] Repeated parts are instances of a component, not copies (`list_components` shows instance counts).
- [ ] `screenshot` at full size and zoom into two or three components: edges crisp, icons centred, text not touching borders.

## Common mistakes

- Border + shadow + gradient on the same card.
- Shadows that are grey, heavy and directly below (0 4 4 at 25% black): they look like dirt.
- A different radius on every element.
- Ghost buttons everywhere so nothing looks pressable; or everything filled so nothing is primary.
- Icons in coloured rounded squares on every feature card.
- Disabled states made by dropping opacity to 30% over an image or coloured surface.
- Components copied and edited per screen until no two buttons match.
