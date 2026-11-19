# Better transitions

> Use when: deciding how things move — screen-to-screen navigation, opening menus, sheets and dialogs, hover and press feedback, loading, lists changing, rewards and celebrations — and when wiring a prototype. For writing the motion down for developers or implementing it, continue with the transitions-dev skill.

## The idea

Motion in an interface has three jobs: to confirm ("your press registered"), to explain ("this panel came from that button; that item went there"), and to direct attention ("look here now"). Motion that does none of these is decoration, and decoration that plays every time someone does a routine thing becomes a tax. The best interface motion is fast, comes from somewhere, and is barely noticed.

## Rules

1. **Every animation needs a reason from the three jobs.** If you cannot name it — confirm, explain, direct — remove the animation.
2. **Fast.** Most interface motion is 100–300 ms. Use this table:

   | What | Duration |
   |---|---|
   | Hover, press, toggle, checkbox, colour change | 80–150 ms |
   | Tooltip, dropdown, popover, small expand | 150–200 ms |
   | Dialog, sheet, side panel, card expanding | 200–300 ms |
   | Full-screen / page change | 250–400 ms |
   | Things leaving (any of the above) | about 70% of the entering time |
   | Celebration, reward, onboarding moment | 400–1200 ms, rarely |

   Larger distance or area → longer, within the range. Anything a person does dozens of times a day sits at the bottom of its range.
3. **Easing has a direction.** Entering or responding to the person: ease-out (fast start, gentle stop) — it feels immediate. Leaving: ease-in (gentle start, fast finish), or simply a quicker ease-out. Moving from one place on screen to another: ease-in-out. Linear only for things that are continuous (spinners, progress bars) and for pure opacity or colour fades.
4. **Things come from somewhere and go back there.** A menu grows from its button. A sheet rises from the bottom edge and leaves the same way. A detail view expands from the card that was pressed. Going forward and going back are mirror images (forward slides left, back slides right). Origin is what makes motion explanatory rather than decorative.
5. **Animate few properties: position, scale, opacity.** Combine at most two (fade + 8–16 px slide; fade + scale from 0.96). Scale-ins start at 0.9–0.97, never from 0. Travel distances are small: an entering element moves 8–24 px, not across the screen, unless it is a whole screen.
6. **Feedback is instant.** Pressed states apply at 0 ms (or within one frame) and release with a short ease-out. Never delay a response to show an animation; animate *while* the work happens.
7. **One thing moves at a time, or things move as one.** A group of items entering can stagger by 20–40 ms each, capped at about 6 items or 250 ms in total — after that, bring the rest in together. Do not have unrelated parts of the screen animating at once.
8. **Do not block.** Nothing the person wants to press is unpressable because an animation is finishing. Interruptible: reversing mid-way starts from the current position.
9. **Loading motion is honest.** Under ~300 ms: show nothing. 300 ms–1 s: a skeleton or a spinner where the content will appear. Longer: progress that actually tracks progress. Skeleton shimmer is slow and low-contrast (1.2–2 s loop).
10. **Bounce and overshoot are seasoning.** A slight overshoot (spring or "back" easing) suits playful products, toggles, and rewards. Never on dialogs, navigation, or anything in a serious tool. Never elastic wobble on text.
11. **Respect reduced motion.** Provide a version with movement removed: replace slides, scales and parallax with a short cross-fade (or nothing); keep opacity and colour changes. Essential information never depends on motion alone.
12. **Consistency.** The same kind of thing always moves the same way. Decide a small set (durations: fast / base / slow; easings: out / in / in-out; distances: small / large) and use only that — just like a spacing scale.

## Choosing a navigation transition

- **Deeper into a hierarchy** (list → detail, step 1 → step 2): the new screen slides in from the right; back reverses it.
- **Peers** (tabs, bottom navigation): cross-fade (dissolve), or no transition. Not slides, unless the tabs are literally swipeable.
- **Temporary task over the current screen** (compose, filter, pick): slides up from the bottom; dismiss slides down.
- **Replace the whole context** (sign in → app, mode switch): dissolve.
- **Instant** is a legitimate choice for dense tools and for anything repeated constantly.

## Game UI notes

Games allow more motion, because feel is part of the product — but the rules about speed and blocking get stricter, since the player is mid-action.

- Menu navigation: 100–200 ms, never blocking input; a held direction must not wait for animations.
- Press feedback is physical: scale to 0.94–0.97 on press, back with a small overshoot on release (120–180 ms).
- Rewards and level-ups are the place to spend: scale-in with overshoot, a count-up of the number (600–1000 ms, ease-out), a brief glow or particles, a sound. Make it skippable by tap.
- HUD changes (damage, pickups) flash and settle in under 300 ms and never cover the centre of the screen.
- Numbers that change count up or down rather than swapping, so the change is noticed.
- Idle motion (a gentle bob or pulse on the one thing you want pressed) is allowed on a single element per screen.

## In Superpencil

What the file can express directly:

- **Screen-to-screen:** `link: { "to": "<frame id>", "transition": "instant" | "dissolve" | "slide-left" | "slide-right" | "slide-up" | "slide-down" }` on any node; `"to": "__back"` returns and reverses. `slide-left` means the new screen comes in from the right (forward). Use `slide-up` for sheets and tasks, `dissolve` for peers and context changes. Play it in Present mode.
- **Hover and press:** component `states` named `hover` and `pressed` play automatically under the pointer in Present mode. Define them on the component, with small, consistent changes (fill step, 1–2 px shift, shadow change).
- **Before/after:** draw the start and end of any other animation as two frames (or two states) side by side, named "… – from" and "… – to".

What it cannot express (durations, easing, stagger, springs): write it down. Put a `note` beside the frames with the motion spec in the format from the transitions-dev skill, so the intent is in the file and not only in the chat.

## Check before you finish

- [ ] Every link has a transition chosen on purpose, and back reverses forward.
- [ ] Play the flow in Present mode (ask the user to, or describe what will play): nothing slides sideways between peers; sheets come up and go down.
- [ ] Every interactive component has `hover` and `pressed` states.
- [ ] Each non-trivial animation has a from frame, a to frame and a line in a motion note: what, duration, easing, origin.
- [ ] You can name the job (confirm / explain / direct) of each animation.
- [ ] A reduced-motion alternative is stated.

## Common mistakes

- 500 ms+ on routine actions; everything "smooth" and slow.
- Ease-in on entrances (it feels like lag) or linear movement (it feels mechanical).
- Elements flying in from off-screen for no reason, or scaling up from zero.
- Every section fading up on scroll.
- Stagger across twenty list items, so the last arrives a second later.
- Different durations and easings on every component.
- A loading spinner flashed for 80 ms.
- Motion as the only signal that something changed.
