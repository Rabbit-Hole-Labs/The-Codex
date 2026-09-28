import * as React from 'react';
import { validateAndSanitizeUrl } from '../../javascript/features/utils.js';
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
export function safeHttpUrl(url: string | undefined): string | null {
  if (!url) return null;
  const safe = validateAndSanitizeUrl(url);
  return safe === '#' ? null : safe;
}

/**
 * A single dashboard tile linking to a site.
 *
 * Renders the flat Codex tile: the site icon (or an initial placeholder)
 * above a two-line clamped title. Link tiles open in a new tab, like the
 * extension's own tiles. Render tiles as the children of a `CategorySection`.
 */
export function LinkTile({
  name,
  url,
  iconUrl,
  size = 'medium',
  className,
  onClick,
}: LinkTileProps): React.JSX.Element {
  const [iconFailed, setIconFailed] = React.useState(false);
  React.useEffect(() => setIconFailed(false), [iconUrl]);

  const classes = ['link-tile', `size-${size}`];
  if (className) classes.push(className);

  const content = (
    <span className="tile-content">
      {iconUrl && !iconFailed ? (
        <img
          className="tile-icon"
          src={iconUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setIconFailed(true)}
        />
      ) : (
        <span className="tile-placeholder" aria-hidden="true">
          {name.charAt(0).toUpperCase()}
        </span>
      )}
      <h3>{name}</h3>
    </span>
  );

  const href = safeHttpUrl(url);
  if (href) {
    return (
      <a
        className={classes.join(' ')}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onClick}
      >
        {content}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={classes.join(' ')} onClick={onClick}>
        {content}
      </button>
    );
  }
  // No action: don't put a dead control in the tab order.
  classes.push('is-static');
  return <div className={classes.join(' ')}>{content}</div>;
}
