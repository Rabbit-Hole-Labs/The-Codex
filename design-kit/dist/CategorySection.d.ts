import * as React from 'react';
export interface CategorySectionProps {
    /** Category heading, rendered with the accent-underlined heading. */
    title: string;
    /** `LinkTile` elements laid out in the grid. */
    children?: React.ReactNode;
    /**
     * Layout of the tile grid. `grid` (default) is the responsive card grid;
     * `list` stacks tiles into single-column rows.
     */
    view?: 'grid' | 'list';
    /** Extra class names for the section. */
    className?: string;
}
/**
 * A titled, flat section that groups related `LinkTile`s.
 *
 * Shows the category heading (accent bar + accent-tinted underline), then
 * lays its children out in the responsive links grid (or a single-column
 * list). Multi-column tile sizes collapse when the section is too narrow.
 */
export declare function CategorySection({ title, children, view, className, }: CategorySectionProps): React.JSX.Element;
