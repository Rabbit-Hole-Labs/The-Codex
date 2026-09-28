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
export declare function SearchBar({ placeholder, value, defaultValue, onChange, className, }: SearchBarProps): React.JSX.Element;
