import * as React from 'react';
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
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
export declare function Button({ variant, children, className, type, ...rest }: ButtonProps): React.JSX.Element;
