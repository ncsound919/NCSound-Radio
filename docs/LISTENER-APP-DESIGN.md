# NCSound listener app — design contract

Status: **contract** (built into the app in plan 01-05). Source: OG-Glass preset
**`ncsound-dark`** (created this session, extends `client-dark-minimal`, amber
accent `#ffb020`). Grades **S / 100** (`og-glass grade_design`).

> **Why a custom preset:** the shipped dark presets collapse every text token to
> one colour — `client-dark-minimal` is all `#ffffff`, `style-neon-cyberpunk` is
> all `#00ff88` (neon green everywhere, unreadable for a text-heavy app). Neither
> gives hierarchy. `ncsound-dark` fixes the text scale and adds one brand accent.
>
> **Note:** OG-Glass's JEV decision engine was **offline** (`fetch failed`;
> DevBrain `:3450` down), so `design_brief` fell back to a keyword pick and chose
> a **light pastel** theme — wrong for a dark broadcaster app. The direction here
> is a deliberate override, not the fallback.

## 1. Direction

Premium, dark, media-forward broadcaster UI. Near-black substrate, one amber
accent, hierarchical white text, editorial spacing, restrained motion. Not
"cyberpunk glow" — the neon preset was graded and rejected for exactly that.

## 2. Tokens (implement in `apps/listener-app/src/ui/tokens.ts`)

**Color**

| Token | Value | Role |
|---|---|---|
| `bg` | `#050508` | App background |
| `surface` | `rgba(255,255,255,0.04)` | Cards / raised panels |
| `surfaceStrong` | `rgba(255,255,255,0.08)` | Pressed / active rows |
| `border` | `rgba(255,255,255,0.10)` | Dividers, input borders |
| `overlay` | `rgba(0,0,0,0.72)` | Modals |
| `accent` | `#ffb020` | Primary actions, live dot, focus ring |
| `accentHover` | `#ffc45c` | Pressed accent |
| `accentSecondary` | `#94a3b8` | Secondary accent |
| `danger` | `#f87171` | Errors |
| `success` | `#86efac` | Success |
| `warning` | `#fcd34d` | Warning |
| `text.primary` | `#ffffff` | Headings, now-playing title |
| `text.secondary` | `#c7ccd6` | Body, labels |
| `text.muted` | `#8b93a1` | Timestamps, hints (AA-passing) |

**Spacing** (4pt grid): `4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128`.
Card radius 16 · card padding 20 · card gap 16 · min touch target **44**.

**Type** (`DM Sans`, fallback `Inter`; mono only for numeric/technical values):
`0.8125 / 0.9375 / 1.0625 / 1.25 / 1.5 / 1.875 / 2.25 rem`, line-height 1.5.

**Motion:** `100 / 200 / 350 / 550 / 800 ms`; standard + spring easings;
**respect `prefers-reduced-motion`** (a settings toggle plus the OS flag).

## 3. Components (map the OG-Glass kit to RN)

`Button` (primary/secondary/ghost/danger) · `Badge` (live/on-air/off-air) ·
`Switch` (Watch⇄Listen, data saver, notifications) · `Skeleton` (loading) ·
`EmptyState` (**offline / not-live**) · `Toast` · `Tabs` · `ProgressBar` (track
progress) · `Avatar` · `Modal` · `FormField` (request submission).

## 4. Accessibility (must exceed the preset's 55%)

- **Every text token ≥ WCAG AA** (4.5:1 body, 3:1 large). The OG-Glass grade's one
  remaining warning is the muted token; `#8b93a1` is the AA-passing value to use.
- **Dynamic type**: honour OS font scaling; never clip at the largest size.
- **VoiceOver / TalkBack labels** on every control; the live badge and the
  Watch/Listen toggle announce state.
- **44pt minimum** targets; car mode uses larger.
- Reduce-motion; no auto-playing motion in the now-playing screen.

## 5. Quality gate

`og-glass validate_preset ncsound-dark` → passed, **97/100**, 1 warning (muted).
Re-run `validate_ui` on built screens once the app exists; treat >0 errors as a
build failure, and drive a11y coverage from 55% toward >90%.
