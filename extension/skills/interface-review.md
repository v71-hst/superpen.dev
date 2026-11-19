# Interface review

> Use when: asked to review, critique, audit or "look over" a design; before handing a design back as finished; or when the user asks why something feels off. This is a procedure for finding problems and reporting them usefully — it does not change the design unless you are asked to fix what you find.

## The idea

A review is only useful if it is specific, ranked, and tied to evidence. "Feels cluttered" helps nobody; "the card grid has four competing accents and no primary action; the price is the smallest text on the card" can be fixed. Look first, measure second, judge third — and say what is working, because that is what must survive the fixes.

## Procedure

Work through the passes in order. Each pass has one question. Take notes as you go: layer id, what you saw, why it matters.

**0. Get the brief.** What is this screen for, who uses it, on what device? Read any `note`/`context` layers and what the user said. If unknown, state your assumption in the report. Do not review against a goal you invented silently.

**1. First glance (5 seconds).** `screenshot` each frame at a small size (max_size 400–500). Without reading: what do you notice first, second, third? Is the first thing the most important thing? Can you tell what kind of screen it is? Write the answer down before looking closer; you cannot recover a first impression later.

**2. Structure and flow.** `get_tree` (depth 3–4). Does the layer structure match what is seen (groups are groups, lists are lists)? One primary action? Is there a way back, a next step, and the empty/error/loading states (interface skill)? Follow the `link`s: any dead ends?

**3. Layout.** Screenshot at full size. Alignment (count the left edges), spacing rhythm (is inside tighter than outside?), values on a scale, consistent padding, line lengths, nothing crowding an edge (layout skill). `check_layout` for overflow, clipping, overlap.

**4. Typography.** Count sizes and weights. Is the hierarchy visible when you squint? Line heights, measure, alignment, orphans (typography skill).

**5. Colour and contrast.** Count the hues. Is the accent reserved for action? `lint_design` for contrast failures and hard-coded colours. Look at text over images yourself (colors and accessibility skills).

**6. Components and states.** `list_components`. Are repeated things instances? Do buttons/inputs share height, radius, type? Do interactive parts have hover, pressed, focus, disabled states (ui skill)? Radii, borders and shadows: how many kinds?

**7. Words.** Read every text once, as the user would (writing skill): specific labels, one name per thing, no filler, errors and empty states that help.

**8. Accessibility.** Target sizes, colour-only meaning, visible labels, focus, reading order (accessibility skill).

**9. Character.** Could this be any product with the logo swapped? Which decisions are specific to this one (un-ai skill)? Is there one thing that makes it memorable?

**10. Edge cases.** Mentally (or actually, on a duplicate) double the longest text, empty the list, add a 30-character name, switch the theme. What breaks?

For a quick review, do passes 1, 3, 5 and 7. For a full one, all of them.

## Severity

Rank every finding. Use these three levels and be strict about them:

- **Blocker** — someone cannot complete the task, cannot read something essential, or will be misled: missing action, text that fails contrast badly, broken layout, a destructive action with no guard, wrong information.
- **Should fix** — works, but costs people effort or makes the product look careless: weak hierarchy, inconsistent components, vague labels, missing states, off-scale spacing, targets that are too small.
- **Polish** — only noticed side by side: a pixel off, a slightly heavy shadow, an orphaned word.

If you have more than about three blockers, the problem is usually upstream (the structure or the brief), and the report should say that instead of listing forty symptoms.

## Reporting

Write the report in your reply to the user (not into the file, unless asked). Keep it scannable:

1. **Verdict in one or two sentences**: is it ready, and what is the single most important thing to change.
2. **What works** — two to four specific things to keep. Not flattery; decisions that are good and should not be undone by the fixes.
3. **Findings, most severe first.** Each one: *where* (frame and layer name; id in brackets), *what* (the observation, with the number: "contrast 2.9 : 1", "five font sizes between 13 and 16", "gaps of 12, 14, 16 and 18"), *why it matters* (the effect on the person using it), *fix* (the concrete change: "set to `$text-muted` #5E5E66", "merge into one 16 gap").
4. **Open questions** — things only the user can decide.

Group findings that share a cause ("spacing is not on a scale: 9 places") instead of listing each occurrence. Aim for five to twelve findings; nobody acts on forty.

Offer to apply the fixes; apply them only when asked, or when the user asked for a review *and fix*. If the user uses canvas comments, findings can also be left where they are found only if they ask for that.

## Rules for the reviewer

1. **Evidence over taste.** Every finding points at a layer and a measurable thing or a named principle. "I would have used blue" is not a finding.
2. **Review the design that exists, for the goal it has.** Do not redesign it into your own preference. A loud, dense, maximal game shop can be a correct design.
3. **Separate what is wrong from what is different.** Unusual is fine if it is consistent and serves the user.
4. **Check before claiming.** Compute the contrast, read the actual gap values from `get_nodes`, look at the real screenshot. Do not report problems inferred from the tree alone, and do not report things you did not look at as fine.
5. **Do not move the user's view.** Use `screenshot` by id; do not zoom the canvas (`set_selection` with zoom) unless asked to show something.
6. **Say what you did not review** (states that are not drawn, flows not linked, frames in hidden sections).

## After fixes

Re-run the passes that had findings, `check_layout` and `lint_design`, and screenshot again. Report what changed and anything that remains, in the same order as the original findings.

## In Superpencil

- Scope first: `get_selection` (the user may have picked what they want reviewed), else `get_editor_state` for the list of top-level frames. In a file with sections, `list_sections` and say which ones you covered; frames in hidden sections can still be read and screenshotted.
- Looking: `screenshot` with `id` and `max_size` (400–500 for the first glance, the default for detail, `scale` 2–4 on one component for edges). It never moves the user's view.
- Measuring: `get_tree` for structure and sizes, `get_nodes` for exact gaps, padding, fills and fonts, `get_variables` and `list_components` for the system the file already has.
- Automatic checks: `check_layout` (overflow, clipping, overlap, missing icons/fonts/variables) and `lint_design` (contrast, tiny text, literals that duplicate a variable, fractional positions, leftovers). Group their output by cause in the report; do not paste it.
- Words: `search_nodes` with type text to read every string in one list.
- If the user has pinned comments, `get_comments` first: they are part of the brief. Reply with `reply_comment` when a comment is answered by the review.
- Fixing (only when asked): one `apply_operations` batch per finding or per group, so each is one undo step; fix components rather than instances.

## Check before you finish

- [ ] The brief (or your stated assumption about it) is at the top of the report.
- [ ] You looked at a real screenshot of every frame you report on, small and full size.
- [ ] `check_layout` and `lint_design` were run, and their results are grouped and ranked, not pasted.
- [ ] Every finding has where, what (with a number), why and a concrete fix.
- [ ] Findings are ordered by severity, and there are no more than about twelve.
- [ ] The report says what works, and what was not reviewed.
- [ ] Nothing in the file was changed unless the user asked for fixes.

## Common mistakes in reviews

- A list of nitpicks with the structural problem buried at number 14.
- Praise sandwich with no specifics.
- Reporting tool output raw (thirty lint lines) instead of grouping and ranking it.
- Suggesting a full restyle when asked for a review.
- "Consider improving the hierarchy" — say which element should be larger, and by how much.
- Reviewing only the one ideal-state frame and calling the product reviewed.
