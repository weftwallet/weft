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

`scripts/marks.mjs` draws the product marks and `scripts/lockups.mjs` the lockups, whose wordmark is converted to outlines so it never depends on a font loading.

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

With `prefers-reduced-motion`, the shift tokens are 0 and the press scale is 1, so the same animations become short fades. Spinners still turn; nothing else loops.

Only the front page tells a story with motion. Elsewhere motion explains what changed: where something came from, where it went, what's now selected.

## States

Every control has the same states, in this order of precedence: disabled, loading, pressed, focus, hover, rest.

| State | Looks like |
|---|---|
| Hover | Borders step to `line-strong` or `text-subtle`; fills step to `accent-hover`. `duration-fast`. Only on devices that hover. |
| Pressed | Scales to `press-scale` (0.98) for `duration-instant`. |
| Focus | A `focus-ring` (2px) outline in `focus`, `focus-offset` (2px) away, on keyboard focus only (`:focus-visible`). Never removed without a replacement. |
| Loading | The label stays, a small spinner replaces the icon, and the control can't be pressed twice. The width doesn't change. |
| Disabled | `disabled-opacity` (0.5), no hover or press. Say why nearby if it isn't obvious. |
| Selected | `accent-soft` ground and `accent-line` border, or a moving indicator for tabs. |

## Errors

Say what happened and what to do next, in plain words. Fabric codes and raw messages are secondary detail, behind "Details".

- Field errors appear below the field, in `danger-text` with an icon, linked with `aria-describedby`. The field's border turns `danger`. Check a field when it loses focus, not while someone is still typing it. Once an error is showing, check again on every change, so it clears as soon as it's fixed.
- On submit, check everything, move focus to the first field with an error, and keep everything the person typed.
- Errors from the network or a peer go where the action was, not in a toast. Keep them until the person acts or retries.
- Warnings (`warn-*`) are for something that will need attention: a certificate expiring, a write to the ledger. They aren't errors and don't block.
- Empty states say what would be here and how to get it there.

## Navigation

The current place is always marked: the selected tab, the current page in a sidebar, the product in the header. Going deeper moves the new screen in from the right (`shift-lg`); going back, from the left. Changing between sibling tabs crossfades. A page that loads in parts keeps its layout stable: content arrives into reserved space rather than pushing things down.

## Writing

British spelling. Sentence case. No dashes as punctuation; use a comma, colon or new sentence. Say what something does, not what it is like.
