/**
 * Browse view — Featured streams with card grid, filters, infinite scroll, auto-refresh.
 */

import { fetchFeaturedStreams, fetchBatchViewerCounts } from '../api.js';
import { renderStreamGrid, renderCardSkeleton, updateFavoritesBadge, patchStreamGrid, syncCardUptimeBadge } from '../ui.js';
import { appState, featuredSortState, preferences } from '../state.js';
import { applyFeaturedStreamsSort } from '../sorting.js';
import { toast } from '../toast.js';
import { throttle } from '../utils.js';

const REFRESH_INTERVAL_MS = 120_000;
const DEFAULT_PAGE_SIZE = 14;
const RETAIN_RECENT_PAGE_COUNT = 5;
const GRID_CARD_MIN_WIDTH = 280;
const GRID_GAP_PX = 20;
const GRID_CARD_FALLBACK_HEIGHT = 250;
const LIST_ITEM_FALLBACK_HEIGHT = 92;
const LIST_GAP_PX = 10;

// Module state (persists across route changes via closure)
let currentLanguage = null;
let currentCategory = '';
let pageCache = new Map();
let pageMetaCache = new Map();
let loadedPageCount = 0;
let hasNextPage = true;
let evictedStreamCount = 0;
let pageHeightEstimate = 0;
let refreshGeneration = 0;
let activeGeneration = 0;
let refreshInFlight = false;
let scrollLoadInFlight = false;
let prefetchInFlightPages = new Map();

// Active timers/observers (cleaned up on unmount)
let refreshTimer = null;
let midCycleTimer = null;
let uptimeTimer = null;
let scrollObserver = null;
let cardVisibilityObserver = null;
let observedStreamCards = new WeakSet();
let visibleStreamCards = new Set();
// (hover/focus pause removed — was too aggressive, blocked all viewer count updates)

function isPaused() {
    return document.visibilityState !== 'visible';
}

function shouldTrackVisibleStreamCards() {
    return document.documentElement.classList.contains('safari');
}

function resetVisibleStreamCardTracking() {
    visibleStreamCards.clear();
    observedStreamCards = new WeakSet();
    if (cardVisibilityObserver) {
        cardVisibilityObserver.disconnect();
        cardVisibilityObserver = null;
    }
}

function observeVisibleStreamCards(gridEl) {
    if (!shouldTrackVisibleStreamCards() || !gridEl) return;
    if (!gridEl.querySelector('.stream-card[data-slug]')) return;

    const scrollRoot = document.getElementById('content-area');
    if (!scrollRoot) return;

    if (!cardVisibilityObserver) {
        cardVisibilityObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const card = entry.target;
                if (entry.isIntersecting) {
                    visibleStreamCards.add(card);
                } else {
                    visibleStreamCards.delete(card);
                }
            });
        }, {
            root: scrollRoot,
            rootMargin: '280px 0px',
            threshold: 0,
        });
    }

    gridEl.querySelectorAll('.stream-card[data-slug]').forEach(card => {
        if (observedStreamCards.has(card)) return;
        observedStreamCards.add(card);
        cardVisibilityObserver.observe(card);
    });
}

function getRefreshCards(gridEl) {
    if (!shouldTrackVisibleStreamCards() || !gridEl) {
        return [...(gridEl?.querySelectorAll('.stream-card[data-slug]') || [])];
    }

    const tracked = [];
    for (const card of visibleStreamCards) {
        if (!card.isConnected || !gridEl.contains(card)) {
            visibleStreamCards.delete(card);
            continue;
        }
        tracked.push(card);
    }

    if (tracked.length > 0) return tracked;
    return [...gridEl.querySelectorAll('.stream-card[data-slug]')];
}

function hasFreshCache() {
    return activeGeneration === refreshGeneration;
}

function getRenderablePageNumbers() {
    return [...pageCache.keys()]
        .filter(page => page >= 1 && page <= loadedPageCount)
        .sort((a, b) => a - b);
}

function mergePagesIntoStreams() {
    const seen = new Set();
    const merged = [];
    for (const page of getRenderablePageNumbers()) {
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

function countMergedPages(pageNumbers) {
    const seen = new Set();
    let count = 0;
    pageNumbers.forEach(page => {
        const streams = pageCache.get(page) || [];
        streams.forEach(stream => {
            const slug = stream.channel?.slug || stream.slug || '';
            if (!slug || seen.has(slug)) return;
            seen.add(slug);
            count++;
        });
    });
    return count;
}

// Page windowing is disabled. It evicted middle pages from the cache and
// reserved their height with a spacer, but nothing re-fetched/re-rendered them
// on scroll-back — so the spacer became a permanent empty void mid-grid (the
// reported "strange gap"). At this scale (≤~130 cards) a full DOM is fine, so
// every loaded page stays rendered and no spacer is inserted. Returning 0 makes
// getWindowRenderOptions() yield {} (no spacer) and updateStreamWindowSpacer()
// remove any stale spacer (its height<=0 path).
function hiddenMiddlePageCount() {
    return 0;
}

function fallbackPageHeight() {
    if (preferences.viewMode === 'list') {
        return (DEFAULT_PAGE_SIZE * LIST_ITEM_FALLBACK_HEIGHT) + ((DEFAULT_PAGE_SIZE - 1) * LIST_GAP_PX);
    }
    const contentWidth = document.getElementById('content-area')?.clientWidth || window.innerWidth || 1024;
    const columns = Math.max(1, Math.floor((contentWidth + GRID_GAP_PX) / (GRID_CARD_MIN_WIDTH + GRID_GAP_PX)));
    const rows = Math.ceil(DEFAULT_PAGE_SIZE / columns);
    return (rows * GRID_CARD_FALLBACK_HEIGHT) + ((rows - 1) * GRID_GAP_PX);
}

function getWindowRenderOptions() {
    const hiddenPages = hiddenMiddlePageCount();
    if (hiddenPages === 0) return {};
    return {
        windowSpacerAfter: pageCache.has(1) ? countMergedPages([1]) : 0,
        windowSpacerHeight: hiddenPages * (pageHeightEstimate || fallbackPageHeight()),
    };
}

function updatePageHeightEstimate(contentEl) {
    const hiddenPages = hiddenMiddlePageCount();
    const spacer = contentEl?.querySelector('.stream-window-spacer');
    let estimate = 0;

    if (preferences.viewMode === 'list') {
        const list = contentEl?.querySelector('.stream-list');
        const row = list?.querySelector('.stream-list-item');
        if (list && row) {
            const styles = getComputedStyle(list);
            const gap = parseFloat(styles.rowGap || styles.gap || '0') || LIST_GAP_PX;
            const rowHeight = row.getBoundingClientRect().height || LIST_ITEM_FALLBACK_HEIGHT;
            estimate = (DEFAULT_PAGE_SIZE * rowHeight) + ((DEFAULT_PAGE_SIZE - 1) * gap);
        }
    } else {
        const grid = contentEl?.querySelector('.stream-grid');
        const card = grid?.querySelector('.stream-card');
        if (grid && card) {
            const styles = getComputedStyle(grid);
            const columns = styles.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
            const gap = parseFloat(styles.rowGap || styles.gap || '0') || GRID_GAP_PX;
            const cardHeight = card.getBoundingClientRect().height || GRID_CARD_FALLBACK_HEIGHT;
            const rows = Math.ceil(DEFAULT_PAGE_SIZE / columns);
            estimate = (rows * cardHeight) + ((rows - 1) * gap);
        }
    }

    if (estimate > 0) pageHeightEstimate = estimate;
    if (spacer && hiddenPages > 0) {
        spacer.style.height = `${Math.round(hiddenPages * (pageHeightEstimate || fallbackPageHeight()))}px`;
    }
}

function prunePageWindow() {
    // No-op: windowing disabled (see hiddenMiddlePageCount). Keeping every loaded
    // page in the cache means they all render contiguously — no eviction, no
    // spacer, no void. Eviction without scroll-back re-fetch was the bug.
}

function getDisplayedStreamCount() {
    const retainedCount = appState.featuredStreams?.length || mergePagesIntoStreams().length;
    return evictedStreamCount + retainedCount;
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
    metaCache.set(result.page, {
        hasNext: result.hasNext,
        perPage: result.perPage,
        streamCount: result.streams.length,
    });
}

function sortPillAriaLabel(label, isActive, direction) {
    if (label === 'Featured') return isActive ? 'Featured order selected' : 'Use Featured order';
    if (!isActive) return `Sort by ${label}`;
    return `Sort by ${label}, ${direction === 'asc' ? 'ascending' : 'descending'}`;
}

function rebuildAndRender(contentEl, { renderMode = 'full' } = {}) {
    // Loading state: after a filter/language change the page cache is cleared,
    // so rendering the merged (empty) stream list would flash the "No streams
    // found" empty state during the fetch — contradicting the action the user
    // just took. Render a skeleton grid instead until real data arrives.
    if (renderMode === 'skeleton') {
        const gridContainer = contentEl?.querySelector('#browse-grid');
        if (gridContainer) {
            gridContainer.innerHTML = `<div class="stream-grid">${renderCardSkeleton(8)}</div>`;
        }
        const countEl = contentEl?.querySelector('#stream-count');
        if (countEl) countEl.textContent = '';
        const sentinel = contentEl?.querySelector('#scroll-sentinel');
        if (sentinel) sentinel.style.display = 'none';
        return;
    }

    const merged = mergePagesIntoStreams();
    appState.featuredStreams = applyFeaturedStreamsSort(merged, featuredSortState);
    appState.searchPool = [...appState.featuredStreams];

    // Update category selector options
    populateCategorySelector(appState.featuredStreams);

    const shouldResetTracking = renderMode === 'full' || preferences.viewMode === 'list';
    if (shouldResetTracking) {
        resetVisibleStreamCardTracking();
    }

    // Render grid
    const gridContainer = contentEl?.querySelector('#browse-grid');
    if (gridContainer) {
        const renderOptions = getWindowRenderOptions();
        if (renderMode === 'full') {
            gridContainer.innerHTML = renderStreamGrid(appState.featuredStreams, preferences.viewMode, renderOptions);
        } else {
            patchStreamGrid(gridContainer, appState.featuredStreams, preferences.viewMode, renderOptions);
        }
        updatePageHeightEstimate(contentEl);
        observeVisibleStreamCards(gridContainer);
    }

    // Update count
    const countEl = contentEl?.querySelector('#stream-count');
    if (countEl) {
        const count = getDisplayedStreamCount();
        countEl.textContent = count > 0 ? `(${count})` : '';
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
            endMsg.textContent = `All ${getDisplayedStreamCount()} streams loaded`;
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

async function loadInitialPages(language, contentEl, browseView, forceClear = false) {
    if (forceClear) {
        pageCache.clear();
        pageMetaCache.clear();
        loadedPageCount = 0;
        hasNextPage = true;
        evictedStreamCount = 0;
        pageHeightEstimate = 0;
        rebuildAndRender(contentEl, { renderMode: 'skeleton' }); // Show skeleton during the fetch
    }

    const generation = ++refreshGeneration;
    refreshInFlight = true;
    const hadCachedData = pageCache.size > 0;
    browseView?.classList.add('browse-bootstrapping'); // Keep browse renders static to avoid the initial flash.

    // Show spinner
    const inlineSpinner = contentEl?.querySelector('#featured-spinner');
    if (inlineSpinner) inlineSpinner.classList.add('is-active');

    try {
        const result = await fetchPageData(language, 1, generation);
        if (generation !== refreshGeneration) return;

        applyPageResult(pageCache, pageMetaCache, result);

        activeGeneration = refreshGeneration;
        if (loadedPageCount === 0) loadedPageCount = 1;
        if (loadedPageCount === 1) {
            hasNextPage = Boolean(result?.hasNext);
        } else {
            const meta = pageMetaCache.get(loadedPageCount);
            if (meta) hasNextPage = Boolean(meta.hasNext);
        }
        prunePageWindow();
        // Patch in-place when returning to browse with cached content already on screen
        rebuildAndRender(contentEl, { renderMode: hadCachedData ? 'refresh' : 'full' });
    } catch (err) {
        console.error('Error loading featured streams:', err);
        if (generation === refreshGeneration) {
            toast('Failed to load featured streams.', 'error', {
                action: { label: 'Retry', onClick: () => loadInitialPages(language, contentEl, browseView) }
            });
        }
    } finally {
        // Always clear the flag — even for stale generations.  A newer generation
        // will have set its own flag; if we are the latest, we must clear it.
        if (generation === refreshGeneration) {
            refreshInFlight = false;
            if (hasNextPage) { initScrollObserver(contentEl); prefetchNextPage(); }
        }
        if (inlineSpinner) inlineSpinner.classList.remove('is-active');
        browseView?.classList.remove('browse-bootstrapping');
    }
}

async function backgroundRefresh(language, contentEl) {
    if (isPaused() || refreshInFlight) return;
    const generation = ++refreshGeneration;
    refreshInFlight = true;

    // No spinner: the auto-refresh is silent and patches in place (with FLIP
    // for any reordering), so it should be invisible until cards actually move.
    try {
        const result = await fetchPageData(language, 1, generation);
        if (generation !== refreshGeneration) return;
        applyPageResult(pageCache, pageMetaCache, result);
        prunePageWindow();
        activeGeneration = refreshGeneration;
        rebuildAndRender(contentEl, { renderMode: 'refresh' });
    } catch (err) {
        console.error('Background refresh error:', err);
    } finally {
        if (generation === refreshGeneration) refreshInFlight = false;
    }
    // (Previously: setTimeout(() => { refreshInFlight = false; }, 15000).
    // That unconditional clear was a latent bug — if a *newer* refresh was
    // in flight 15 s later, the stale setTimeout would clear ITS flag and
    // allow a third concurrent refresh to fire. The finally-block clear
    // above is sufficient because every refresh path (loadInitialPages,
    // backgroundRefresh, loadMorePages) sets the flag at entry and clears
    // it in its own finally when its generation is the latest.)
}

async function midCycleViewerRefresh(contentEl) {
    if (isPaused() || refreshInFlight) return;

    // Collect livestream IDs from page 1 cached streams
    const streams = pageCache.get(1);
    if (!streams || streams.length === 0) return;

    const idMap = new Map(); // livestream_id → stream index
    streams.forEach((s, i) => {
        const id = s.id || s.livestream_id;
        if (id) idMap.set(String(id), i);
    });
    if (idMap.size === 0) return;

    try {
        const counts = await fetchBatchViewerCounts([...idMap.keys()]);
        if (!counts || Object.keys(counts).length === 0) return;

        // Update cached stream data
        for (const [idStr, viewers] of Object.entries(counts)) {
            const idx = idMap.get(idStr);
            if (idx !== undefined && streams[idx]) {
                streams[idx].viewer_count = viewers;
            }
        }

        // When sorted by viewers, re-sort now so the order tracks the fresh
        // numbers and cards glide to their new spots (FLIP), instead of staying
        // stale until the next full refresh and then lurching. patchStreamGrid
        // also animates the counts, so this fully replaces the in-place update.
        if (featuredSortState.column === 'viewer_count') {
            rebuildAndRender(contentEl, { renderMode: 'refresh' });
            return;
        }

        // Otherwise the order is unaffected — just animate the counts in place.
        const gridEl = contentEl?.querySelector('.stream-grid');
        if (!gridEl) return;
        const slugMap = new Map(streams.map(s => [s.channel?.slug || s.slug, s]));
        getRefreshCards(gridEl).forEach(card => {
            const stream = slugMap.get(card.dataset.slug);
            if (!stream) return;

            // Viewer count
            const viewerEl = card.querySelector('.card-viewers');
            if (viewerEl && stream.viewer_count != null) {
                const oldCount = parseInt(viewerEl.dataset.count || '0', 10);
                const newCount = stream.viewer_count;
                if (oldCount !== newCount) {
                    viewerEl.dataset.count = newCount;
                    // Trigger animation via the exported function from ui.js
                    // We fire a custom event that ui.js listens for — or inline the animation
                    const numEl = viewerEl.querySelector('.viewer-num');
                    if (numEl) {
                        _animateCount(numEl, oldCount, newCount);
                    }
                }
            }

            // Uptime — recalculate from start_time
            const startTime = card.dataset.startTime;
            if (startTime) {
                const badge = card.querySelector('.card-uptime-badge');
                if (badge) syncCardUptimeBadge(badge, startTime);
            }
        });
    } catch (err) {
        // Silent — mid-cycle refresh is non-critical
    }
}

function _animateCount(numEl, from, to) {
    if (numEl._animFrame) cancelAnimationFrame(numEl._animFrame);
    function fmt(n) {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
        return n.toLocaleString('en-US');
    }
    const shouldAnimate = !document.documentElement.classList.contains('safari')
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!shouldAnimate) {
        numEl.textContent = fmt(to);
        numEl._animFrame = null;
        return;
    }
    const duration = 600;
    const start = performance.now();
    const diff = to - from;
    function tick(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        numEl.textContent = fmt(Math.round(from + diff * eased));
        if (progress < 1) numEl._animFrame = requestAnimationFrame(tick);
        else numEl._animFrame = null;
    }
    numEl._animFrame = requestAnimationFrame(tick);
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
        loadedPageCount = nextPage;
        hasNextPage = Boolean(pageMetaCache.get(nextPage)?.hasNext);
        prunePageWindow();
        rebuildAndRender(contentEl, { renderMode: 'append' });

        // Immediately prefetch the page after this one
        prefetchNextPage();
    } catch (err) {
        console.error('Error loading next page:', err);
        // Don't leave a dead-end grid with a vanished spinner — offer a retry,
        // mirroring the initial-load failure path.
        toast('Couldn’t load more streams', 'error', {
            action: { label: 'Retry', onClick: () => { void loadNextScrollPage(contentEl); } },
        });
    } finally {
        scrollLoadInFlight = false;
        updateSentinel(contentEl);

        // Re-observe sentinel after layout recomputes so the observer fires again
        // if sentinel is still within rootMargin (common at wide resolutions)
        if (hasNextPage && scrollObserver) {
            const sentinel = contentEl?.querySelector('#scroll-sentinel');
            if (sentinel) {
                requestAnimationFrame(() => {
                    if (!scrollObserver || !hasNextPage) return;
                    scrollObserver.unobserve(sentinel);
                    scrollObserver.observe(sentinel);
                });
            }
        }
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
        // Use cached config from init (fetched once in script.js) — avoids repeated /config/languages calls
        let config = appState.languagesConfig;
        if (!config) {
            const res = await fetch('/config/languages');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            config = await res.json();
            appState.languagesConfig = config;
        }
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
    // Apply default sort from preferences BEFORE initial render
    if (preferences.defaultSort?.column && !featuredSortState.column) {
        featuredSortState.column = preferences.defaultSort.column;
        featuredSortState.direction = preferences.defaultSort.direction || 'desc';
    }

    const initialStreams = applyFeaturedStreamsSort(mergePagesIntoStreams(), featuredSortState);
    const initialCount = evictedStreamCount + initialStreams.length;
    const initialRenderOptions = getWindowRenderOptions();

    contentEl.innerHTML = `
        <div id="browse-view">
            <div class="browse-sticky-header">
                <div class="section-header">
                    <h1 class="section-title">Live Streams <span id="stream-count" class="section-count">${initialCount > 0 ? `(${initialCount})` : ''}</span></h1>
                    <span id="featured-spinner" class="inline-spinner" aria-hidden="true"></span>
                    <button id="filter-toggle" class="filter-toggle" aria-label="Toggle filters" aria-expanded="true">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                </div>

                <div class="filter-bar">
                <select id="languageSelector" class="filter-select" aria-label="Language"></select>
                <select id="categorySelector" class="filter-select" aria-label="Category">
                    <option value="">All Categories</option>
                </select>

                <div class="sort-pills" role="group" aria-label="Sort streams">
                    ${[
                        { col: '', label: 'Featured', type: 'featured' },
                        { col: 'viewer_count', label: 'Viewers', type: 'number' },
                        { col: 'session_title', label: 'Title', type: 'string' },
                        { col: 'channel.user.username', label: 'Channel', type: 'string' },
                    ].map(({ col, label, type }) => {
                        const isActive = col ? featuredSortState.column === col : !featuredSortState.column;
                        const cls = isActive && col ? `sort-pill active ${featuredSortState.direction}` : isActive ? 'sort-pill active' : 'sort-pill';
                        return `<button class="${cls}" data-sort="${col}" data-type="${type}" aria-pressed="${isActive}" aria-label="${sortPillAriaLabel(label, isActive, featuredSortState.direction)}">${label}</button>`;
                    }).join('')}
                </div>

                <div class="view-toggle" role="group" aria-label="View mode">
                    <button class="view-toggle-btn ${preferences.viewMode === 'grid' ? 'active' : ''}" data-view="grid" title="Grid view" aria-label="Grid view" aria-pressed="${preferences.viewMode === 'grid'}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                    </button>
                    <button class="view-toggle-btn ${preferences.viewMode === 'list' ? 'active' : ''}" data-view="list" title="List view" aria-label="List view" aria-pressed="${preferences.viewMode === 'list'}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                    </button>
                </div>
            </div>
            </div>

            <div id="browse-grid">
                ${pageCache.size > 0
                    ? renderStreamGrid(initialStreams, preferences.viewMode, initialRenderOptions)
                    : `<div class="stream-grid">${renderCardSkeleton(8)}</div>`}
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

    // Language selector — populate dropdown and pre-resolve language in parallel
    // so loadInitialPages below can start immediately instead of waiting for
    // /config/languages and a DOM build that doesn't gate the network fetch.
    const probableLanguage = preferences.language
        || appState.languagesConfig?.default_language
        || 'tr';
    if (!currentLanguage) currentLanguage = probableLanguage;
    const populatePromise = populateLanguageSelector();
    const langSel = document.getElementById('languageSelector');
    const catSel = document.getElementById('categorySelector');

    const onLanguageChange = () => {
        currentLanguage = langSel.value;
        currentCategory = '';
        catSel.value = '';
        void loadInitialPages(currentLanguage, contentEl, browseView, true);
    };
    langSel.addEventListener('change', onLanguageChange);

    const onCategoryChange = () => {
        currentCategory = catSel.value;
        void loadInitialPages(currentLanguage, contentEl, browseView, true);
    };
    catSel.addEventListener('change', onCategoryChange);

    // View toggle
    const onViewToggle = (e) => {
        const btn = e.target.closest('.view-toggle-btn');
        if (!btn) return;
        const mode = btn.dataset.view;
        preferences.viewMode = mode;
        localStorage.setItem('kick-api-preferences', JSON.stringify(preferences));
        contentEl.querySelectorAll('.view-toggle-btn').forEach(b => {
            const isActive = b.dataset.view === mode;
            b.classList.toggle('active', isActive);
            b.setAttribute('aria-pressed', String(isActive));
        });
        rebuildAndRender(contentEl);
    };
    const viewToggleEl = browseView.querySelector('.view-toggle');
    viewToggleEl?.addEventListener('click', onViewToggle);

    // Sort pills
    const onSortPill = (e) => {
        const pill = e.target.closest('.sort-pill');
        if (!pill) return;
        const col = pill.dataset.sort || null;

        if (!col) {
            featuredSortState.column = null;
            featuredSortState.direction = 'desc';
        } else if (featuredSortState.column === col) {
            featuredSortState.direction = featuredSortState.direction === 'asc' ? 'desc' : 'asc';
        } else {
            featuredSortState.column = col;
            featuredSortState.direction = 'desc';
        }

        // Update pill states
        contentEl.querySelectorAll('.sort-pill').forEach(p => {
            p.classList.remove('active', 'asc', 'desc');
            p.setAttribute('aria-pressed', 'false');
            const plabel = !p.dataset.sort ? 'Featured' : p.dataset.sort === 'viewer_count' ? 'Viewers' : p.dataset.sort === 'session_title' ? 'Title' : 'Channel';
            p.setAttribute('aria-label', sortPillAriaLabel(plabel, false, featuredSortState.direction));
        });
        pill.classList.add('active');
        if (col) pill.classList.add(featuredSortState.direction);
        pill.setAttribute('aria-pressed', 'true');
        const activeLabel = !col ? 'Featured' : col === 'viewer_count' ? 'Viewers' : col === 'session_title' ? 'Title' : 'Channel';
        pill.setAttribute('aria-label', sortPillAriaLabel(activeLabel, true, featuredSortState.direction));

        if (currentCategory && col === 'viewer_count') {
            void loadInitialPages(currentLanguage, contentEl, browseView, true);
        } else {
            // Patch + FLIP so cards glide to their new sorted positions instead
            // of the whole grid rebuilding (which replayed the entrance cascade).
            rebuildAndRender(contentEl, { renderMode: 'refresh' });
        }
    };
    const sortPillsEl = browseView.querySelector('.sort-pills');
    sortPillsEl?.addEventListener('click', onSortPill);

    // Filter toggle (mobile: collapse/expand the filter bar)
    const filterToggle = document.getElementById('filter-toggle');
    const filterBarEl = browseView.querySelector('.filter-bar');
    if (filterToggle && filterBarEl) {
        if (preferences.filtersCollapsed) {
            filterBarEl.classList.add('collapsed');
            filterToggle.setAttribute('aria-expanded', 'false');
        }
        filterToggle.addEventListener('click', () => {
            const collapsed = filterBarEl.classList.toggle('collapsed');
            filterToggle.setAttribute('aria-expanded', String(!collapsed));
            preferences.filtersCollapsed = collapsed;
            try { localStorage.setItem('kick-api-preferences', JSON.stringify(preferences)); } catch {}
        });
    }

    // Visibility change — debounced to avoid iPhone notification/control-center spam
    let lastVisibilityRefresh = 0;
    const onVisibility = () => {
        if (document.visibilityState !== 'visible' || refreshInFlight) return;
        const now = Date.now();
        if (now - lastVisibilityRefresh < 5000) return; // 5s debounce
        lastVisibilityRefresh = now;
        void backgroundRefresh(currentLanguage, contentEl);
    };
    document.addEventListener('visibilitychange', onVisibility);

    // ── Hide-on-scroll (mobile only) ──────────────────────────────────────
    const scrollEl = document.getElementById('content-area');
    const mq = window.matchMedia('(max-width: 767px)');
    // Hysteresis: accumulate distance in the current scroll direction and only
    // toggle once it passes a threshold, resetting the opposite accumulator on
    // each direction change. This way momentum settle and finger jitter (a few
    // px) can't flip the header — reveal needs a deliberate upward scroll and is
    // intentionally less eager than hide.
    let lastTop = 0;
    let accUp = 0;
    let accDown = 0;
    const ENGAGE_AFTER = 80;   // always show near the top of the list
    const HIDE_DELTA = 20;     // hide after a clear downward scroll
    const REVEAL_DELTA = 50;   // reveal only after a deliberate upward scroll

    const onScroll = throttle(() => {
        if (!mq.matches) return;
        const top = scrollEl.scrollTop;
        const dy = top - lastTop;
        lastTop = top;

        if (top < ENGAGE_AFTER) {
            document.body.classList.remove('browse-headers-hidden');
            accUp = accDown = 0;
            return;
        }
        if (dy > 0) {                 // scrolling down
            accDown += dy;
            accUp = 0;
            if (accDown > HIDE_DELTA) document.body.classList.add('browse-headers-hidden');
        } else if (dy < 0) {          // scrolling up
            accUp -= dy;              // dy < 0 → adds its magnitude
            accDown = 0;
            if (accUp > REVEAL_DELTA) document.body.classList.remove('browse-headers-hidden');
        }
    }, 80);

    scrollEl.addEventListener('scroll', onScroll, { passive: true });

    const onMqChange = () => {
        if (!mq.matches) document.body.classList.remove('browse-headers-hidden');
    };
    mq.addEventListener('change', onMqChange);

    // Load initial data in parallel with language-selector population.
    // The featured fetch is the slow part (~1.5s cold on Pi); waiting for
    // the dropdown to render adds 50-200ms of pointless serial delay.
    const loadPromise = loadInitialPages(currentLanguage, contentEl, browseView);

    // Refresh-timer management — start/stop based on current preference, so
    // toggling auto-refresh in Settings takes effect without a remount.
    function startRefreshTimers() {
        stopRefreshTimers(); // ensure no doubles
        if (preferences.autoRefresh === false) return;
        const intervalMs = (preferences.autoRefreshInterval || 120) * 1000;
        refreshTimer = setInterval(() => {
            void backgroundRefresh(currentLanguage, contentEl);
        }, intervalMs);
        midCycleTimer = setInterval(() => {
            void midCycleViewerRefresh(contentEl);
        }, intervalMs / 2);
    }
    function stopRefreshTimers() {
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
        if (midCycleTimer) { clearInterval(midCycleTimer); midCycleTimer = null; }
    }
    function onPreferencesChanged(e) {
        const key = e?.detail?.key;
        if (key === 'autoRefresh' || key === 'autoRefreshInterval') {
            startRefreshTimers(); // restarts with new preference value
        }
    }
    window.addEventListener('preferences-changed', onPreferencesChanged);

    // Wait for both to complete before starting auto-refresh timers
    Promise.all([populatePromise, loadPromise]).then(() => {
        startRefreshTimers();
        uptimeTimer = setInterval(() => {
            if (document.visibilityState !== 'visible') return;
            requestAnimationFrame(() => {
                const gridEl = contentEl?.querySelector('.stream-grid');
                if (!gridEl) return;
                getRefreshCards(gridEl).forEach(card => {
                    const startTime = card.dataset.startTime;
                    if (!startTime) return;
                    const badge = card.querySelector('.card-uptime-badge');
                    if (!badge) return;
                    syncCardUptimeBadge(badge, startTime);
                });
            });
        }, 30_000);
    });

    // Return cleanup function
    return () => {
        stopRefreshTimers();
        clearInterval(uptimeTimer);
        uptimeTimer = null;
        if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
        resetVisibleStreamCardTracking();
        langSel.removeEventListener('change', onLanguageChange);
        catSel.removeEventListener('change', onCategoryChange);
        viewToggleEl?.removeEventListener('click', onViewToggle);
        sortPillsEl?.removeEventListener('click', onSortPill);
        document.removeEventListener('visibilitychange', onVisibility);
        scrollEl?.removeEventListener('scroll', onScroll);
        mq.removeEventListener('change', onMqChange);
        window.removeEventListener('preferences-changed', onPreferencesChanged);
        document.body.classList.remove('browse-headers-hidden');
    };
}
