import * as React from 'react';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Visual style. `primary` (default) is the gradient pill with a sheen sweep;
   * `glass` is the compact glassmorphic control used for icon buttons.
   */
  variant?: 'primary' | 'glass';
  /** Button contents (label and/or icon). */
  children?: React.ReactNode;
}

/**
 * The Codex action button.
 *
 * `primary` renders the gradient pill with an animated sheen and glow — used
 * for the main call to action. `glass` renders the compact frosted control the
 * dashboard uses for icon-only actions (settings, theme, view toggles).
 */
export function Button({
  variant = 'primary',
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  const classes = ['codex-button'];
  if (variant === 'glass') classes.push('glass');
  if (className) classes.push(className);
  return (
    <button type={type} className={classes.join(' ')} {...rest}>
      {children}
    </button>
  );
}
