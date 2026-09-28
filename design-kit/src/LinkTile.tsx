import * as React from 'react';
import type { TileSize } from './types.js';

export interface LinkTileProps {
  /** Site name shown under the icon. */
  name: string;
  /**
   * Destination URL. Rendered as an anchor (opening in a new tab) when it is
   * a valid `http:`/`https:` URL; any other scheme (`javascript:`, `data:`,
   * …) is dropped and the tile renders as a button instead.
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
   * Click handler. Fires for anchor tiles too; without a `url` the tile is a
   * native `<button>`, so Enter/Space activate it.
   */
  onClick?: React.MouseEventHandler<HTMLElement>;
}

/**
 * Returns `url` normalized if it parses as an absolute `http:`/`https:` URL,
 * otherwise `null`. Mirrors the extension's `validateAndSanitizeUrl()` scheme
 * allowlist so dangerous schemes never reach an `href`.
 */
export function safeHttpUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href
      : null;
  } catch {
    return null;
  }
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
  return (
    <button type="button" className={classes.join(' ')} onClick={onClick}>
      {content}
    </button>
  );
}
