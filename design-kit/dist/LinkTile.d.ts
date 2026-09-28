import * as React from 'react';
import type { TileSize } from './types.js';
export interface LinkTileProps {
    /** Site name shown under the icon. */
    name: string;
    /**
     * Destination URL. Rendered as an anchor (opening in a new tab) only when it
     * passes the extension's `validateAndSanitizeUrl()` policy: `http:`/`https:`
     * and not a blocked shortener/suspicious domain. Anything else is dropped.
     */
    url?: string;
    /**
     * Icon image URL, rendered verbatim. When omitted — or when the image fails
     * to load — a placeholder shows the first letter of `name`.
     */
    iconUrl?: string;
    /** Tile footprint. Defaults to `medium`. */
    size?: TileSize;
    /** Extra class names. */
    className?: string;
    /**
     * Click handler. Fires for anchor tiles too. Without a usable `url` the
     * tile is a native `<button>` (Enter/Space activate it); with neither a
     * usable `url` nor `onClick` it renders as static, non-interactive content.
     */
    onClick?: React.MouseEventHandler<HTMLElement>;
}
/**
 * Returns `url` normalized if the extension's `validateAndSanitizeUrl()`
 * accepts it (http/https only, blocked domains rejected), otherwise `null`.
 * This is the single URL policy shared with every extension tile renderer.
 */
export declare function safeHttpUrl(url: string | undefined): string | null;
/**
 * A single dashboard tile linking to a site.
 *
 * Renders the flat Codex tile: the site icon (or an initial placeholder)
 * above a two-line clamped title. Link tiles open in a new tab, like the
 * extension's own tiles. Render tiles as the children of a `CategorySection`.
 */
export declare function LinkTile({ name, url, iconUrl, size, className, onClick, }: LinkTileProps): React.JSX.Element;
