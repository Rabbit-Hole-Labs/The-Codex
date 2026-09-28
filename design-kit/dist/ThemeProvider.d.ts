import * as React from 'react';
import type { BaseTheme, ColorTheme } from './types';
export interface ThemeProviderProps {
    /** Base light/dark mode. Defaults to `dark`. */
    theme?: BaseTheme;
    /** Color theme layered on the base palette. Defaults to `default`. */
    colorTheme?: ColorTheme;
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
 * Every other Codex component must render inside a `ThemeProvider` — the base
 * (`dark`/`light`) and color-theme classes it applies are what define the
 * CSS custom properties (`--primary-color`, gradients, glow, glass) the
 * components read. Without it, components fall back to unstyled defaults.
 */
export declare function ThemeProvider({ theme, colorTheme, children, className, style, }: ThemeProviderProps): React.JSX.Element;
