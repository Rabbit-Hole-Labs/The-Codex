import * as React from 'react';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Visual style. `primary` (default) fills with the accent; `secondary` is
   * the neutral flat control used for icon buttons; `danger` reads as
   * destructive.
   */
  variant?: 'primary' | 'secondary' | 'danger';
  /** Button contents (label and/or icon). */
  children?: React.ReactNode;
}

/**
 * The Codex action button: one flat shape everywhere, recolored by variant.
 *
 * `primary` is the main call to action; `secondary` is the neutral control
 * the dashboard uses for icon-only actions (settings, theme, view toggles);
 * `danger` is for destructive actions.
 */
export function Button({
  variant = 'primary',
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  const classes = ['codex-button'];
  if (variant !== 'secondary') classes.push(variant);
  if (className) classes.push(className);
  return (
    <button type={type} className={classes.join(' ')} {...rest}>
      {children}
    </button>
  );
}
