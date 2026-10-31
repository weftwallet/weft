# The Weft design system

How Weft's products look, move and behave. The tokens are in `tokens.css` (generated from `scripts/tokens.mjs`), the marks in `logo/`, and the products and their addresses in `products.json`.

## Products

Weft is six products. They share the tokens, the type, the motion and the rules below, so moving between them works the same way. Each has its own mark, layout and density, so it's always clear which one you're in.

| Product | Mark | What it is | Layout and motion |
|---|---|---|---|
| Weft (`site`) | The main mark | The Weft site: what Weft is, and installing it | Wide sections in `type-base`. The only product with motion that doesn't answer an action: the hero and the cloth animations |
| Weft Wallet | The main mark | The browser extension | A 360px popup and approval window in `type-md`. Motion only answers an action, plus loaders and arriving rows |
| Weft Docs | The main mark, with a "weft docs" wordmark | Guides and reference | A sidebar and one reading column in `type-base`. Motion only for page changes and menus |
| Weft Playground | The cloth with a pick still to pass | Try a dApp against a network | Numbered steps beside a provider log. Status pills change as each request runs |
| Weft Network | The warp alone, in the loom's frame | Every organisation's explorer on one page, and whether their ledgers agree | One table per channel, with its status pill and verdict first. Rows update in place every 15 seconds |
| Weft Explorer | The finished cloth, in the loom's frame | One organisation's view of its ledger, run by that organisation | Tables and detail lists, each block with its hash check. Live pages update in place as blocks arrive |

Every product header shows its mark and its name. Links between products go through `productUrl()` in `products.mjs`, never a written-out address.

## Marks

The warp is the network: organisations, peers and channels, strung once and held fixed. The weft is what passes through it: identities and transactions. A weft only holds if it goes over one warp and under the next, which is why every mark shows its crossings.

There are two grounds. A teal tile with ink threads is for products people pass something through: the Weft site, the wallet, the docs and the playground. An ink tile in a teal frame, with teal threads, is for tools an organisation runs for itself: Weft Network and the explorer. The frame is the loom. At 16px a filled tile and a framed tile are different shapes, which is what keeps the products apart in a row of browser tabs.

| Mark | Drawing |
|---|---|
| Main (`logo/mark.svg`) | Three wefts through two warps, alternating. |
| Playground | The main mark's cloth with the last pick halfway across, so the bottom of the warp is bare. At 16px: one pick through two warps. |
| Network | Four warps, nothing through them. At 16px: three. |
| Explorer | A 3 by 3 plain weave. Never the main mark inverted: `logo/mark-inverted.svg` is Weft itself on a teal or light ground. |

Construction, for any mark drawn later:

- Two colours: thread `#3FC1B0` and ink `#0B1218`.
- Full drawings on a 48px tile: a plain tile is 44px with radius 12; a framed tile is 42px with radius 11 and a 2px frame.
- Warps 3 wide, wefts 6 wide, round ends.
- Every crossing shows which thread is on top: a weft is drawn over a 10-wide stroke of the ground, which cuts the warps it passes over; where the warp passes over instead, it's drawn back on top over a 7-wide stroke of the ground.
- A small drawing for 32px and below, on the 16px pixel grid: 2px threads, 1px gaps, a 1px frame, every edge on a whole pixel. It may simplify the full drawing but never contradict it.

`scripts/marks.mjs` draws the product marks, `scripts/loaders.mjs` their loaders and `scripts/lockups.mjs` the lockups, whose wordmark is converted to outlines so it never depends on a font loading.

## Colour

Use roles, not primitives. Roles change with the theme; primitives don't.

| Role | Use |
|---|---|
| `bg-sunken`, `bg`, `bg-surface`, `bg-raised`, `bg-overlay` | Grounds, from furthest back to nearest. A card sits on `bg-raised`, a menu or dialog on `bg-overlay`. |
| `line`, `line-strong` | Dividers and borders. `line-strong` for inputs and anything you can press. |
| `text-strong`, `text`, `text-muted`, `text-subtle` | Headings, body, secondary, and hints or metadata. |
| `accent`, `accent-hover`, `accent-text`, `accent-soft`, `accent-line`, `on-accent` | Thread, the only accent: primary actions, focus, selection, links, "valid". Text on an accent fill is `on-accent`. Links and accent-coloured text use `accent-text`. |
| `focus` | The keyboard focus ring. Thread in dark; a deeper thread in light, where thread on linen is too faint to see. |
| `warn-*`, `danger-*`, `on-status` | Amber and signal. Status only: an expiring certificate, a ledger write, a failure. Never decoration, or people stop noticing them. |
| `scrim` | Behind sheets and dialogs. |

Every text role meets 4.5:1 contrast on every ground in both themes, and `focus` meets 3:1. `scripts/tokens.mjs` checks this and refuses to write the tokens if any pair falls short.

The two themes are ink and linen: ink for dark, linen, the colour of undyed cloth, for light. The text colours are cool in both, so light reads as ink on cloth. That difference in temperature is deliberate; don't cool the light theme to match the dark. In light, cards (`bg-raised`) are a step below white and dialogs (`bg-overlay`) are white, so a dialog over a card stands apart by its ground as well as its shadow.

## Theme

Dark is the default. A page follows the system (`prefers-color-scheme`) unless it sets `data-theme="light"` or `data-theme="dark"` on `<html>`. The wallet follows the system theme and has no theme control.

Changing the theme crossfades the whole page over `duration-base` (a view transition). Nothing slides, and colours don't animate one by one. With reduced motion it changes at once. The toggle is described under Navigation.

## Type

Atkinson Hyperlegible, from the Braille Institute, drawn so that no character can be mistaken for another: 0 and O, 1, l and I, 5 and S, 8 and B differ in shape, not detail. Weft's job is showing exactly what someone signs, so the type does the same.

- Atkinson Hyperlegible Next for interface and reading.
- Atkinson Hyperlegible Mono for anything someone might copy or compare (MSP IDs, enrolment IDs, transaction IDs, hashes, function names, arguments), and for the wordmark, at weight 500.

`type-md` (14px) is the interface base; `type-base` (16px) is for reading, in the docs and on the Weft site. `type-xs` (12px) is the only size below it. Each size has a matching `leading-*`. Headings use weight 600 and slightly negative tracking at `type-2xl` and above. Eyebrows and table headings are Mono, `type-xs`, uppercase, 0.08em tracking, `text-subtle`.

Identifiers:

- Shown in full, they're grouped in fours (`9f3a 1c07 b25e ...`), so two can be compared block by block.
- Shortened, they're cut in the middle and keep 8 characters at each end (`9f3a1c07…e41b22d8`), because people check the ends.
- Copying always copies the full value, without the spaces.

## Space and shape

Space is on a 4px grid (`space-1` is 4px). Radii: `radius-sm` for chips and tags, `radius-lg` for inputs, buttons and rows, `radius-xl` for cards, `radius-2xl` for sheets and large panels, `radius-pill` for toggles and pill buttons.

On dark grounds, layers are separated by borders first and shadows second (`shadow-1` to `shadow-3`). On light grounds shadows do more of the work.

## Motion

One model for all six products: a damped settle. Things arrive quickly on `ease-out`, which has a long tail and no overshoot, and nothing bounces. Leaving takes 70% of the time, on `ease-in`, because what is going does not need to be watched. A thread drawn across (the pick, the weave) uses `ease-tension`: it accelerates through the shed and slows as it seats. These three curves are enough; `ease-in-out` is for the rare thing that moves from one place to another. There is no spring token: the brand forbids overshoot, so a spring would only be another way to write `ease-out`.

The rules are written once, in `packages/ui/src/motion.css`, and every product loads that file after `tokens.css`: the sites through `base.css`, the wallet through its Vite CSS, the explorer as a static file. No product copies a rule out of it or writes a duration of its own.

| Token | Use |
|---|---|
| `duration-instant` (90ms) | Press feedback down |
| `duration-fast` (140ms) | Hover, colour, a field border, an error appearing, press release |
| `duration-base` (220ms) | Panels, menus, screens, a page, the theme change |
| `duration-slow` (360ms) | Sheets and dialogs, layout that moves far |
| `duration-deliberate` (600ms) | A line being drawn, the pick, a progress bar. Never text or panels |
| `duration-pass` (1600ms) | A loader's period |
| `duration-fast-out`, `base-out`, `slow-out` (100, 154, 252ms) | Leaving, at 70% of the arrival. Use these rather than `calc()` or a literal |
| `ease-out`, `ease-in`, `ease-tension`, `ease-in-out` | Arriving; leaving; a thread drawn; moving between two places |
| `shift-sm`, `shift-md`, `shift-lg`, `shift-xl` (4, 8, 16, 32px) | How far something travels: tooltips and hints; panels, menus and pages; screens inside an app; sheets |
| `stagger` (60ms) | Between items arriving together, five at most; the rest arrive with the fifth |
| `press-scale` (0.98) | Down in `duration-instant`, back in `duration-fast` |
| `wait-before-loader` (300ms) | A loader is shown only after this long, so a quick answer never flashes one |
| `hold-after-done` (1400ms) | A success state stays at least this long before a window closes or a screen moves on |
| `rule-life` (4000ms) | How long the "new since you looked" rule stays before it fades |

What may move:

- Motion that answers an action shows what changed and where it came from: a panel from its button, a screen from the direction of travel, a row from the left.
- Motion on a timer is allowed in two places only: a loader, and a row that arrived while the person was looking.
- A large mark (the Weft site's hero, the wallet's 72px welcome mark and 56px lock screen mark) draws on its own once at most (the hero as the page loads, the welcome on Weft's first run, the lock screen never) and again each time it is pressed, as a button named "Replay the logo animation": one full draw per press, presses while it draws ignored, never on hover or a timer, and with reduced motion it stays a button and shows the still mark. The small header logo is never a button.
- The Weft site's front page is the only page with motion that doesn't answer an action. Elsewhere the grounds are plain and nothing moves on a timer except loaders and arriving rows. The front page's hero alone has faint warps: translucent lines in the text colour at 4%, at a fixed 32px pitch from the hero's left edge. They are drawn over the mark at every width, so they run through it without cutting it, and under the words.

Entering and leaving: fade from 0 and move `shift-*` to the place, with `ease-out`; leave the same way in reverse, in the `-out` duration, with `ease-in`.

Interruption: anything a person can reverse (a menu, a disclosure, a panel, a sheet, a tab indicator, a hover, the theme toggle's icon) is built with CSS transitions, never keyframes, so a reversal continues from where the element is. `motion.css` has `.reversible` for this: closed by default, `.is-open` brings it in, taking the class away sends it back from wherever it is, with `visibility` hidden at the end, `@starting-style` for the first frame and `transition-behavior: allow-discrete` where `display` changes. Keyframes are for one-way arrivals only: a row, a toast, a page, the pick. The native `<details>` element hides its content at once, so a disclosure keeps keyframes and `closesInReverse()` holds it open; menus do not use `<details>`.

Reduced motion: `motion.css` has one block for everything above. The shift tokens become 0 and `press-scale` 1 and `stagger` 0 (in `tokens.css`), so movement becomes a fade; pages change at once; the pick is not drawn and the words and the rule are shown at once; reversible things change at once. Loaders keep turning, as a spinner would; nothing else loops. The hero and the cloth open finished.

### Loading

Weft has no generic spinner. A product shows it's working with its own mark, one pick pulled through its warps, seated, then drawn out the other side, every `duration-pass` (`logo/loaders/`, drawn by `scripts/loaders.mjs`, which reads the token; the SVGs carry the number as a literal because they are used as images). At 24px and below use the small drawing (`<id>-small.svg`), on the 16px pixel grid, its pick moving a whole pixel at a time. Each product passes its own thing through: the Weft site, the wallet and the docs their middle pick; the playground its unfinished last pick, which rests halfway, as in its mark; Weft Network a pick that never stays; the explorer its middle row. A loader is decorative: the words beside it say what's happening.

A busy control is set with `setBusy(button, true)` from `packages/ui/src/ui.ts`, in every product, including the wallet's Button: `aria-disabled="true"` at once (never `disabled`, which would throw keyboard focus off it) and presses ignored (`isBusy()`); the loader (`.is-working`) joins the label only after `wait-before-loader`; `setBusy(button, false)` removes it at once, so a loader never finishes its pass. The label stays and the width never changes: the loader is 16px and takes exactly the padding `.btn` gives up (`base.css`). A loader that stands for a whole screen (a splash) follows the same wait.

One loader finishes its pass: the wallet's lock screen, after an unlock that succeeds. There the 56px loader stands in the mark's place, and the next thing shown is the unlocked wallet, so letting its pick seat shows the mark whole again before Home arrives instead of cutting it off mid-pass. It applies only when the loader was showing, and never with reduced motion. The pick seats from wherever its pass is (if it is being drawn out, it goes on out and the next pick seats), in at most 160ms, then the mark is whole for `duration-fast` (140ms): 300ms in all, the length of `wait-before-loader`, and never more. This time runs alongside reading the wallet's state again, so an unlock is at most 300ms later than without it. The Unlock button's 16px loader is still removed at once, and so is the 56px loader on a wrong password, where the error line appears instead. `seatLoader()` in the wallet's `components/ui.tsx` is the one implementation; nothing else calls it.

### Arriving

When something new arrives while a person is looking (a block, a transaction, an identity), it comes in as a pick. One implementation, `.is-new` in `motion.css`, for the wallet's list items, the explorer's table rows and Weft Network's rows: put the class on the row as it is inserted. The thread (2px, `accent`) crosses the row's middle with `ease-tension` to 420ms and is gone by 600ms (`duration-deliberate`); the words, the row's direct children, follow it in from the left (`shift-md`) at 420ms over `duration-base`, so the eye is never on an empty row; a 3px `accent` rule seats on the left at 480ms, stays `rule-life` and fades over `duration-slow`. With reduced motion the row appears at once and its rule fades after `rule-life`.

## States

Every control has the same states, in this order of precedence: disabled, loading, pressed, focus, hover, rest. Two heights: 44px for anything primary or typed into, 36px for anything secondary or in a header.

| State | Looks like |
|---|---|
| Hover | Borders step to `line-strong` or `text-subtle`; fills step to `accent-hover`. `duration-fast`. Only on devices that hover: hover rules sit inside `@media (hover: hover)`. |
| Pressed | Scales to `press-scale` in `duration-instant`, back in `duration-fast`. Written once in `motion.css` for `.btn`, `.press`, `[data-press]`, the products grid's button and the header's 36px tools (`.shell-tool`, the theme toggle among them); a control in that list transitions `transform` over `duration-fast` itself. |
| Focus | A `focus-ring` (2px) outline in `focus`, `focus-offset` (2px) away, on keyboard focus only (`:focus-visible`). Never removed without a replacement. |
| Loading | `setBusy()`, above: the label stays, the loader joins it after `wait-before-loader`, the width does not change, full strength, `cursor: progress`, `aria-disabled="true"`. |
| Disabled | `disabled-opacity` (0.5), no hover or press, `cursor: not-allowed`. Say why nearby if it isn't obvious. |
| Selected | `accent-soft` ground and `accent-line` border, or a sliding indicator (a transition, so it is reversible) for tabs and segmented controls. |

Every `<select>` stays a native select, in a `.select` wrapper, styled once in `packages/ui/src/select.css` (the sites through `base.css`, the wallet through its Vite CSS, the explorer as a static file). Closed, it is the text input beside it with a 16px chevron, 12px from the right, in `text-subtle` and `text` on hover, turning over while the list is open. Where the browser lets a page draw the open list (`appearance: base-select`), the list is a menu like the products grid's: `bg-overlay`, a `line-strong` border, `radius-xl`, `shadow-3`, 36px options with `radius-lg`, the chosen one on `accent-soft` with a check, arriving as a reversible menu does. Elsewhere the browser's own list opens under the same closed control.

## Errors

Say what happened and what to do next, in plain words. Fabric codes and raw messages are secondary detail, behind "Details".

- Field errors appear below the field, in `danger-text` with an icon, linked with `aria-describedby`. The field's border turns `danger` in `duration-fast`. Check a field when it loses focus, not while someone is still typing it. Once an error is showing, check again on every change, so it clears as soon as it's fixed.
- On submit, check everything, move focus to the first field with an error, and keep everything the person typed.
- Errors from the network or a peer go where the action was, not in a toast. Keep them until the person acts or retries.
- Warnings (`warn-*`) are for something that will need attention: a certificate expiring, a write to the ledger. They aren't errors and don't block.
- Empty states say what would be here and how to get it there.

Layout never moves under an error. The pieces, the same in every product:

- Every field that can fail reserves its error line: a `<p class="field__status" id="<field>-error">` right below the field (or below the row the field shares with a button), always present, 20px tall (`motion.css`). `setFieldError(field, message)` in `ui.ts` writes the message into it and adds `.field-error` (a 14px alert icon, then the sentence, in `type-xs`, weight 500, `danger-text`; `base.css`); the message fades in over `duration-fast` from `shift-sm` above, and nothing below the field moves. The field gets `aria-invalid="true"` and the line's id in its `aria-describedby`, after any hint's. Forms carry `novalidate`, so the browser's own bubbles never show.
- An error from an action (a request that failed) sits where the action was, starts with a sentence in `danger-text`, and has `role="alert"`. Anything technical (a code, a raw message, a URL that failed) goes in `<details class="error-details"><summary>Details</summary>…</details>` below it, in Mono `type-xs`, `text-muted`. `showError(box, sentence, details)` builds it.
- A request that may never answer has a timeout, and timing out is an error like any other: say which service didn't answer and what to check.
- A success state that ends a task (a transaction committed) stays `hold-after-done` before the window closes or the screen moves on, and names what was done (the block, the call).

## Navigation

The current place is always marked: the selected tab, the current page in a sidebar, the product in the header (`aria-current="page"`). Going deeper moves the new screen in from the right (`shift-lg`, `duration-base`) while the old leaves to the left in `duration-base-out`; going back, the reverse. Changing between sibling tabs crossfades. A page that loads in parts keeps its layout stable: content arrives into reserved space rather than pushing things down.

Between pages of a site the same holds, as a view transition (`motion.css`): the old page leaves `shift-md` against the direction of travel in `duration-base-out`, the new arrives from `shift-md` with it over `duration-base`. The direction is a view-transition type, `forward` or `back`, set by `packages/ui/src/early.js`, which also applies the stored theme before the first paint; the Shell, the docs and the explorer inline that one file in `<head>`. With reduced motion pages change at once.

The header is one grammar in every product (`packages/ui/src/header.css`, which documents the markup; `Shell.astro` renders it, the docs and the explorer render the same from their templates): one 60px row with the products grid first, then the product's 28px mark and name, its own links where they fit, and on the right its tools at 36px: search, where the product has one, then the theme toggle. On a phone it is that one row too: the grid, the lockup, then the tools.

- The products grid is a 16px glyph in a 36px hit area, with no border at rest and a soft ground on hover and while its menu is open. Its glyph sits on the content edge; from 1288px, where the gutter outside the 1200px column has room, it hangs in the gutter so the lockup stays on the edge (the docs' bar runs the full width, so there it is always first in the row). Its menu opens under it from its left edge, and across the bar under 720px, as a `.reversible`; Escape and a click outside close it and focus returns to the grid. The current product is marked in it with `aria-current="page"`, the `accent-soft` ground and a check; the explorer adds itself last, marked as current and naming the organisation that runs it. The footer's list of products marks the current one the same way.
- Nothing in the header scrolls sideways, on any page. `header.js` (inlined right after the header, so it runs before the first paint) measures the links and gives them the first layout in which they fit: in the bar, then a row of their own under it, then that row with short labels, then a row that wraps. Weft Network's links have short labels for phones ("Network", "Invite maker"). The docs' five sections are in the bar where they fit, on a second row at tablet widths, and under 50rem at the top of the page list, whose button is the last tool in the row. The explorer has no links.
- Search is a field on a desktop and a 36px search icon on a phone: in the docs it opens Starlight's search dialog; in the explorer, under 720px, it opens the same field across the bar. The explorer's organisation chip shrinks with an ellipsis and leaves the bar under 360px (its menu entry names the organisation); sign-in leaves the header under 720px, where the pages that need it offer it and the footer has the account.

The theme toggle is one 36px button, named "Dark theme" and pressed when the page is dark. It follows the device until pressed; a press flips light and dark and keeps the choice, and pressing back to the device's own theme forgets it, so the page follows the device again. Its description says "Following your device", "Light" or "Dark", and its tooltip what the next press does. The icon is one drawing that follows the page's theme from the first paint: going to dark, the sun's disc grows, a second disc slides in to cut the crescent and the rays turn and shrink away, over `duration-base`, each part a transition so a second press halfway turns it back. The page crossfades once over `duration-base`; nothing slides and colours do not animate one by one. The choice is kept per product (the docs under Starlight's key).

Focus follows the person:

- Each screen and page has one `h1`. When a screen opens inside an app (the wallet, a step in a flow), focus moves to its `h1` (`tabindex="-1"`). A full page load leaves focus where the browser puts it. The exception is a screen whose one task is a single field, such as unlocking: focus goes straight into the field.
- When the thing that had focus goes away (a busy button, a removed row, a closed panel), focus moves to what took its place: the next row, the list's heading, the control that opened the panel.
- Content that updates itself (a refreshing table, a ticking count) is updated in place, never replaced wholesale, so focus, selection and a half-typed form survive. New rows don't push what someone is reading: if they arrive above it, the scroll position moves with them.
- Each page has one polite live region (`role="status"`, the Shell's `#weft-status`; `announce()` in `ui.ts`) for changes the person should hear: a result, a connection, "Block 35 arrived". It's written only when something changes for them, never on a timer.

A menu or a panel closes the way it opened, from wherever it is (`.reversible`). A list item being removed leaves the same way before the list closes up.

## Writing

These rules cover every word a person reads: the wallet, the sites, the explorer, the docs, error messages and the READMEs.

- British spelling: organisation, enrolment, colour, licence.
- Sentence case for headings, titles, buttons and labels.
- No em or en dashes. Use a comma, a colon or a new sentence. Write ranges with "to": 5 to 10 minutes, blocks 3 to 7.
- Say what something does, literally. No figurative language: a page "retries", not "keeps trying"; explorers "exchange signed checkpoints", not "compare notes".
- No bold lead-ins. A term and its explanation is a `<dl>`, with the term in `<dt>`.
- No exclamation marks.
- No "e.g.". Write "for example".
- Buttons say what happens: "Apply changes", "Copy invite", "Sign and submit", not "OK", "Copy" or "Continue".
- Errors say what happened first, then what to do: "Weft couldn't read that image. Paste a PNG or JPEG screenshot of the QR code." Developer messages are full sentences too.

Names:

- Weft is the project. The front page is the Weft site. The products are Weft Wallet, Weft Docs, Weft Playground, Weft Network and Weft Explorer; use the full name where the product is named, and "Weft" as the actor in the wallet ("Weft is locked").
- A person approves, an organisation endorses, a site connects. Keep Fabric's own terms where they are Fabric's (`_lifecycle` "approvals", `EVALUATE` and `SUBMIT`).
- The reader is "you" in the wallet and the user guides, "the person" on the Weft site, and "the user" in the dApp docs and the API.
- The calling page is a "site" in the wallet, a "web app" in the user guides and on the Weft site, and a "dApp" in the builder docs.
- Secrets come from "your administrator". "Registrar" is for the operator docs only, and "admin" only for Fabric's role.
- A read call is a "read" in prose; its button is "Sign and read".
- A request the person turns down is "rejected", as the Reject button and `UserRejected` say.
- The invite flow is "Join from an invite"; its submit button is "Enrol".
- The extension's worker is the "background worker".
- The licence is "Apache 2.0" in prose, and the SPDX form only in `package.json`.
