# The Weft design system

How Weft's products look, move and behave. The tokens are in `tokens.css` (generated from `scripts/tokens.mjs`), the marks in `logo/`, and the products and their addresses in `products.json`.

## Products

Weft is six products. They share the tokens, the type, the motion and the rules below, so moving between them feels like one place. Each has its own mark, layout and density, so it's always clear which one you're in.

| Product | Mark | What it is | How it feels |
|---|---|---|---|
| Weft (`site`) | The main mark | The front page: what Weft is, and installing it | Spacious. The one place the brand performs |
| Weft Wallet | The main mark | The browser extension | Compact and calm. Nothing moves without a reason |
| Weft Docs | The main mark, with a "weft docs" wordmark | Guides and reference | Quiet and typographic. Reading comes first |
| Weft Playground | The cloth with a pick still to pass | Try a dApp against a network | A workbench. What's live is visibly live |
| Weft Network | The warp alone, in the loom's frame | Every organisation's explorer on one page, and tools for running a network | Dense and precise. Status first |
| Weft Explorer | The finished cloth, in the loom's frame | One organisation's view of its ledger, run by that organisation | A record. Everything can be checked |

Every product header shows its mark and its name. Links between products go through `productUrl()` in `products.mjs`, never a written-out address.

## Marks

The warp is the network: organisations, peers and channels, strung once and held fixed. The weft is what passes through it: identities and transactions. A weft only holds if it goes over one warp and under the next, which is why every mark shows its crossings.

There are two grounds. A teal tile with ink threads is for products people pass something through: Weft, the wallet, the docs and the playground. An ink tile in a teal frame, with teal threads, is for tools an organisation runs for itself: the network and the explorer. The frame is the loom. At 16px a filled tile and a framed tile are different shapes, which is what keeps the products apart in a row of browser tabs.

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

Dark is the default. A page follows the system (`prefers-color-scheme`) unless it sets `data-theme="light"` or `data-theme="dark"` on `<html>`. The wallet is dark only for now.

Changing the theme crossfades the whole page over `duration-base` (a view transition). Nothing slides, and colours don't animate one by one. With reduced motion it changes at once.

## Type

Atkinson Hyperlegible, from the Braille Institute, drawn so that no character can be mistaken for another: 0 and O, 1, l and I, 5 and S, 8 and B differ in shape, not detail. Weft's job is showing exactly what someone signs, so the type does the same.

- Atkinson Hyperlegible Next for interface and reading.
- Atkinson Hyperlegible Mono for anything someone might copy or compare (MSP IDs, enrolment IDs, transaction IDs, hashes, function names, arguments), and for the wordmark, at weight 500.

`type-md` (14px) is the interface base; `type-base` (16px) is for reading, in the docs and on the front page. `type-xs` (12px) is the only size below it. Each size has a matching `leading-*`. Headings use weight 600 and slightly negative tracking at `type-2xl` and above. Eyebrows and table headings are Mono, `type-xs`, uppercase, 0.08em tracking, `text-subtle`.

Identifiers:

- Shown in full, they're grouped in fours (`9f3a 1c07 b25e ...`), so two can be compared block by block.
- Shortened, they're cut in the middle and keep 8 characters at each end (`9f3a1c07…e41b22d8`), because people check the ends.
- Copying always copies the full value, without the spaces.

## Space and shape

Space is on a 4px grid (`space-1` is 4px). Radii: `radius-sm` for chips and tags, `radius-lg` for inputs, buttons and rows, `radius-xl` for cards, `radius-2xl` for sheets and large panels, `radius-pill` for toggles and pill buttons.

On dark grounds, layers are separated by borders first and shadows second (`shadow-1` to `shadow-3`). On light grounds shadows do more of the work.

## Motion

Things arrive quickly and settle. Nothing bounces or overshoots.

| Token | Use |
|---|---|
| `duration-instant` (90ms) | Press feedback |
| `duration-fast` (140ms) | Hover, colour and small state changes |
| `duration-base` (220ms) | Panels, screens and menus arriving; the theme change |
| `duration-slow` (360ms) | Sheets, dialogs, layout that moves far |
| `duration-deliberate` (600ms) | Lines being drawn, progress, the weave |
| `ease-out` | Anything arriving |
| `ease-in` | Anything leaving |
| `ease-in-out` | Something moving from one place to another |
| `ease-tension` | The weave and threads being drawn |
| `shift-sm`, `shift-md`, `shift-lg` (4, 8, 16px) | How far something travels as it arrives |
| `stagger` (60ms) | Between items arriving together, up to 5 items; the rest arrive with the fifth |

Entering: fade from 0 and move `shift-*` toward its place, with `ease-out`. Leaving: the reverse, in about 70% of the time, with `ease-in`. Small things (a tooltip, a hint) use `shift-sm`; panels and menus `shift-md`; screens `shift-lg`, in the direction of travel.

With `prefers-reduced-motion`, the shift tokens are 0 and the press scale is 1, so the same animations become short fades. Loaders still turn; nothing else loops.

Only the front page tells a story with motion. Elsewhere motion explains what changed: where something came from, where it went, what's now selected. Nothing moves on a timer to look alive, and the grounds are plain. The landing's hero alone has faint warps behind it, on the layout's columns, gone before the words: the loom its word is woven into.

### Loading

Weft has no generic spinner. A product shows it's working with its own mark, one pick pulled through its warps, seated, then drawn out the other side, every 1600ms (`logo/loaders/`, drawn by `scripts/loaders.mjs`). At 24px and below use the small drawing (`<id>-small.svg`): like the small marks it's on the 16px pixel grid, and its pick moves a whole pixel at a time. Each product passes its own thing through: Weft, the wallet and the docs their middle pick; the playground its unfinished last pick, which rests halfway, as in its mark; the network a pick that never stays; the explorer its middle row. A loader is decorative: the words beside it say what's happening.

### Arriving

When something new arrives while a person is looking (a block, a transaction), it comes in as a pick: a thread runs across its place over `duration-deliberate` with `ease-tension` and is gone before the words follow it in, then a 3px `accent` rule seats on its left. The rule stays four seconds and fades, so what's new since you looked is plain at a glance. With reduced motion the row fades in and its rule is simply there.

## States

Every control has the same states, in this order of precedence: disabled, loading, pressed, focus, hover, rest.

| State | Looks like |
|---|---|
| Hover | Borders step to `line-strong` or `text-subtle`; fills step to `accent-hover`. `duration-fast`. Only on devices that hover: hover rules sit inside `@media (hover: hover)`. |
| Pressed | Scales to `press-scale` (0.98) for `duration-instant`. |
| Focus | A `focus-ring` (2px) outline in `focus`, `focus-offset` (2px) away, on keyboard focus only (`:focus-visible`). Never removed without a replacement. |
| Loading | The label stays, the product's loader replaces the icon, and the control can't be pressed twice. The width doesn't change. It keeps its full strength and `cursor: progress`. A busy control is marked `aria-disabled="true"` and ignores presses; it's never given `disabled`, which would throw keyboard focus off it. |
| Disabled | `disabled-opacity` (0.5), no hover or press, `cursor: not-allowed`. Say why nearby if it isn't obvious. |
| Selected | `accent-soft` ground and `accent-line` border, or a moving indicator for tabs. |

## Errors

Say what happened and what to do next, in plain words. Fabric codes and raw messages are secondary detail, behind "Details".

- Field errors appear below the field, in `danger-text` with an icon, linked with `aria-describedby`. The field's border turns `danger`. Check a field when it loses focus, not while someone is still typing it. Once an error is showing, check again on every change, so it clears as soon as it's fixed.
- On submit, check everything, move focus to the first field with an error, and keep everything the person typed.
- Errors from the network or a peer go where the action was, not in a toast. Keep them until the person acts or retries.
- Warnings (`warn-*`) are for something that will need attention: a certificate expiring, a write to the ledger. They aren't errors and don't block.
- Empty states say what would be here and how to get it there.

The pieces, the same in every product:

- A field error is a `<p class="field-error" id="<field>-error">` right below the field: a 14px alert icon, then the sentence, in `type-xs`, weight 500, `danger-text`, `space-1` above. The field gets `aria-invalid="true"` and the error's id in its `aria-describedby`, after any hint's. Forms carry `novalidate`, so the browser's own bubbles never show.
- An error from an action (a request that failed) sits where the action was, starts with a sentence in `danger-text`, and has `role="alert"`. Anything technical (a code, a raw message, a URL that failed) goes in `<details class="error-details"><summary>Details</summary>…</details>` below it, in Mono `type-xs`, `text-muted`.
- A request that may never answer has a timeout, and timing out is an error like any other: say which service didn't answer and what to check.

## Navigation

The current place is always marked: the selected tab, the current page in a sidebar, the product in the header (`aria-current="page"`). Going deeper moves the new screen in from the right (`shift-lg`); going back, from the left. Changing between sibling tabs crossfades. A page that loads in parts keeps its layout stable: content arrives into reserved space rather than pushing things down.

Between pages of a site the same holds, as a view transition (`@view-transition { navigation: auto }`): the new page fades in from `shift-md` to the right over `duration-base`, or from the left when going back through history. With reduced motion pages change at once.

Focus follows the person:

- Each screen and page has one `h1`. When a screen opens inside an app (the wallet, a step in a flow), focus moves to its `h1` (`tabindex="-1"`). A full page load leaves focus where the browser puts it. The exception is a screen whose one task is a single field, such as unlocking: focus goes straight into the field.
- When the thing that had focus goes away (a busy button, a removed row, a closed panel), focus moves to what took its place: the next row, the list's heading, the control that opened the panel.
- Content that updates itself (a refreshing table, a ticking count) is updated in place, never replaced wholesale, so focus, selection and a half-typed form survive. New rows don't push what someone is reading: if they arrive above it, the scroll position moves with them.
- Each page has one polite live region (`role="status"`) for changes the person should hear: a result, a connection, "Block 35 arrived". It's written only when something changes for them, never on a timer.

A menu or a disclosure closes the way it opened, in reverse, with `ease-in` in about 70% of the time. A list item being removed leaves the same way before the list closes up.

## Writing

British spelling. Sentence case. No dashes as punctuation; use a comma, colon or new sentence. Say what something does, not what it is like.
