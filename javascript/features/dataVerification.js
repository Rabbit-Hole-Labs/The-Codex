// Data Verification and Inspection Utility
export class DataVerification {
    constructor() {
        this.modal = null;
        this.isFormatted = false;
    }

    // Get all data from sync storage
    async getCloudData() {
        try {
            const data = await chrome.storage.sync.get(null);
            return this.processStorageData(data, 'cloud');
        } catch (error) {
            throw new Error(`Failed to get cloud data: ${error.message}`);
        }
    }

    // Get all data from local storage
    async getLocalData() {
        try {
            const data = await chrome.storage.local.get(null);
            return this.processStorageData(data, 'local');
        } catch (error) {
            throw new Error(`Failed to get local data: ${error.message}`);
        }
    }

    // Process and analyze storage data
    processStorageData(rawData, source) {
        const processed = {
            source,
            timestamp: new Date().toISOString(),
            raw: rawData,
            parsed: {},
            summary: {
                totalKeys: 0,
                totalSize: 0,
                linkCount: 0,
                categoryCount: 0,
                hasMetadata: false
            }
        };

        // Parse known data structures
        try {
            if (rawData.links) {
                processed.parsed.links = JSON.parse(rawData.links);
                processed.summary.linkCount = processed.parsed.links.length;
            }
        } catch (e) {
            processed.parsed.linksError = 'Failed to parse links';
        }

        try {
            if (rawData.categories) {
                processed.parsed.categories = JSON.parse(rawData.categories);
                processed.summary.categoryCount = processed.parsed.categories.length;
            }
        } catch (e) {
            processed.parsed.categoriesError = 'Failed to parse categories';
        }

        // Include other data
        Object.keys(rawData).forEach(key => {
            if (!['links', 'categories'].includes(key)) {
                processed.parsed[key] = rawData[key];
            }
        });

        // Calculate summary
        processed.summary.totalKeys = Object.keys(rawData).length;
        processed.summary.totalSize = new Blob([JSON.stringify(rawData)]).size;
        processed.summary.hasMetadata = !!rawData.syncMetadata;

        return processed;
    }

    // Compare local and cloud data
    async compareData() {
        try {
            const [localData, cloudData] = await Promise.all([
                this.getLocalData(),
                this.getCloudData()
            ]);

            const comparison = {
                timestamp: new Date().toISOString(),
                local: localData,
                cloud: cloudData,
                differences: this.findDifferences(localData, cloudData),
                summary: this.createComparisonSummary(localData, cloudData)
            };

            return comparison;
        } catch (error) {
            throw new Error(`Failed to compare data: ${error.message}`);
        }
    }

    // Find differences between local and cloud data
    findDifferences(localData, cloudData) {
        const differences = {
            links: this.compareLinks(localData.parsed.links || [], cloudData.parsed.links || []),
            categories: this.compareArrays(localData.parsed.categories || [], cloudData.parsed.categories || []),
            metadata: this.compareMetadata(localData.parsed, cloudData.parsed),
            otherKeys: this.compareOtherKeys(localData.raw, cloudData.raw)
        };

        return differences;
    }

    // Compare links arrays
    compareLinks(localLinks, cloudLinks) {
        const localUrls = new Set(localLinks.map(link => link.url));
        const cloudUrls = new Set(cloudLinks.map(link => link.url));

        const onlyLocal = localLinks.filter(link => !cloudUrls.has(link.url));
        const onlyCloud = cloudLinks.filter(link => !localUrls.has(link.url));
        const common = localLinks.filter(link => cloudUrls.has(link.url));

        // Find modified links
        const modified = [];
        common.forEach(localLink => {
            const cloudLink = cloudLinks.find(link => link.url === localLink.url);
            if (JSON.stringify(localLink) !== JSON.stringify(cloudLink)) {
                modified.push({
                    url: localLink.url,
                    local: localLink,
                    cloud: cloudLink
                });
            }
        });

        return {
            onlyLocal,
            onlyCloud,
            modified,
            totalLocal: localLinks.length,
            totalCloud: cloudLinks.length
        };
    }

    // Compare arrays (for categories)
    compareArrays(localArray, cloudArray) {
        const localSet = new Set(localArray);
        const cloudSet = new Set(cloudArray);

        return {
            onlyLocal: localArray.filter(item => !cloudSet.has(item)),
            onlyCloud: cloudArray.filter(item => !localSet.has(item)),
            common: localArray.filter(item => cloudSet.has(item)),
            totalLocal: localArray.length,
            totalCloud: cloudArray.length
        };
    }

    // Compare metadata
    compareMetadata(localParsed, cloudParsed) {
        const localMeta = localParsed.syncMetadata;
        const cloudMeta = cloudParsed.syncMetadata;

        if (!localMeta && !cloudMeta) {
            return { status: 'both_missing' };
        }

        if (!localMeta) {
            return { status: 'local_missing', cloud: cloudMeta };
        }

        if (!cloudMeta) {
            return { status: 'cloud_missing', local: localMeta };
        }

        return {
            status: 'both_present',
            local: localMeta,
            cloud: cloudMeta,
            versionDiff: localMeta.version - cloudMeta.version,
            timeDiff: localMeta.lastModified - cloudMeta.lastModified
        };
    }

    // Compare other keys
    compareOtherKeys(localRaw, cloudRaw) {
        const knownKeys = ['links', 'categories', 'syncMetadata'];
        const localOther = Object.keys(localRaw).filter(key => !knownKeys.includes(key));
        const cloudOther = Object.keys(cloudRaw).filter(key => !knownKeys.includes(key));

        const localSet = new Set(localOther);
        const cloudSet = new Set(cloudOther);

        return {
            onlyLocal: localOther.filter(key => !cloudSet.has(key)),
            onlyCloud: cloudOther.filter(key => !localSet.has(key)),
            common: localOther.filter(key => cloudSet.has(key))
        };
    }

    // Create comparison summary
    createComparisonSummary(localData, cloudData) {
        return {
            sizeDifference: cloudData.summary.totalSize - localData.summary.totalSize,
            linkCountDifference: cloudData.summary.linkCount - localData.summary.linkCount,
            categoryCountDifference: cloudData.summary.categoryCount - localData.summary.categoryCount,
            keyCountDifference: cloudData.summary.totalKeys - localData.summary.totalKeys,
            isInSync: this.determineIfInSync(localData, cloudData)
        };
    }

    // Determine if data is in sync
    determineIfInSync(localData, cloudData) {
        const localStr = JSON.stringify(localData.raw);
        const cloudStr = JSON.stringify(cloudData.raw);
        return localStr === cloudStr;
    }

    // Validate data integrity
    async validateDataIntegrity() {
        try {
            const [localData, cloudData] = await Promise.all([
                this.getLocalData(),
                this.getCloudData()
            ]);

            const validation = {
                timestamp: new Date().toISOString(),
                local: this.validateDataStructure(localData),
                cloud: this.validateDataStructure(cloudData),
                crossValidation: this.crossValidateData(localData, cloudData)
            };

            return validation;
        } catch (error) {
            throw new Error(`Failed to validate data integrity: ${error.message}`);
        }
    }

    // Validate data structure
    validateDataStructure(data) {
        const validation = {
            isValid: true,
            errors: [],
            warnings: []
        };

        // Validate links
        if (data.parsed.links) {
            const linkValidation = this.validateLinks(data.parsed.links);
            validation.errors.push(...linkValidation.errors);
            validation.warnings.push(...linkValidation.warnings);
            if (!linkValidation.isValid) validation.isValid = false;
        } else {
            validation.warnings.push('No links data found');
        }

        // Validate categories
        if (data.parsed.categories) {
            const categoryValidation = this.validateCategories(data.parsed.categories);
            validation.errors.push(...categoryValidation.errors);
            validation.warnings.push(...categoryValidation.warnings);
            if (!categoryValidation.isValid) validation.isValid = false;
        } else {
            validation.warnings.push('No categories data found');
        }

        // Validate metadata
        if (data.parsed.syncMetadata) {
            const metaValidation = this.validateMetadata(data.parsed.syncMetadata);
            validation.errors.push(...metaValidation.errors);
            validation.warnings.push(...metaValidation.warnings);
        } else {
            validation.warnings.push('No sync metadata found');
        }

        return validation;
    }

    // Validate links array
    validateLinks(links) {
        const validation = { isValid: true, errors: [], warnings: [] };

        if (!Array.isArray(links)) {
            validation.isValid = false;
            validation.errors.push('Links is not an array');
            return validation;
        }

        const urls = new Set();

        links.forEach((link, index) => {
            // Check required fields
            if (!link.name) {
                validation.errors.push(`Link ${index}: Missing name`);
                validation.isValid = false;
            }

            if (!link.url) {
                validation.errors.push(`Link ${index}: Missing URL`);
                validation.isValid = false;
            } else {
                // Check for duplicates
                if (urls.has(link.url)) {
                    validation.warnings.push(`Link ${index}: Duplicate URL ${link.url}`);
                }
                urls.add(link.url);

                // Validate URL format
                try {
                    new URL(link.url);
                } catch (e) {
                    validation.errors.push(`Link ${index}: Invalid URL format: ${link.url}`);
                    validation.isValid = false;
                }
            }

            // Check for required category
            if (!link.category) {
                validation.warnings.push(`Link ${index}: Missing category, should default to "Default"`);
            }
        });

        return validation;
    }

    // Validate categories array
    validateCategories(categories) {
        const validation = { isValid: true, errors: [], warnings: [] };

        if (!Array.isArray(categories)) {
            validation.isValid = false;
            validation.errors.push('Categories is not an array');
            return validation;
        }

        if (!categories.includes('Default')) {
            validation.errors.push('Missing required "Default" category');
            validation.isValid = false;
        }

        // Check for duplicates
        const seen = new Set();
        categories.forEach((category, index) => {
            if (seen.has(category)) {
                validation.warnings.push(`Duplicate category: ${category}`);
            }
            seen.add(category);
        });

        return validation;
    }

    // Validate metadata
    validateMetadata(metadata) {
        const validation = { isValid: true, errors: [], warnings: [] };

        if (!metadata.version) {
            validation.warnings.push('Missing metadata version');
        }

        if (!metadata.lastModified) {
            validation.warnings.push('Missing metadata lastModified timestamp');
        }

        if (!metadata.deviceId) {
            validation.warnings.push('Missing metadata deviceId');
        }

        return validation;
    }

    // Cross-validate data between local and cloud
    crossValidateData(localData, cloudData) {
        const validation = { isValid: true, errors: [], warnings: [] };

        // Check if categories match link categories
        const localCategories = new Set(localData.parsed.categories || []);
        const cloudCategories = new Set(cloudData.parsed.categories || []);

        // Check local links against local categories
        if (localData.parsed.links) {
            localData.parsed.links.forEach((link, index) => {
                if (link.category && !localCategories.has(link.category)) {
                    validation.warnings.push(`Local link ${index}: Category "${link.category}" not found in categories list`);
                }
            });
        }

        // Check cloud links against cloud categories
        if (cloudData.parsed.links) {
            cloudData.parsed.links.forEach((link, index) => {
                if (link.category && !cloudCategories.has(link.category)) {
                    validation.warnings.push(`Cloud link ${index}: Category "${link.category}" not found in categories list`);
                }
            });
        }

        return validation;
    }

    // Show data in modal
    showDataModal(title, data, type = 'json') {
        this.createModal();

        const modal = document.getElementById('data-viewer-modal');
        const header = modal.querySelector('.data-viewer-header h3');
        const body = modal.querySelector('.data-viewer-body');

        header.textContent = title;

        let content = '';

        if (type === 'comparison') {
            content = this.renderComparison(data);
        } else if (type === 'validation') {
            content = this.renderValidation(data);
        } else {
            content = this.renderDataViewer(data);
        }

        body.innerHTML = content;
        modal.classList.add('show');

        // Setup controls
        this.setupModalControls();
    }

    // Create modal HTML
    createModal() {
        if (document.getElementById('data-viewer-modal')) return;

        const modal = document.createElement('div');
        modal.id = 'data-viewer-modal';
        modal.className = 'data-viewer-modal';
        modal.innerHTML = `
            <div class="data-viewer-content">
                <div class="data-viewer-header">
                    <h3>Data Viewer</h3>
                    <button class="data-viewer-close">&times;</button>
                </div>
                <div class="data-viewer-body">
                    <!-- Content will be inserted here -->
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Close modal handlers
        modal.querySelector('.data-viewer-close').addEventListener('click', () => {
            modal.classList.remove('show');
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('show');
            }
        });
    }

    // Render data viewer
    renderDataViewer(data) {
        const summary = data.summary;

        return `
            <div class="data-summary">
                <div class="data-summary-row">
                    <strong>Source:</strong>
                    <span>${data.source}</span>
                </div>
                <div class="data-summary-row">
                    <strong>Total Keys:</strong>
                    <span>${summary.totalKeys}</span>
                </div>
                <div class="data-summary-row">
                    <strong>Data Size:</strong>
                    <span>${(summary.totalSize / 1024).toFixed(2)} KB</span>
                </div>
                <div class="data-summary-row">
                    <strong>Links:</strong>
                    <span>${summary.linkCount}</span>
                </div>
                <div class="data-summary-row">
                    <strong>Categories:</strong>
                    <span>${summary.categoryCount}</span>
                </div>
                <div class="data-summary-row">
                    <strong>Has Metadata:</strong>
                    <span>${summary.hasMetadata ? 'Yes' : 'No'}</span>
                </div>
            </div>

            <div class="data-viewer-controls">
                <button onclick="dataVerification.toggleFormat()" class="btn-secondary">Toggle Format</button>
                <button onclick="dataVerification.exportCurrentData()" class="btn-secondary">Export</button>
                <button onclick="dataVerification.copyToClipboard()" class="btn-secondary">Copy</button>
            </div>

            <div class="data-content" id="data-content">
${JSON.stringify(data.parsed, null, 2)}
            </div>
        `;
    }

    // Render comparison view
    renderComparison(comparison) {
        const diff = comparison.differences;
        const summary = comparison.summary;

        return `
            <div class="data-summary">
                <div class="data-summary-row">
                    <strong>In Sync:</strong>
                    <span style="color: ${summary.isInSync ? '#4caf50' : '#f44336'}">${summary.isInSync ? 'Yes' : 'No'}</span>
                </div>
                <div class="data-summary-row">
                    <strong>Size Difference:</strong>
                    <span>${summary.sizeDifference} bytes</span>
                </div>
                <div class="data-summary-row">
                    <strong>Link Count Diff:</strong>
                    <span>${summary.linkCountDifference}</span>
                </div>
                <div class="data-summary-row">
                    <strong>Category Count Diff:</strong>
                    <span>${summary.categoryCountDifference}</span>
                </div>
            </div>

            <div class="data-comparison">
                <div class="comparison-column">
                    <h4>Local Data</h4>
                    <div><strong>Links:</strong> ${comparison.local.summary.linkCount}</div>
                    <div><strong>Categories:</strong> ${comparison.local.summary.categoryCount}</div>
                    <div><strong>Size:</strong> ${(comparison.local.summary.totalSize / 1024).toFixed(2)} KB</div>
                </div>
                <div class="comparison-column">
                    <h4>Cloud Data</h4>
                    <div><strong>Links:</strong> ${comparison.cloud.summary.linkCount}</div>
                    <div><strong>Categories:</strong> ${comparison.cloud.summary.categoryCount}</div>
                    <div><strong>Size:</strong> ${(comparison.cloud.summary.totalSize / 1024).toFixed(2)} KB</div>
                </div>
            </div>

            <div class="data-content">
<strong>Link Differences:</strong>
• Only Local: ${diff.links.onlyLocal.length}
• Only Cloud: ${diff.links.onlyCloud.length}
• Modified: ${diff.links.modified.length}

<strong>Category Differences:</strong>
• Only Local: ${diff.categories.onlyLocal.join(', ') || 'None'}
• Only Cloud: ${diff.categories.onlyCloud.join(', ') || 'None'}

<strong>Metadata Status:</strong>
${JSON.stringify(diff.metadata, null, 2)}
            </div>
        `;
    }

    // Render validation view
    renderValidation(validation) {
        const localVal = validation.local;
        const cloudVal = validation.cloud;
        const crossVal = validation.crossValidation;

        return `
            <div class="data-summary">
                <div class="data-summary-row">
                    <strong>Local Valid:</strong>
                    <span style="color: ${localVal.isValid ? '#4caf50' : '#f44336'}">${localVal.isValid ? 'Yes' : 'No'}</span>
                </div>
                <div class="data-summary-row">
                    <strong>Cloud Valid:</strong>
                    <span style="color: ${cloudVal.isValid ? '#4caf50' : '#f44336'}">${cloudVal.isValid ? 'Yes' : 'No'}</span>
                </div>
                <div class="data-summary-row">
                    <strong>Cross-validation:</strong>
                    <span style="color: ${crossVal.isValid ? '#4caf50' : '#f44336'}">${crossVal.isValid ? 'Passed' : 'Issues Found'}</span>
                </div>
            </div>

            <div class="data-content">
<strong>Local Data Validation:</strong>
Errors: ${localVal.errors.length}
${localVal.errors.map(err => `• ${err}`).join('\n')}

Warnings: ${localVal.warnings.length}
${localVal.warnings.map(warn => `• ${warn}`).join('\n')}

<strong>Cloud Data Validation:</strong>
Errors: ${cloudVal.errors.length}
${cloudVal.errors.map(err => `• ${err}`).join('\n')}

Warnings: ${cloudVal.warnings.length}
${cloudVal.warnings.map(warn => `• ${warn}`).join('\n')}

<strong>Cross-validation:</strong>
Errors: ${crossVal.errors.length}
${crossVal.errors.map(err => `• ${err}`).join('\n')}

Warnings: ${crossVal.warnings.length}
${crossVal.warnings.map(warn => `• ${warn}`).join('\n')}
            </div>
        `;
    }

    // Setup modal controls
    setupModalControls() {
        // Make methods available globally for button clicks
        window.dataVerification = this;
    }

    // Toggle data formatting
    toggleFormat() {
        const content = document.getElementById('data-content');
        if (content) {
            this.isFormatted = !this.isFormatted;
            content.classList.toggle('formatted', this.isFormatted);
        }
    }

    // Export current data
    exportCurrentData() {
        const content = document.getElementById('data-content');
        if (content) {
            const dataStr = content.textContent;
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const link = document.createElement('a');
            link.href = url;
            link.download = `codex-data-${Date.now()}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }
    }

    // Copy to clipboard
    async copyToClipboard() {
        const content = document.getElementById('data-content');
        if (content) {
            try {
                await navigator.clipboard.writeText(content.textContent);
                alert('Data copied to clipboard');
            } catch (error) {
                console.error('Failed to copy to clipboard:', error);
                alert('Failed to copy to clipboard');
            }
        }
    }
}

// Create and export singleton instance
export const dataVerification = new DataVerification();