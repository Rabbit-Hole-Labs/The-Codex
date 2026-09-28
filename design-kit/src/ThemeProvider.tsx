import * as React from 'react';
import type { Accent, BaseTheme } from './types.js';

export interface ThemeProviderProps {
  /** Base light/dark mode. Defaults to `dark`. */
  theme?: BaseTheme;
  /** Accent preset. Defaults to `slate`. */
  accent?: Accent;
  /** Content styled by the Codex design tokens. */
  children?: React.ReactNode;
  /** Extra class names appended to the root wrapper. */
  className?: string;
  /** Inline styles for the root wrapper. */
  style?: React.CSSProperties;
}

/**
 * Root wrapper that establishes the Codex design tokens on its subtree.
 *
 * Every other Codex component must render inside a `ThemeProvider` — the
 * `.codex-root` wrapper and its base (`dark`/`light`) class define the CSS
 * custom properties the components read, and all component selectors are
 * scoped beneath it. Without it, components render unstyled.
 */
export function ThemeProvider({
  theme = 'dark',
  accent = 'slate',
  children,
  className,
  style,
}: ThemeProviderProps): React.JSX.Element {
  const classes = ['codex-root', theme];
  if (className) classes.push(className);
  return (
    <div
      className={classes.join(' ')}
      data-accent={accent !== 'slate' ? accent : undefined}
      style={style}
    >
      {children}
    </div>
  );
}
