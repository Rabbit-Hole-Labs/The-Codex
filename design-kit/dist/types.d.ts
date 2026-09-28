/** Base light/dark mode applied by {@link ThemeProvider}. */
export type BaseTheme = 'dark' | 'light';
/**
 * Codex color theme. Layers on top of the base theme to recolor the primary
 * accent, gradients, and glow. `default` keeps the base palette.
 */
export type ColorTheme = 'default' | 'ocean' | 'cosmic' | 'sunset' | 'forest' | 'fire' | 'aurora' | 'theme-purple' | 'theme-pink' | 'theme-green' | 'theme-orange' | 'theme-teal' | 'theme-cyber' | 'theme-focus' | 'theme-dark-orange' | 'theme-dark-purple' | 'theme-dark-emerald' | 'theme-dark-crimson' | 'theme-dark-sapphire';
/** Tile footprint. Sizes map to fixed heights and grid spans. */
export type TileSize = 'compact' | 'small' | 'medium' | 'large' | 'wide' | 'tall' | 'square' | 'giant';
