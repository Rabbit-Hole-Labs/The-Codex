/** Base light/dark mode applied by {@link ThemeProvider}. */
export type BaseTheme = 'dark' | 'light';

/**
 * Accent preset. Recolors only the single muted accent (`--primary-*`);
 * `slate` is the default palette.
 */
export type Accent = 'slate' | 'blue' | 'teal' | 'violet' | 'amber';

/** Tile footprint. Sizes map to fixed heights and grid spans. */
export type TileSize =
  | 'compact'
  | 'small'
  | 'medium'
  | 'large'
  | 'wide'
  | 'tall'
  | 'square'
  | 'giant';
