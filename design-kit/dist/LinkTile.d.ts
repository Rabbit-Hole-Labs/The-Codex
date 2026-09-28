import * as React from 'react';
import type { TileSize } from './types';
export interface LinkTileProps {
    /** Site name shown under the icon. */
    name: string;
    /** Destination URL. Rendered as an anchor when provided. */
    url?: string;
    /**
     * Icon image URL. When omitted, a gradient placeholder shows the first
     * letter of `name`.
     */
    iconUrl?: string;
    /** Tile footprint. Defaults to `medium`. */
    size?: TileSize;
    /**
     * When true, treats the icon as a full-bleed background and lightens the
     * title for contrast.
     */
    hasBackgroundIcon?: boolean;
    /** Extra class names. */
    className?: string;
    /** Click handler (used when no `url` is set). */
    onClick?: React.MouseEventHandler<HTMLElement>;
}
/**
 * A single dashboard tile linking to a site.
 *
 * Renders the glassmorphic Codex tile with a hover lift and accent glow. Shows
 * the site icon (or a gradient initial placeholder) above a two-line clamped
 * title. Render tiles as the children of a `CategorySection`.
 */
export declare function LinkTile({ name, url, iconUrl, size, hasBackgroundIcon, className, onClick, }: LinkTileProps): React.JSX.Element;
