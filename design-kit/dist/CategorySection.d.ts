import * as React from 'react';
export interface CategorySectionProps {
    /** Category heading, rendered with the gradient title treatment. */
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
 * A titled, glassmorphic container that groups related `LinkTile`s.
 *
 * Shows a gradient category heading with a pulsing accent bar, then lays its
 * children out in the responsive links grid (or a single-column list). Hover
 * lifts the whole card with an accent glow.
 */
export declare function CategorySection({ title, children, view, className, }: CategorySectionProps): React.JSX.Element;
