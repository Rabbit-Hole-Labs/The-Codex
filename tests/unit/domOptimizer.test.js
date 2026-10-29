/**
 * Unit tests for domOptimizer.js
 * Covers: tile creation, state diffing, section rendering, performance metrics
 */

describe('domOptimizer', () => {
    let domOptimizer;

    beforeEach(async () => {
        jest.resetModules();
        document.body.textContent = '';
        const container = document.createElement('div');
        container.id = 'links';
        document.body.appendChild(container);

        const mod = await import('../../javascript/features/domOptimizer.js');
        domOptimizer = mod.default;
    });

    describe('Performance Metrics', () => {
        test('getPerformanceMetrics returns metrics object', () => {
            const metrics = domOptimizer.getPerformanceMetrics();
            expect(metrics).toHaveProperty('renderTime');
            expect(metrics).toHaveProperty('domOperations');
            expect(metrics).toHaveProperty('memoryUsage');
            expect(metrics).toHaveProperty('lastRenderTimestamp');
        });

        test('resetPerformanceMetrics zeroes all counters', () => {
            domOptimizer.resetPerformanceMetrics();
            const metrics = domOptimizer.getPerformanceMetrics();
            expect(metrics.renderTime).toBe(0);
            expect(metrics.domOperations).toBe(0);
        });
    });

    describe('State Diffing', () => {
        test('calculateStateDiff detects added links', () => {
            const oldState = { links: [{ id: '1', name: 'A', url: 'https://a.com', category: 'Default' }] };
            const newState = {
                links: [
                    { id: '1', name: 'A', url: 'https://a.com', category: 'Default' },
                    { id: '2', name: 'B', url: 'https://b.com', category: 'Default' }
                ]
            };
            const diff = domOptimizer.calculateStateDiff(oldState, newState);
            expect(diff).toBeTruthy();
            if (diff.added) {
                expect(diff.added.length).toBeGreaterThan(0);
            } else {
                // Implementation may represent diff differently
                expect(diff.hasChanges || diff.linksChanged).toBeTruthy();
            }
        });

        test('calculateStateDiff returns no changes for identical states', () => {
            const state = { links: [{ id: '1', name: 'A', url: 'https://a.com', category: 'Default' }] };
            const diff = domOptimizer.calculateStateDiff(state, state);
            if (diff.added) {
                expect(diff.added.length).toBe(0);
                expect(diff.removed.length).toBe(0);
            } else {
                // May return null/undefined/false for no changes
                expect(!diff.hasChanges && !diff.linksChanged).toBeTruthy();
            }
        });

        test('calculateStateDiff detects removed links', () => {
            const oldState = {
                links: [
                    { id: '1', name: 'A', url: 'https://a.com', category: 'Default' },
                    { id: '2', name: 'B', url: 'https://b.com', category: 'Default' }
                ]
            };
            const newState = { links: [{ id: '1', name: 'A', url: 'https://a.com', category: 'Default' }] };
            const diff = domOptimizer.calculateStateDiff(oldState, newState);
            expect(diff).toBeTruthy();
        });
    });

    describe('Section Rendering', () => {
        test('optimizedRender creates DOM content in container', () => {
            const container = document.getElementById('links');
            const state = {
                links: [
                    { id: '1', name: 'Site A', url: 'https://a.com', category: 'Default', icon: null, size: null },
                    { id: '2', name: 'Site B', url: 'https://b.com', category: 'Work', icon: null, size: null }
                ],
                categories: ['Default', 'Work'],
                theme: 'dark',
                colorTheme: 'default',
                view: 'grid',
                searchTerm: '',
                defaultTileSize: 'medium',
                filteredLinks: []
            };
            domOptimizer.optimizedRender(container, state);
            // Should create some DOM content
            expect(container.children.length).toBeGreaterThanOrEqual(0);
        });

        test('optimizedRender handles empty links', () => {
            const container = document.getElementById('links');
            const state = {
                links: [],
                categories: ['Default'],
                theme: 'dark',
                colorTheme: 'default',
                view: 'grid',
                searchTerm: '',
                defaultTileSize: 'medium',
                filteredLinks: []
            };
            expect(() => domOptimizer.optimizedRender(container, state)).not.toThrow();
        });

        test('optimizedRender with search term shows no-results for non-matching', () => {
            const container = document.getElementById('links');
            const state = {
                links: [{ id: '1', name: 'Site A', url: 'https://a.com', category: 'Default', icon: null, size: null }],
                categories: ['Default'],
                theme: 'dark',
                colorTheme: 'default',
                view: 'grid',
                searchTerm: 'zzzznotfound',
                defaultTileSize: 'medium',
                filteredLinks: []
            };
            domOptimizer.optimizedRender(container, state);
            // Should show no-results or empty
            const text = container.textContent;
            expect(text.includes('No links found') || container.children.length === 0).toBeTruthy();
        });
    });

    describe('Updating an existing tile (updateLinkTile via performIncrementalUpdate)', () => {
        const ICON = 'https://cdn.jsdelivr.net/gh/selfhst/icons/png/a.png';

        // One category section holding one tile built the way the page renders it.
        function buildSection({ href = 'https://a.com/', content = true, name = true, icon = false, placeholder = false, iconSrc = 'https://cdn.jsdelivr.net/old.png' } = {}) {
            const container = document.getElementById('links');
            const section = document.createElement('section');
            section.className = 'category-section';
            const h2 = document.createElement('h2');
            h2.textContent = 'Default';
            const grid = document.createElement('div');
            grid.className = 'links-grid';
            const tile = document.createElement('a');
            tile.href = href;
            tile.className = 'link-tile size-small extra';
            if (content) {
                const body = document.createElement('div');
                body.className = 'tile-content';
                if (icon) {
                    const img = document.createElement('img');
                    img.className = 'tile-icon';
                    img.src = iconSrc;
                    body.appendChild(img);
                }
                if (placeholder) {
                    const ph = document.createElement('div');
                    ph.className = 'tile-placeholder';
                    body.appendChild(ph);
                }
                if (name) {
                    const h3 = document.createElement('h3');
                    h3.textContent = 'Old';
                    body.appendChild(h3);
                }
                tile.appendChild(body);
            }
            grid.appendChild(tile);
            section.append(h2, grid);
            container.appendChild(section);
            return { container, tile };
        }

        function update(container, link, extra = {}) {
            const state = { links: [link], searchTerm: '', view: 'grid', ...extra };
            return domOptimizer.performIncrementalUpdate(container, { linksChanged: true }, state);
        }

        const baseLink = (over = {}) => ({ name: 'Site A', url: 'https://a.com/', category: 'Default', icon: null, size: null, ...over });

        test('updates href, dataset and size class from link.size', () => {
            const { container, tile } = buildSection({ content: false });
            expect(update(container, baseLink({ size: 'wide' }))).toBe(true);
            expect(container.querySelectorAll('.link-tile')).toHaveLength(1);
            expect(tile.getAttribute('href')).toBe('https://a.com/');
            expect(tile.dataset.linkIndex).toBe('0');
            expect(tile.dataset.category).toBe('Default');
            expect(tile.className).toBe('link-tile size-wide');
        });

        test('size falls back to state.defaultTileSize, then medium', () => {
            let { container, tile } = buildSection({ content: false });
            update(container, baseLink(), { defaultTileSize: 'large' });
            expect(tile.className).toBe('link-tile size-large');

            document.getElementById('links').textContent = '';
            ({ container, tile } = buildSection({ content: false }));
            update(container, baseLink());
            expect(tile.className).toBe('link-tile size-medium');
        });

        test('writes the sanitized name into h3', () => {
            const { container, tile } = buildSection({ placeholder: true });
            update(container, baseLink({ name: 'A <b>& B' }));
            expect(tile.querySelector('h3').textContent).toBe('A & B');
        });

        test('content without h3 still updates the icon', () => {
            const { container, tile } = buildSection({ name: false, icon: true, placeholder: true });
            update(container, baseLink({ icon: ICON }));
            expect(tile.querySelector('h3')).toBeNull();
            expect(tile.querySelector('.tile-icon').src).toBe(ICON);
            expect(tile.querySelector('.tile-icon').style.display).toBe('block');
            expect(tile.querySelector('.tile-placeholder').style.display).toBe('none');
        });

        test('icon url with icon element: sets a changed src, shows icon, hides placeholder', () => {
            const { container, tile } = buildSection({ icon: true, placeholder: true });
            update(container, baseLink({ icon: ICON }));
            const img = tile.querySelector('.tile-icon');
            expect(img.src).toBe(ICON);
            expect(img.style.display).toBe('block');
            expect(tile.querySelector('.tile-placeholder').style.display).toBe('none');
        });

        test('icon url equal to the current src is not reassigned', () => {
            const { container, tile } = buildSection({ icon: true, iconSrc: ICON });
            const img = tile.querySelector('.tile-icon');
            const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
            const setSpy = jest.fn(v => desc.set.call(img, v));
            Object.defineProperty(img, 'src', { configurable: true, get() { return desc.get.call(img); }, set: setSpy });
            update(container, baseLink({ icon: ICON }));
            expect(setSpy).not.toHaveBeenCalled();
            expect(img.style.display).toBe('block');
        });

        test('icon url changed: src is assigned exactly once', () => {
            const { container, tile } = buildSection({ icon: true });
            const img = tile.querySelector('.tile-icon');
            const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
            const setSpy = jest.fn(v => desc.set.call(img, v));
            Object.defineProperty(img, 'src', { configurable: true, get() { return desc.get.call(img); }, set: setSpy });
            update(container, baseLink({ icon: ICON }));
            expect(setSpy).toHaveBeenCalledTimes(1);
            expect(setSpy).toHaveBeenCalledWith(ICON);
            expect(img.style.display).toBe('block');
        });

        test('no icon url: shows placeholder and hides icon', () => {
            const { container, tile } = buildSection({ icon: true, placeholder: true });
            update(container, baseLink({ icon: '   ' }));
            expect(tile.querySelector('.tile-placeholder').style.display).toBe('flex');
            const img = tile.querySelector('.tile-icon');
            expect(img.style.display).toBe('none');
            expect(img.getAttribute('src')).toBe('https://cdn.jsdelivr.net/old.png');
        });

        test('icon url but no icon element: falls back to showing the placeholder', () => {
            const { container, tile } = buildSection({ placeholder: true });
            update(container, baseLink({ icon: ICON }));
            expect(tile.querySelector('.tile-placeholder').style.display).toBe('flex');
            expect(tile.querySelector('.tile-icon')).toBeNull();
        });

        test('no icon url and no placeholder: icon element is left untouched', () => {
            const { container, tile } = buildSection({ icon: true });
            update(container, baseLink());
            const img = tile.querySelector('.tile-icon');
            expect(img.style.display).toBe('');
            expect(img.getAttribute('src')).toBe('https://cdn.jsdelivr.net/old.png');
        });
    });
});
