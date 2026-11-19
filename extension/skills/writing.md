# Better writing

> Use when: putting any words into a design — button labels, headings, empty states, errors, confirmations, onboarding, tooltips, placeholder content — or reviewing the words already there. Never leave lorem ipsum or filler in a finished design.

## The idea

The words are the interface. People do not read screens, they scan for the word that matches what they want, press it, and move on. So interface writing is short, specific, and says the thing in the words the person would use. Clear beats clever every time; a design filled with realistic text also shows layout problems that placeholder text hides.

## Rules

1. **Say the specific thing.** "Save changes", "Send invite", "Buy for 250 coins" — not "Submit", "OK", "Continue". A heading names what is on the screen ("Your orders"), not a mood ("Welcome back to your dashboard!").
2. **Lead with what matters.** The first two words carry the line. "Payment failed. Check your card details." not "We're sorry, but unfortunately there was an issue processing…".
3. **Buttons are verbs; the verb matches the title.** A dialog titled "Delete project?" has buttons "Delete project" and "Cancel". Never "Yes" / "No": people read buttons, not questions.
4. **One name per thing.** If it is a "project" in the sidebar it is a "project" everywhere — not a "workspace" in settings and a "board" in the empty state. Keep a short word list for the file and stick to it.
5. **Plain words.** Use / choose / remove / turn on, not utilise / select / eliminate / enable. No jargon the person did not bring with them. No internal names for things.
6. **Short, then shorter.** Buttons 1–3 words. Headings under 6. Helper text one sentence. Body in a dialog two sentences at most. Cut "please", "simply", "just", "successfully", "in order to", "you can", "are you sure you want to".
7. **Sentence case.** "Create new project", not "Create New Project". Capitalise only the first word and proper names. No full stop on labels, headings, buttons or single-sentence tooltips; full stops on body sentences.
8. **Errors: what happened, why if useful, what to do.** In the person's terms, without blame, without codes as the main message. "That email is already registered. Sign in instead?" Good errors offer the fix as a button.
9. **Empty states are invitations.** Say what will appear here and how to make the first one: "No saved outfits yet. Save one from the editor to see it here." plus the action. Not "No data".
10. **Confirmations state the consequence.** "Delete 'Summer Sale'? This removes it for all 4 members and cannot be undone." Success messages are brief and factual ("Invite sent"), or absent when the result is visible.
11. **Numbers, dates, units.** Use digits ("3 items"). Handle one and zero ("1 item", "No items"). Dates people can read ("12 Mar", "Yesterday", "in 2 hours"). Always show the unit and currency. Truncate with … and never mid-number.
12. **Be the same voice everywhere.** Decide: who is speaking, how formal, whether "you/your" (addressing the person) is used — it almost always should be. Keep jokes out of errors and out of anything repeated daily.
13. **Realistic placeholder content.** Real-looking names of varying length and origin, believable numbers (not 1,234 or 100%), actual product text, one deliberately long case per list. No "Lorem ipsum", "John Doe", "Acme Inc.", "Title goes here".
14. **Write for translation and growth.** Leave about 30% extra room; avoid text assembled from fragments ("You have" + n + "new"); avoid idioms and puns that will not survive.

## Words that give a machine away

Cut these on sight unless the user's own material uses them: seamless, effortless, elevate, unlock, unleash, supercharge, empower, revolutionise, streamline, leverage, robust, cutting-edge, next-generation, game-changing, world-class, "take … to the next level", "all-in-one", "the future of …", "reimagined", "your journey", "Welcome to the future". Also: three adjectives in a row, a headline made of two short commands ("Build faster. Ship smarter."), exclamation marks, emoji as bullet points, and Title Case On Everything. Replace each with what the product does, in a plain sentence, with a number if there is one.

## Game writing notes

- Shorter still: players read in a glance between actions. "Equip", "Claim", "Play", or a coin icon and "250" beats any sentence.
- State costs and rewards as numbers next to their icon; show what the player has.
- Flavour belongs in names and descriptions, not in controls. The button under "Dragonfire Greatsword" still says "Equip".
- Timers show the largest two units ("2h 14m", "45s"), and say what happens at zero.

## In Superpencil

- Text lives in `content` on text nodes. Find all of it with `search_nodes` (by type text, or by a word) and read it in one pass, the way a person would meet it.
- The editor has Find & Replace for a term used inconsistently across a file; for the AI, `search_nodes` then one `apply_operations` batch of `update`s.
- Instance text is overridden per instance (`overrides: { "<childId>": { "content": "Save changes" } }`); do not detach a component to change its label.
- After changing text, run `check_layout`: longer words overflow and wrap. Fix by wording first, width second, font size last.
- If the file has a `context` or `note` describing voice or product terms, follow it. If you set the vocabulary yourself, record it in a note so the next pass stays consistent.

## Check before you finish

- [ ] Read only the headings and buttons of each screen, top to bottom. Is it clear what the screen is and what pressing each thing does?
- [ ] No filler text anywhere (`search_nodes` for "lorem", "placeholder", "title", "text here", "John Doe").
- [ ] Every button is a verb or verb + noun; no "OK", "Yes", "Submit", "Click here".
- [ ] One name per thing across all frames.
- [ ] Sentence case throughout; no stray full stops on labels; no exclamation marks.
- [ ] Every error says what to do; every empty state offers the first action.
- [ ] None of the give-away words above.
- [ ] `check_layout` is clean after the changes.

## Common mistakes

- Friendly padding: "Oops! Something went wrong. Please try again later." (What went wrong? Try what?)
- Headings that describe the feeling instead of the content.
- "Learn more" five times on one screen, each going somewhere different.
- Placeholder text doing a label's job.
- Asking a question in the title and answering with "OK / Cancel".
- Perfectly even placeholder data: every name eleven letters, every price 9.99, every avatar the same person.
