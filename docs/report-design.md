# Design System: packlight

## 1. Visual Theme & Atmosphere
A calm instrument panel for one developer's tooling. Density 6 ("Daily App Balanced", leaning dense in tables), variance 3 (a utility: predictable, left-aligned, no theatrics), motion 2 (static; motion only answers a click). It should read like a well-kept ledger: quiet surfaces, one strong statement at the top, then aligned numbers you can compare at a glance.

Deliberate departures from the skill's defaults: no perpetual micro-loops and no staggered list reveals, because this page is read and acted on, not watched.

## 2. Color Palette & Roles
Light / dark (dark follows the OS, or `data-theme`).
- **Paper** (#F7F7F8 / #0F0F11): page ground
- **Sheet** (#FFFFFF / #17171A): the one content surface
- **Sheet Raised** (#F2F2F4 / #1E1E22): expanded rows, code boxes, hover
- **Graphite Ink** (#18181B / #ECECEE): primary text and numbers
- **Steel** (#5B5B66 / #A1A1AA): secondary text (meets 4.5:1 on Sheet)
- **Faint Steel** (#A1A1AA / #52525B): rules, disabled and decoration only, never text that carries data
- **Hairline** (#E4E4E7 / #27272A): 1px structure
- **Moss** (#2F7A55 / #5FB98A): the single accent: "used" bars, Keep, focus ring
- Status only (not accents): **Ochre** (#9A6200 / #E0A84A) for Review and estimates; **Brick** (#B4322B / #EF7A6E) for Archive marks.
No pure black, no gradients, no glows. One shadow, only on the floating selection bar.

## 3. Typography Rules
- **UI and display:** Geist (400, 500, 600). Page title 22px/600, statement number 44px/600 with -0.02em tracking, section heads 16px/600, body and table cells 14px, secondary meta 13px.
- **Mono:** Geist Mono for paths, commands and ids only.
- **Numbers:** tabular figures everywhere; numbers right-aligned in tables.
- **Labels:** sentence case at normal tracking. No uppercase letter-spaced labels.
- **Banned:** Inter, serif faces, all-caps eyebrows.

## 4. Component Stylings
- **Statement (hero):** unboxed, left-aligned: one sentence finding with one big number, two supporting lines, one primary action. The by-kind bars sit to the right on wide screens.
- **Stats strip:** one row of four figures divided by hairlines, no cards, no icons.
- **Tables:** full width, one per section, never two side by side. The name column takes the free width and never breaks inside a word; other columns do not wrap. A hook's event (after " · ") shows as a second line, not part of the name.
- **Status pill:** 6px radius, tinted fill, never wraps, fixed column width so it is never clipped.
- **Buttons:** 8px radius; primary is Graphite fill, secondary is hairline outline; 1px press-down on active; 40px tall (44px under 720px).
- **Empty states:** one sentence saying what to do next.

## 5. Layout Principles
Sidebar 220px plus content, max width 1320px. Overview order: statement, stats strip, Most used, Archive candidates, each full width. Grid for the two hero columns; everything collapses to one column below 900px, sidebar becomes a scrolling pill row. No horizontal page scroll at 360px and up.

## 6. Motion & Interaction
Row chevron rotates 150ms ease-out; nothing else moves. `prefers-reduced-motion` removes it.

## 7. Anti-Patterns (Banned)
No uppercase tracked labels, no KPI card grid, no glow or gradient fills, no side-by-side squeezed tables, no mixed units in a column ("tok" next to "chars"), no "never used" wording (use "not observed"), no emojis, no Inter, no pure black, no mid-word wraps in names.
