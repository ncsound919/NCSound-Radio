/**
 * NCSound design tokens — the OG-Glass `ncsound-dark` contract.
 *
 * One source for colour, spacing, type, radius and motion so screens cannot
 * drift. Values come from `docs/LISTENER-APP-DESIGN.md` (preset `ncsound-dark`,
 * graded S/100). Do not introduce colours outside `colors`; keep spacing on the
 * 4pt grid; the muted text token is the AA-passing `#8b93a1`.
 */

export const colors = {
  /** App background — near-black substrate. */
  bg: '#050508',
  /** Cards / raised panels (translucent white over the substrate). */
  surface: 'rgba(255,255,255,0.04)',
  /** Pressed / active rows. */
  surfaceStrong: 'rgba(255,255,255,0.08)',
  /** Dividers, input borders. */
  border: 'rgba(255,255,255,0.10)',
  /** Modals. */
  overlay: 'rgba(0,0,0,0.72)',
  /** Brand accent — live dot, primary actions, focus ring. */
  accent: '#ffb020',
  accentHover: '#ffc45c',
  accentSecondary: '#94a3b8',
  danger: '#f87171',
  success: '#86efac',
  warning: '#fcd34d',
  text: {
    /** Headings, now-playing title. */
    primary: '#ffffff',
    /** Body, labels. */
    secondary: '#c7ccd6',
    /** Timestamps, hints — AA (4.5:1+) on `bg`. */
    muted: '#8b93a1',
  },
} as const;

/** 4pt grid. */
export const spacing = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  x4: 40,
  x5: 48,
  x6: 64,
  x7: 80,
  x8: 96,
  x9: 128,
} as const;

export const radius = {
  card: 16,
  pill: 999,
} as const;

export const typography = {
  /** Added as assets in a later step; names are the contract. */
  family: {
    body: 'DM Sans',
    mono: 'JetBrains Mono',
  },
  /** Point sizes (≈ the design's rem scale at 16px). */
  size: {
    xs: 13,
    sm: 13,
    base: 15,
    lg: 17,
    xl: 20,
    xxl: 24,
    xxxl: 30,
    display: 36,
  },
  weight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
  lineHeight: 1.5,
} as const;

/** Durations in ms. Respect reduced-motion; keep under 800ms. */
export const motion = {
  instant: 100,
  fast: 200,
  normal: 350,
  slow: 550,
  xslow: 800,
} as const;

/** Minimum touch target (Apple HIG 44pt). */
export const touch = {
  min: 44,
} as const;

export type Tokens = {
  colors: typeof colors;
  spacing: typeof spacing;
  radius: typeof radius;
  typography: typeof typography;
  motion: typeof motion;
  touch: typeof touch;
};
