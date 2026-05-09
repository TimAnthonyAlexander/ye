---
name: frontend-design
description: Build frontend interfaces that match Tim's stack and avoid vibecoded aesthetics. Use this skill whenever the user asks to build, style, redesign, or beautify any web UI, components, pages, dashboards, landing pages, React components, or HTML/CSS layouts. Trigger even when the user does not say "design", as long as the deliverable is rendered interface code. Also trigger if you are about to reach for Tailwind, Inter, a purple gradient, glassmorphism, or an emoji as a UI icon.
allowed-tools: Read Glob Grep Edit Write Bash
---

# Frontend Design

## Stack

React project, unless the user says otherwise:

- Vite. React Router. TypeScript. Bun.
- Component library: MUI primary. shadcn acceptable only when MUI cannot cover the case.
- Styling: MUI `sx` prop, inline. No Tailwind. No styled-components. No CSS-in-JS layer stacked on top of MUI. The `sx` prop carries everything.
- Icons: Lucide. Always. No emoji as a UI icon under any framing. This is the hard rule of the skill.
- Animation: Framer Motion when motion is part of the design. CSS transitions for hover and focus.
- Background: real white, `#FFFFFF`. Override `theme.palette.background.default` and `theme.palette.background.paper`. MUI's default Paper is grey-tinted, do not ship it.
- Mode: light by default. Dark only on request.

If a project already uses Tailwind, work inside it. Do not introduce it.

## Fonts

Pair a distinctive display face with a refined body face. Vary across projects. Reasonable defaults: GT Sectra, Söhne, Tiempos, Reckless, JetBrains Mono, IBM Plex, Fraunces, Editorial New, Migra, Boldonse. Do not converge on the same pair twice.

## Vibecoding indicators (do not ship these)

Catch these in your own output before the user has to.

1. **Purple-to-indigo gradient hero.** The single strongest tell. The model reaches for the indigo-violet-pink band whenever it wants to look "innovative". Pick a color outside the Linear and Vercel cluster: earth tones, deep greens, off-whites, warm reds, mustard, terracotta. A flat solid color reads more deliberate than any gradient.

2. **Glassmorphic cards on a gradient or aurora background.** Frosted-glass panels with `backdrop-filter`, white-opacity borders, ambient glows behind. The model's idea of premium. Use flat surfaces. Earn depth through typography and spacing.

3. **Bento grids.** Asymmetric tiled feature cards in different sizes, modeled on Apple. Applied as a universal feature layout regardless of feature count. Use plain rows or columns of text with dividers when the content does not justify the affordance.

4. **Neon-on-dark with no hierarchy.** Five fully saturated colors all shouting at once. Constrain the palette: one dominant, one accent, one neutral. If a third accent is not earning its place, delete it.

5. **Cards wrapping cards wrapping cards.** Every block of content in a rounded container, those containers in another container. Use whitespace and proximity to group. A card is for an interactive bounded object. If a section reads without a border, drop the border.

6. **Emoji as icon.** Already covered above. Lucide. Same stroke weight, same size, same optical alignment everywhere.

7. **Decorative dots and rainbow accent bars.** Colored dots next to labels that do not represent state. Vertical bars cycling through red, blue, green, orange on every card. Decoration that mimics data is worse than no decoration.

8. **Generic copy.** Headlines that say nothing ("The future of X, today"). Three-word triplets ("Fast. Reliable. Yours."). The "not just X, it is Y" construction. Unattributed "trusted by thousands". Every sentence the same length. Replace with concrete claims, numbers, names, dates, real outcomes. Vary sentence length deliberately. Cut em-dashes to one per page maximum.

9. **Missing technical fundamentals.** Default `<title>` like "Vite + React". No favicon. No Open Graph image. Broken anchor links. Dead nav items. Mobile layout untested at 375 px. Lighthouse below 50. Always ship a real `<title>`, real meta description, custom favicon, OG image, working anchors, and verify the layout at 375 px.

10. **Scaffolding left behind.** Lorem ipsum in the footer. Three fake testimonials from "Sarah K., Marketing Director" and friends. Fake "5,000+ teams" trust bar with no logos. Phone numbers like (555) 123-4567. "Most popular" badge on the middle pricing tier by reflex. If there are no real testimonials, cut the section. Empty beats fabricated.

## Decide before you code

Three lines at the top of every response that produces UI:

- Purpose: who uses this and why.
- Tone: pick one direction. Editorial, brutalist, retro-terminal, luxury-minimal, soft-organic, industrial. Not "modern" or "clean". Those are non-answers.
- One reference. Real site, real magazine, real artist.

If the user did not give you purpose, tone, or a reference, ask before coding. Don't invent a tone for the user — picking "editorial" silently when they wanted "industrial" is worse than asking. One short AskUserQuestion for tone, plus a plain-prose ask for purpose and any reference they have in mind, is the right move.

Then scan the project for existing tokens before inventing new ones. Look for `theme.ts`, `createTheme` calls, brand colors in the README. If they exist, obey them.

## Output requirements

Working code. Imports, props, types, MUI `sx` styles, keyboard handling, one usage example. No "TODO: styles later". If a component cannot be shipped complete, say what is missing and why.

## Audit pass

Before handing the result back, walk the page and ask of every visible element: "would I notice if this were gone?" Anything that fails is decoration left on autopilot. Cut it.
