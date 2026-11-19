# Better typography

> Use when: setting any text — choosing fonts, sizes and weights for a screen or a design system, fixing text that feels cramped, loud or flat, or making a hierarchy clearer.

## The idea

Most of an interface is text. Typography is how that text is ranked and how comfortably it reads. Good typography uses very few sizes and weights, makes each step between them obvious, and gives lines the room they need. Hierarchy comes from contrast between levels, not from making everything a little different.

## Rules

1. **A short scale, with real steps.** Pick sizes from one scale and use at most five or six on a screen. A dependable one: 12, 14, 16, 20, 24, 32, 48, 64. Adjacent text levels should differ by a clear step (14 → 20, not 14 → 15).
2. **Body text is 14–16 on desktop, 16–17 on phones.** 12 is for captions and labels only. Nothing smaller than 11, ever; on a game HUD seen from a couch or a small phone, nothing smaller than what reads at arm's length (usually 18+ at 1080p).
3. **Two weights do most of the work.** Regular (400) and one emphasis weight (600, or 500 for a quieter interface). Add 700+ only for display headings. Five weights on a screen is noise.
4. **Rank with one or two signals, not all of them.** Size, weight and colour are three separate dials. A heading that is bigger *and* bolder *and* brighter than everything shouts; secondary text that is smaller *and* lighter *and* greyer disappears. Change one dial per step, two for the top level.
5. **Line height follows size.** Body text 1.4–1.6. Headings 1.1–1.25. Large display text (48+) 1.0–1.1. Single-line UI labels and buttons 1.2–1.3. In `.pen`, `lineHeight` is a multiplier of the font size.
6. **Letter spacing follows size too.** Big headings tighter: about −1% to −2.5% of the size (a 48 px heading: −0.5 to −1.2 px). Body text: 0. Small all-caps labels: +4% to +8% (an 11 px label: +0.5 to +0.9 px). `letterSpacing` is in px.
7. **Line length 45–75 characters.** Use `textGrowth: "fixed-width"` with a width that gives that measure (about 30–40× the font size... 480–680 px at 16 px). Captions can be shorter; never longer.
8. **Left-align what is read.** Centre only one- or two-line headings and short empty-state messages. Justified text has no place in an interface.
9. **Text colour has levels.** Primary text near full contrast, secondary around 60–70%, disabled/hint around 40% — as separate colours or variables, not ad-hoc opacities. Check each against its background (see the accessibility skill).
10. **Numbers that change or line up need tabular figures and consistent width.** Prices, timers, scores, table columns: give them a fixed-width container and right-align columns of numbers.

## Choosing fonts

- One family is enough for most interfaces; two is the limit (one for display, one for text). A second family earns its place by being clearly different, not slightly different.
- `fontFamily` takes Google Fonts names. Dependable text faces: Inter, IBM Plex Sans, Source Sans 3, DM Sans, Manrope, Figtree, Public Sans. With more character for headings: Space Grotesk, Sora, Bricolage Grotesque, Fraunces (serif), Playfair Display (serif), Instrument Serif. Monospace for code and data: JetBrains Mono, IBM Plex Mono, Roboto Mono. Game UI often wants something bolder and rounder: Fredoka, Baloo 2, Lilita One, Bangers (titles only), Russo One, Chakra Petch.
- Check that the weights you use exist in the family before relying on them (many display faces have one weight).
- Use the family the file already uses unless you were asked to change it. Look first: `search_nodes` for text nodes, `get_variables` for a font variable.

## In Superpencil

- Text props: `fontFamily`, `fontSize`, `fontWeight` (a string: `"400"`, `"600"`), `fontStyle: "italic"`, `lineHeight` (multiplier), `letterSpacing` (px), `textAlign`, `textAlignVertical`, `underline`, `strikethrough`.
- `textGrowth: "auto"` is one line that grows sideways (labels, buttons, headings that must not wrap). `"fixed-width"` wraps at `width` and grows downward (paragraphs, anything in a column). `"fixed-width-height"` clips or overflows: use it only when a box must not grow.
- In an auto-layout parent, a paragraph should usually be `width: "fill_container"` with `textGrowth: "fixed-width"`.
- Put the family and the main colours in variables (`$font`, `$text`, `$text-muted`) so a restyle is one change.

## Check before you finish

- [ ] Count the distinct font sizes on the screen: six or fewer. Count the weights: three or fewer.
- [ ] Squint at a small screenshot: can you tell level 1, level 2 and body apart without reading?
- [ ] `check_layout`: no overflowing or overlapping text; then read every text for an orphaned single word on the last line of a heading and fix it by width or wording.
- [ ] Body line height is at least 1.4; no heading above 32 px has a line height over 1.25.
- [ ] `lint_design` reports no tiny or low-contrast text.
- [ ] Long text has a width; short labels do not wrap.

## Common mistakes

- Default everything: one family at 400 and 700, sizes 14/16/18/20/22/24 all present. A scale with no gaps has no hierarchy.
- All-caps for anything longer than three words, or all-caps without added letter spacing.
- Grey text on a coloured or image background without checking it can be read.
- Headings with body line height (a 40 px heading at 1.5 looks like it is falling apart).
- Making secondary text smaller, lighter and greyer at once until nobody can read it.
- Centred paragraphs, and lines 120 characters long.
