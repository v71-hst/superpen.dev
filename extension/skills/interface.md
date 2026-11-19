# Better interface

> Use when: deciding how something works rather than how it looks — what goes on a screen, how a flow is split into steps, where navigation lives, how forms, lists, dialogs, feedback and errors behave. Read it before designing a new screen or flow.

## The idea

An interface is a conversation: the person wants something, the screen offers ways to get it, and after every action it answers. Good interfaces make the next step obvious, answer immediately, never lose work, and ask for as little as possible. Decide these things before drawing anything; a handsome screen that solves the wrong problem is still wrong.

## Before drawing: answer four questions

1. **Who is here and what did they come to do?** One sentence. ("A player between rounds who wants to spend coins before the next match starts.")
2. **What is the one thing this screen is for?** If the answer has an "and", it may be two screens, or one screen with a clear primary and a secondary.
3. **What do they need to see to do it?** List the content. Everything not on the list has to argue its way in.
4. **Where do they come from and where do they go next?** Entry, the success exit, the cancel exit, the failure exit.

Write the answers in your reply or in a `context` note beside the frame. They are the brief you check the design against.

## Rules

1. **One primary action per view.** One filled, accent-coloured button. Everything else is secondary (outline or neutral fill) or tertiary (text only). Two primaries is zero primaries.
2. **Put things where people look for them.** Navigation at the top or left (bottom bar on phones, 3–5 items). The primary action at the end of the content it concludes: bottom of a form, bottom-right of a dialog, within thumb reach on phones. Destructive actions away from the primary. Follow the platform's conventions before inventing.
3. **Show, then ask.** Prefer choosing from visible options over typing; prefer sensible defaults over empty fields; prefer editing in place over a separate edit screen. Up to about five options: show them all (segmented control, radio). More: a list or dropdown. Many more: search.
4. **Design every state, not just the full one.** Each screen with data has at least: empty (first use — say what goes here and offer the first action), loading (skeleton in the shape of the content for more than ~300 ms), partial, full/ideal, too much (long names, 999+ items, three-line titles), error, offline/no permission. Draw the empty, error and too-much states as frames; they are where designs break.
5. **Answer every action within 100 ms.** A press shows a pressed state at once. Results under 1 s need no indicator; 1–10 s need a spinner or progress in the place where the result will appear; longer needs progress with a number, and should not block the rest of the app.
6. **Forgive.** Undo beats confirmation. Confirm only what cannot be undone, and make the confirm button say what it does ("Delete 3 files"), never "OK". Keep what was typed when something fails. Autosave where possible.
7. **Reduce what must be remembered.** Keep context visible (the item's name in the dialog that deletes it, the step count in a flow, the filters that are active). Do not make people carry a value from one screen to the next in their heads.
8. **Progressive disclosure.** Show what most people need most of the time; put the rest one step away behind a clearly labelled "Advanced", "More" or a detail view. Never hide the main action there.
9. **Forms.** One column. Labels above fields. Group related fields under a short heading; order by how people think about the task, easiest first. Mark the optional fields ("optional"), not the required ones, when most are required. Field width hints at the answer's length. Validate when a field is left, not on every keystroke; say errors beside the field. The submit button states the outcome ("Create account").
10. **Lists and tables.** The first column or line is the thing's name; it is what people scan. Align text left, numbers right. Put row actions at the row's end, shown on hover *and* reachable otherwise. Give long lists search, sort or filters before pagination.
11. **Dialogs are interruptions.** Use them for decisions that must be made now. Title is the question or the action; body is the consequence; buttons are verbs. Everything else belongs inline, in a side panel, or on its own page. Never stack dialogs.
12. **Be consistent, inside the product first.** The same thing looks and behaves the same everywhere; different things look different. Reuse the file's components (`list_components`) before making new ones.

## Patterns by size

- **Phone:** one column, one task per screen, bottom navigation or a top bar with back; primary action fixed at the bottom when the content scrolls; sheets instead of dialogs for choices.
- **Tablet / small window:** two panes (list + detail) when both fit at comfortable widths (list 280–360), otherwise the phone pattern.
- **Desktop:** persistent navigation (sidebar 220–280 or top bar), content capped in width, side panels for inspecting without leaving, keyboard shortcuts for frequent actions.
- **Game UI:** the game is the content; UI gets out of the way. HUD shows only what changes decisions in the next few seconds; everything else lives in menus. Menus have an obvious way back (same place every time), a clear current selection for controller/keyboard, and confirmation only for spending premium currency or losing progress. Show cost, what you have, and what you will have after, together.

## In Superpencil

- One top-level frame per screen or state, named for it ("Shop", "Shop – empty", "Shop – purchase failed"). Put the frames of a flow in a row, in order, and group them in a section (`create_section`).
- Wire the flow with `link` (`{ "to": "<frame id>", "transition": "slide-left" }`, back buttons `"__back"`) so the user can press through it in Present mode. A flow that cannot be clicked through has gaps you have not seen.
- Interactive components get `states` (`hover`, `pressed`, `disabled`; `focus`, `selected`, `error` where relevant).
- Use slots in components for the parts that vary (a card body, dialog actions) so every dialog and card stays the same component.
- Write the four answers and any behaviour the picture cannot show (what happens on tap, validation rules, limits) in a `note` beside the frame.

## Check before you finish

- [ ] Each screen has exactly one primary action, and it is the first thing you notice in a small screenshot.
- [ ] Empty, loading, error and too-much states exist for every screen that shows data.
- [ ] Every screen has a way back and a way forward; the flow is linked and plays in Present mode.
- [ ] Every destructive action has undo or a specific confirmation.
- [ ] Longest realistic content (name, number, translation ~30% longer) still fits.
- [ ] Nothing on the screen is there "because screens like this usually have one".

## Common mistakes

- Designing only the ideal state with perfect, short content.
- Three equally loud buttons.
- Confirmation dialogs for harmless actions, and none for the dangerous one.
- A dashboard of cards nobody asked for instead of the one list people came to see.
- Icons without labels for anything but the most universal actions (close, search, back, more, settings).
- Hiding navigation in a hamburger on a screen with room for it.
- Asking for information the product already has, or does not need yet.
