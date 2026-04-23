# Handoff: pinned-aside drawer chrome

## TL;DR for the designer

The pinned-aside drawer (slides in from the right when Quincy calls
`pin_aside`) has illegible header text in dark mode. The body of the
drawer — the Starlight markdown that gets injected in — renders
correctly; only the custom chrome I added is broken. All the fixes are
in **one file**: `src/components/DocsBotAside.css`.

## What's broken (see screenshot)

Top of the drawer, roughly the first 100px:

- **Eyebrow** ("PINNED ASIDE") — `--harbor-amber-700` on the ink-navy
  background. Amber-700 is a deep bronze color designed for paper
  backgrounds, so it disappears on dark.
- **Title** ("Retry policy") — `--harbor-ink-900` on the ink-navy
  background. Dark navy on dark navy. Completely invisible.
- **Path** (`/concepts/retry-policy/`) — color-mix of `--harbor-ink-900`
  at 60% opacity. Same problem, one level worse.
- **× close button** — amber-700 border + amber-700 text on dark. Faint
  and easy to miss; also user-reported it felt hard to hit.

The body of the drawer (the page content) is fine now because I
switched its BG/FG to Starlight's theme-aware vars. The chrome still
points at the Harbor paper-theme tokens — that's the root cause.

## Files

- **Primary**: `src/components/DocsBotAside.css` — the chrome styles.
  This is where all the fixes should land.
- **For reference only**: `src/components/DocsBotAside.tsx` — if you
  want to see the DOM structure, the close button's onClick, or the
  loading/error states. No JSX changes should be needed — the class
  hierarchy is already there; just restyle.

## Selectors, in document order

```
.docsbot-aside                       ← fixed-position drawer container
  .docsbot-aside__header             ← top band with eyebrow/title/path/×
    .docsbot-aside__eyebrow          ← "PINNED ASIDE" mono caps
    .docsbot-aside__title            ← Fraunces page title
    .docsbot-aside__path             ← "/concepts/retry-policy/" mono
    .docsbot-aside__close            ← × button (aria-label="Close aside")
  .docsbot-aside__body               ← scrollable region
    .docsbot-aside__placeholder      ← "Loading..." state
    .docsbot-aside__error            ← fetch-failed state
    .docsbot-aside__content          ← injected Starlight markdown (DO NOT RESTYLE — inherits cleanly now)
```

## Theme contract (important)

The drawer's container already follows Starlight theme vars for bg/fg:
```css
.docsbot-aside {
  background: var(--sl-color-bg, var(--harbor-ink-900, #05101c));
  color:      var(--sl-color-text, var(--sl-color-white));
}
```

Every chrome element underneath should resolve its color against those
same theme vars (or an amber accent that has enough contrast against
both). Concretely: in dark mode, prefer amber-400 / amber-500 for
accents and `--sl-color-white` / `--sl-color-text` for body text; in
light mode, switch to amber-700 on paper for accents and ink-900 for
body. Starlight handles that automatically if you use its vars.

The widget itself (`DocsBotWidget.css`) is a good reference — it's
dark-first and uses amber tokens against ink-navy consistently. The
aside should visually rhyme with it.

## Concrete problems → suggested direction (not prescriptive)

| Selector | Current | Problem | Direction |
|---|---|---|---|
| `.docsbot-aside__eyebrow` | `color: var(--harbor-amber-700)` | Bronze-on-ink, invisible | Use `--harbor-amber-400` or `--harbor-amber-500` for dark, flip to 700 only for `[data-theme='light']` |
| `.docsbot-aside__title` | `color: var(--harbor-ink-900)` | Dark-on-dark | Use `var(--sl-color-text, var(--sl-color-white))` so it flips with theme |
| `.docsbot-aside__path` | `color: color-mix(srgb, ink-900 60%, transparent)` | Same | `color-mix(srgb, var(--sl-color-text) 65%, transparent)` or similar |
| `.docsbot-aside__close` | border + text = `--harbor-amber-700` | Low contrast on dark, user-reported "doesn't feel clickable" | Brighten border/icon in dark mode (amber-400-ish); keep the hover amber-glow treatment the widget's × buttons use |
| `.docsbot-aside__header` | Gradient overlay from amber-400 at 18% | Too subtle against ink; the header band doesn't read as distinct from the body | Could drop the gradient or strengthen it — designer's call |

## Nice-to-haves (only if trivially in scope)

- The × button's hit target is 32×32 — may feel small against the 640px
  drawer width. Bumping to 36–40px and/or adding a subtle background on
  hover would help discoverability.
- The animation (slide-in from the right) works but could get a small
  fade on the header chrome specifically so the title doesn't pop in
  against the empty bg before the content fetches.

## What NOT to touch

- `.docsbot-aside__content` and anything under it — that's the injected
  Starlight page content. Its styles inherit from Starlight's own dark
  mode and render correctly.
- Aside width / aspect (`var(--docsbot-aside-width)`) — the current 50vw
  / max 640px has been validated with real content and on mobile it
  goes full-bleed. Don't change dimensions unless there's a specific
  issue.
- The aside body's Starlight overrides (`.docsbot-aside__content h1`,
  `.docsbot-aside__content pre`, etc.) — those are narrow-column
  downsizing and they work.

## How to preview your changes

1. `cd "C:\Projects\Web\Harbor Docs"`
2. `npm run dev` — Astro dev server at http://localhost:4321
3. Open any docs page. Start a voice call with Quincy.
4. Say: **"Compare idempotency and the retry policy side by side."**
   — this fires `pin_aside` and opens the drawer against the retry
   policy page (the one in the screenshot).

Or if you don't want to do a voice call: open devtools console and run

```js
window.dispatchEvent(new CustomEvent('docsbot:pin_aside', {
  detail: {
    slug: 'concepts/retry-policy',
    path: '/concepts/retry-policy/',
    title: 'Retry policy',
  },
}));
```

The drawer will open without a call. Close it with its × button or
Escape, or:

```js
window.dispatchEvent(new CustomEvent('docsbot:close_aside'));
```

That's the full surface. Everything lives in `DocsBotAside.css`; no
component logic to change.
