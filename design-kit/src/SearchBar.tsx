import * as React from 'react';

export interface SearchBarProps {
  /** Placeholder text. Defaults to `Search...`. */
  placeholder?: string;
  /** Controlled value. */
  value?: string;
  /** Uncontrolled initial value. */
  defaultValue?: string;
  /** Change handler. */
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  /** Extra class names for the wrapper. */
  className?: string;
}

/**
 * The dashboard search field: a flat input with a leading magnifier icon and
 * an accent focus ring.
 *
 * Use at the top of the dashboard to filter tiles by name.
 */
export function SearchBar({
  placeholder = 'Search...',
  value,
  defaultValue,
  onChange,
  className,
}: SearchBarProps): React.JSX.Element {
  const classes = ['search-section'];
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')}>
      <div className="search-input-wrapper">
        <svg
          className="search-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="search"
          className="search-input"
          placeholder={placeholder}
          value={value}
          defaultValue={defaultValue}
          onChange={onChange}
          aria-label="Search"
        />
      </div>
    </div>
  );
}
