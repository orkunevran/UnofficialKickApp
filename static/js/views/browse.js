/**
 * Browse view — Featured streams with card grid, filters, infinite scroll, auto-refresh.
 */

import { fetchFeaturedStreams } from '../api.js?v=2.3.5';
import { renderStreamGrid, renderCardSkeleton, updateFavoritesBadge, patchStreamGrid } from '../ui.js?v=2.3.5';
import { appState, featuredSortState, preferences } from '../state.js?v=2.3.5';
import { applyFeaturedStreamsSort } from '../sorting.js?v=2.3.5';
import { toast } from '../toast.js?v=2.3.5';

const REFRESH_INTERVAL_MS = 90_000;
const DEFAULT_PAGE_SIZE = 14;

// Module state (persists across route changes via closure)
let currentLanguage = null;
let currentCategory = '';
let pageCache = new Map();
let pageMetaCache = new Map();
let loadedPageCount = 0;
let hasNextPage = true;
let refreshGeneration = 0;
let activeGeneration = 0;
let refreshInFlight = false;
let scrollLoadInFlight = false;
let prefetchInFlightPages = new Map();

// Active timers/observers (cleaned up on unmount)
let refreshTimer = null;
let scrollObserver = null;
let isHovered = false;
let isFocusWithin = false;

function isPaused() {
    return document.visibilityState !== 'visible' || isHovered || isFocusWithin;
}

function hasFreshCache() {
    return activeGeneration === refreshGeneration;
}

function mergePagesIntoStreams() {
    const seen = new Set();
    const merged = [];
    for (let page = 1; page <= loadedPageCount; page++) {
        const streams = pageCache.get(page) || [];
        streams.forEach(stream => {
            const slug = stream.channel?.slug || stream.slug || '';
            if (!slug || seen.has(slug)) return;
            seen.add(slug);
            merged.push(stream);
        });
    }
    return merged;
}

function syncLoadedRange() {
    let count = 0;
    while (pageCache.has(count + 1)) count++;
    loadedPageCount = count;
    if (count === 0) {
        hasNextPage = false;
        return;
    }
    const meta = pageMetaCache.get(count);
    hasNextPage = Boolean(meta?.hasNext);
}

function getServerSort() {
    if (!currentCategory) return '';
    if (!featuredSortState.column) return 'featured';
    if (featuredSortState.column === 'viewer_count') {
        return featuredSortState.direction === 'asc' ? 'asc' : 'desc';
    }
    return 'featured';
}

async function fetchPageData(language, page, generation) {
    const filters = currentCategory
        ? { subcategory: currentCategory, sort: getServerSort(), strict: true }
        : {};
    const response = await fetchFeaturedStreams(language, page, filters);
    if (generation !== refreshGeneration) return null;
    if (response?.status !== 'success') throw new Error(`Page ${page} failed`);
    return {
        page,
        streams: Array.isArray(response.data) ? response.data : [],
        perPage: response.pagination?.per_page || DEFAULT_PAGE_SIZE,
        hasNext: Boolean(response.pagination?.has_next),
    };
}

function applyPageResult(cache, metaCache, result) {
    if (!result) return;
    cache.set(result.page, result.streams);
    metaCache.set(result.page, { hasNext: result.hasNext, perPage: result.perPage });
}

function rebuildAndRender(contentEl, { renderMode = 'full' } = {}) {
    const merged = mergePagesIntoStreams();
    appState.featuredStreams = applyFeaturedStreamsSort(merged, featuredSortState);
    appState.searchPool = [...appState.featuredStreams];

    // Update category selector options
    populateCategorySelector(appState.featuredStreams);

    // Render grid
    const gridContainer = contentEl?.querySelector('#browse-grid');
    if (gridContainer) {
        if (renderMode === 'full') {
            gridContainer.innerHTML = renderStreamGrid(appState.featuredStreams, preferences.viewMode);
        } else {
            patchStreamGrid(gridContainer, appState.featuredStreams, preferences.viewMode);
        }
    }

    // Update count
    const countEl = contentEl?.querySelector('#stream-count');
    if (countEl) {
        countEl.textContent = appState.featuredStreams.length > 0 ? `(${appState.featuredStreams.length})` : '';
    }

    // Update sentinel
    updateSentinel(contentEl);
}

function updateSentinel(contentEl) {
    const sentinel = contentEl?.querySelector('#scroll-sentinel');
    const spinner = contentEl?.querySelector('#sentinel-spinner');
    const endMsg = contentEl?.querySelector('#sentinel-end');
    if (!sentinel) return;

    if (appState.featuredStreams.length === 0) {
        sentinel.style.display = 'none';
        return;
    }
    sentinel.style.display = 'flex';
    if (hasNextPage) {
        if (spinner) spinner.style.display = scrollLoadInFlight ? 'flex' : 'none';
        if (endMsg) endMsg.style.display = 'none';
    } else {
        if (spinner) spinner.style.display = 'none';
        if (endMsg) {
            endMsg.style.display = 'block';
            endMsg.textContent = `All ${appState.featuredStreams.length} streams loaded`;
        }
    }
}

function populateCategorySelector(streams) {
    const sel = document.getElementById('categorySelector');
    if (!sel) return;
    const prev = sel.value;
    const catMap = new Map();
    streams.forEach(s => {
        const cat = s.categories?.[0];
        if (cat?.slug && cat?.name) catMap.set(cat.slug, cat.name);
    });
    const sorted = [...catMap.keys()].sort((a, b) => catMap.get(a).localeCompare(catMap.get(b)));
    sel.innerHTML = '<option value="">All Categories</option>';
    sorted.forEach(slug => {
        const opt = document.createElement('option');
        opt.value = slug;
        opt.textContent = catMap.get(slug);
        sel.appendChild(opt);
    });
    if (prev && sorted.includes(prev)) {
        sel.value = prev;
    } else if (currentCategory && !sorted.includes(currentCategory)) {
        currentCategory = '';
        sel.value = '';
    }
}

async function loadInitialPages(language, contentEl, browseView) {
    const generation = ++refreshGeneration;
    refreshInFlight = true;
    browseView?.classList.add('browse-bootstrapping'); // Keep browse renders static to avoid the initial flash.

    // Show spinner
    const inlineSpinner = contentEl?.querySelector('#featured-spinner');
    if (inlineSpinner) inlineSpinner.classList.add('is-active');

    try {
        const result = await fetchPageData(language, 1, generation);
        if (generation !== refreshGeneration) return;

        const newCache = new Map();
        const newMeta = new Map();
        applyPageResult(newCache, newMeta, result);

        pageCache = newCache;
        pageMetaCache = newMeta;
        activeGeneration = refreshGeneration;
        syncLoadedRange();
        rebuildAndRender(contentEl);
        initScrollObserver(contentEl);
        prefetchNextPage();
    } catch (err) {
        console.error('Error loading featured streams:', err);
        toast('Failed to load featured streams.', 'error', {
            action: { label: 'Retry', onClick: () => loadInitialPages(language, contentEl, browseView) }
        });
    } finally {
        if (generation === refreshGeneration) refreshInFlight = false;
        if (inlineSpinner) inlineSpinner.classList.remove('is-active');
    }
}

async function backgroundRefresh(language, contentEl) {
    if (isPaused() || refreshInFlight) return;
    const generation = ++refreshGeneration;
    refreshInFlight = true;

    const inlineSpinner = contentEl?.querySelector('#featured-spinner');
    if (inlineSpinner) inlineSpinner.classList.add('is-active');

    try {
        const result = await fetchPageData(language, 1, generation);
        if (generation !== refreshGeneration) return;
        applyPageResult(pageCache, pageMetaCache, result);
        activeGeneration = refreshGeneration;
        rebuildAndRender(contentEl, { renderMode: 'refresh' });
    } catch (err) {
        console.error('Background refresh error:', err);
    } finally {
        if (generation === refreshGeneration) refreshInFlight = false;
        if (inlineSpinner) inlineSpinner.classList.remove('is-active');
    }
}

function prefetchNextPage() {
    if (!hasNextPage || !currentLanguage || refreshInFlight) return;
    const nextPage = loadedPageCount + 1;
    if (pageCache.has(nextPage) || prefetchInFlightPages.has(nextPage)) return;

    const generation = refreshGeneration;
    const promise = fetchPageData(currentLanguage, nextPage, generation)
        .then(result => {
            if (generation !== refreshGeneration) return;
            applyPageResult(pageCache, pageMetaCache, result);
        })
        .catch(() => {})
        .finally(() => { prefetchInFlightPages.delete(nextPage); });
    prefetchInFlightPages.set(nextPage, promise);
}

async function loadNextScrollPage(contentEl) {
    if (scrollLoadInFlight || !hasNextPage || !currentLanguage || refreshInFlight) return;
    scrollLoadInFlight = true;
    updateSentinel(contentEl);

    try {
        const nextPage = loadedPageCount + 1;
        const generation = refreshGeneration;

        // Wait for prefetch if already in flight, otherwise fetch now
        if (prefetchInFlightPages.has(nextPage)) {
            await prefetchInFlightPages.get(nextPage);
        }
        if (!pageCache.has(nextPage)) {
            const result = await fetchPageData(currentLanguage, nextPage, generation);
            if (generation !== refreshGeneration) return;
            applyPageResult(pageCache, pageMetaCache, result);
        }
        if (generation !== refreshGeneration) return;
        syncLoadedRange();
        rebuildAndRender(contentEl, { renderMode: 'append' });

        // Immediately prefetch the page after this one
        prefetchNextPage();
    } catch (err) {
        console.error('Error loading next page:', err);
    } finally {
        scrollLoadInFlight = false;
        updateSentinel(contentEl);
    }
}

function initScrollObserver(contentEl) {
    if (scrollObserver) scrollObserver.disconnect();
    const sentinel = contentEl?.querySelector('#scroll-sentinel');
    const scrollRoot = document.getElementById('content-area');
    if (!sentinel || !scrollRoot) return;

    scrollObserver = new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting) return;
        if (scrollLoadInFlight || refreshInFlight || !hasNextPage || !hasFreshCache()) return;
        void loadNextScrollPage(contentEl);
    }, { root: scrollRoot, rootMargin: '800px', threshold: 0 });
    scrollObserver.observe(sentinel);
}

async function populateLanguageSelector() {
    const sel = document.getElementById('languageSelector');
    if (!sel) return;
    try {
        const res = await fetch('/config/languages');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const config = await res.json();
        sel.innerHTML = '';
        config.languages.forEach(lang => {
            const opt = document.createElement('option');
            opt.value = lang.code;
            opt.textContent = lang.name;
            if (lang.code === (preferences.language || config.default_language)) opt.selected = true;
            sel.appendChild(opt);
        });
        currentLanguage = sel.value;
    } catch {
        sel.innerHTML = '<option value="en">English</option>';
        currentLanguage = 'en';
    }
}

// ── Mount / Unmount ───────────────────────────────────────────────────────

export async function mount(params, contentEl) {
    contentEl.innerHTML = `
        <div id="browse-view">
            <div class="section-header">
                <h1 class="section-title">Featured Streams <span id="stream-count" class="section-count"></span></h1>
                <span id="featured-spinner" class="inline-spinner" aria-hidden="true"></span>
            </div>

            <div class="filter-bar">
                <select id="languageSelector" class="filter-select" aria-label="Language"></select>
                <select id="categorySelector" class="filter-select" aria-label="Category">
                    <option value="">All Categories</option>
                </select>

                <div class="sort-pills">
                    <button class="sort-pill" data-sort="viewer_count" data-type="number">Viewers</button>
                    <button class="sort-pill" data-sort="session_title" data-type="string">Title</button>
                    <button class="sort-pill" data-sort="channel.user.username" data-type="string">Channel</button>
                </div>

                <div class="view-toggle">
                    <button class="view-toggle-btn ${preferences.viewMode === 'grid' ? 'active' : ''}" data-view="grid" title="Grid view">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                    </button>
                    <button class="view-toggle-btn ${preferences.viewMode === 'list' ? 'active' : ''}" data-view="list" title="List view">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                    </button>
                </div>
            </div>

            <div id="browse-grid">
                <div class="stream-grid">${renderCardSkeleton(8)}</div>
            </div>

            <div id="scroll-sentinel" class="scroll-sentinel" style="display:none">
                <div id="sentinel-spinner" style="display:none;align-items:center;gap:8px">
                    <span class="sentinel-spinner-ring"></span>
                    <span>Loading more streams...</span>
                </div>
                <p id="sentinel-end" style="display:none"></p>
            </div>
        </div>`;

    const browseView = contentEl.querySelector('#browse-view');

    // Language selector
    await populateLanguageSelector();
    const langSel = document.getElementById('languageSelector');
    const catSel = document.getElementById('categorySelector');

    const onLanguageChange = () => {
        currentLanguage = langSel.value;
        currentCategory = '';
        catSel.value = '';
        void loadInitialPages(currentLanguage, contentEl, browseView);
    };
    langSel.addEventListener('change', onLanguageChange);

    const onCategoryChange = () => {
        currentCategory = catSel.value;
        void loadInitialPages(currentLanguage, contentEl, browseView);
    };
    catSel.addEventListener('change', onCategoryChange);

    // View toggle
    const onViewToggle = (e) => {
        const btn = e.target.closest('.view-toggle-btn');
        if (!btn) return;
        const mode = btn.dataset.view;
        preferences.viewMode = mode;
        localStorage.setItem('kick-api-preferences', JSON.stringify(preferences));
        contentEl.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
        rebuildAndRender(contentEl);
    };
    browseView.querySelector('.view-toggle')?.addEventListener('click', onViewToggle);

    // Sort pills
    const onSortPill = (e) => {
        const pill = e.target.closest('.sort-pill');
        if (!pill) return;
        const col = pill.dataset.sort;
        const type = pill.dataset.type;

        if (featuredSortState.column === col) {
            featuredSortState.direction = featuredSortState.direction === 'asc' ? 'desc' : 'asc';
        } else {
            featuredSortState.column = col;
            featuredSortState.direction = 'desc';
        }

        // Update pill states
        contentEl.querySelectorAll('.sort-pill').forEach(p => {
            p.classList.remove('active', 'asc', 'desc');
        });
        pill.classList.add('active', featuredSortState.direction);

        if (currentCategory && col === 'viewer_count') {
            void loadInitialPages(currentLanguage, contentEl, browseView);
        } else {
            rebuildAndRender(contentEl);
        }
    };
    browseView.querySelector('.sort-pills')?.addEventListener('click', onSortPill);

    // Hover/focus pause
    const onMouseEnter = () => { isHovered = true; };
    const onMouseLeave = () => { isHovered = false; };
    browseView.addEventListener('mouseenter', onMouseEnter);
    browseView.addEventListener('mouseleave', onMouseLeave);

    // Visibility change
    const onVisibility = () => {
        if (document.visibilityState === 'visible' && !refreshInFlight) {
            void backgroundRefresh(currentLanguage, contentEl);
        }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Load initial data
    void loadInitialPages(currentLanguage, contentEl, browseView);

    // Auto refresh
    refreshTimer = setInterval(() => {
        void backgroundRefresh(currentLanguage, contentEl);
    }, REFRESH_INTERVAL_MS);

    // Return cleanup function
    return () => {
        clearInterval(refreshTimer);
        refreshTimer = null;
        if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
        langSel.removeEventListener('change', onLanguageChange);
        catSel.removeEventListener('change', onCategoryChange);
        browseView.removeEventListener('mouseenter', onMouseEnter);
        browseView.removeEventListener('mouseleave', onMouseLeave);
        document.removeEventListener('visibilitychange', onVisibility);
    };
}
