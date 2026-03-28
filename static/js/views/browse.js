/**
 * Browse view — Featured streams with card grid, filters, infinite scroll, auto-refresh.
 */

import { fetchFeaturedStreams, fetchBatchViewerCounts } from '../api.js';
import { renderStreamGrid, renderCardSkeleton, updateFavoritesBadge, patchStreamGrid } from '../ui.js';
import { appState, featuredSortState, preferences } from '../state.js';
import { applyFeaturedStreamsSort } from '../sorting.js';
import { toast } from '../toast.js';

const REFRESH_INTERVAL_MS = 120_000;
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
let midCycleTimer = null;
let uptimeTimer = null;
let scrollObserver = null;
// (hover/focus pause removed — was too aggressive, blocked all viewer count updates)

function isPaused() {
    return document.visibilityState !== 'visible';
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

async function loadInitialPages(language, contentEl, browseView, forceClear = false) {
    if (forceClear) {
        pageCache.clear();
        pageMetaCache.clear();
        loadedPageCount = 0;
        rebuildAndRender(contentEl, { renderMode: 'full' }); // Render skeleton immediately
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
        syncLoadedRange();
        // Patch in-place when returning to browse with cached content already on screen
        rebuildAndRender(contentEl, { renderMode: hadCachedData ? 'refresh' : 'full' });
    } catch (err) {
        console.error('Error loading featured streams:', err);
        toast('Failed to load featured streams.', 'error', {
            action: { label: 'Retry', onClick: () => loadInitialPages(language, contentEl, browseView) }
        });
    } finally {
        if (generation === refreshGeneration) refreshInFlight = false;
        if (inlineSpinner) inlineSpinner.classList.remove('is-active');
        browseView?.classList.remove('browse-bootstrapping');
        // Init observer AFTER refreshInFlight is cleared so the callback isn't blocked
        if (generation === refreshGeneration && hasNextPage) {
            initScrollObserver(contentEl);
            prefetchNextPage();
        }
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

        // Patch DOM — update viewer badges and uptime on visible cards
        const gridEl = contentEl?.querySelector('.stream-grid');
        if (!gridEl) return;
        const slugMap = new Map(streams.map(s => [s.channel?.slug || s.slug, s]));
        gridEl.querySelectorAll('.stream-card[data-slug]').forEach(card => {
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
                if (badge) {
                    const dot = badge.querySelector('.card-live-dot');
                    const uptime = _formatUptime(startTime);
                    const dotHTML = dot ? dot.outerHTML : '<span class="card-live-dot"></span>';
                    const desired = dotHTML + (uptime || 'LIVE');
                    if (badge.innerHTML !== desired) badge.innerHTML = desired;
                }
            }
        });
    } catch (err) {
        // Silent — mid-cycle refresh is non-critical
    }
}

function _formatUptime(startTime) {
    if (!startTime) return '';
    try {
        const start = new Date(startTime.replace(' ', 'T') + 'Z');
        const diffMs = Date.now() - start.getTime();
        if (diffMs < 0) return '';
        const mins = Math.floor(diffMs / 60000);
        if (mins < 60) return `${mins}m`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${h}h ${m}m`;
    } catch { return ''; }
}

function _animateCount(numEl, from, to) {
    if (numEl._animFrame) cancelAnimationFrame(numEl._animFrame);
    const duration = 600;
    const start = performance.now();
    const diff = to - from;
    function fmt(n) {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
        return n.toLocaleString('en-US');
    }
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
        syncLoadedRange();
        rebuildAndRender(contentEl, { renderMode: 'append' });

        // Immediately prefetch the page after this one
        prefetchNextPage();
    } catch (err) {
        console.error('Error loading next page:', err);
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
    contentEl.innerHTML = `
        <div id="browse-view">
            <div class="browse-sticky-header">
                <div class="section-header">
                    <h1 class="section-title">Featured Streams <span id="stream-count" class="section-count">${pageCache.size > 0 ? `(${mergePagesIntoStreams().length})` : ''}</span></h1>
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
            </div>

            <div id="browse-grid">
                ${pageCache.size > 0
                    ? renderStreamGrid(applyFeaturedStreamsSort(mergePagesIntoStreams(), featuredSortState), preferences.viewMode)
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

    // Language selector
    await populateLanguageSelector();
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
        contentEl.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.view === mode));
        rebuildAndRender(contentEl);
    };
    const viewToggleEl = browseView.querySelector('.view-toggle');
    viewToggleEl?.addEventListener('click', onViewToggle);

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
            void loadInitialPages(currentLanguage, contentEl, browseView, true);
        } else {
            rebuildAndRender(contentEl);
        }
    };
    const sortPillsEl = browseView.querySelector('.sort-pills');
    sortPillsEl?.addEventListener('click', onSortPill);

    // (hover/focus pause removed — viewer counts update regardless)

    // Visibility change
    const onVisibility = () => {
        if (document.visibilityState === 'visible' && !refreshInFlight) {
            void backgroundRefresh(currentLanguage, contentEl);
        }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Load initial data
    void loadInitialPages(currentLanguage, contentEl, browseView);

    // Auto refresh — full data every 120s, lightweight viewer counts at 60s midpoint
    refreshTimer = setInterval(() => {
        void backgroundRefresh(currentLanguage, contentEl);
    }, REFRESH_INTERVAL_MS);
    midCycleTimer = setInterval(() => {
        void midCycleViewerRefresh(contentEl);
    }, REFRESH_INTERVAL_MS / 2);
    // Client-side uptime recalculation — zero API calls, just recalculates from start_time
    uptimeTimer = setInterval(() => {
        requestAnimationFrame(() => {
            contentEl.querySelectorAll('.stream-card[data-start-time]').forEach(card => {
                const startTime = card.dataset.startTime;
                if (!startTime) return;
                const badge = card.querySelector('.card-uptime-badge');
                if (!badge) return;
                const dot = badge.querySelector('.card-live-dot');
                const uptime = _formatUptime(startTime);
                const dotHTML = dot ? dot.outerHTML : '<span class="card-live-dot"></span>';
                const desired = dotHTML + (uptime || 'LIVE');
                if (badge.innerHTML !== desired) badge.innerHTML = desired;
            });
        });
    }, 30_000);

    // Return cleanup function
    return () => {
        clearInterval(refreshTimer);
        refreshTimer = null;
        clearInterval(midCycleTimer);
        midCycleTimer = null;
        clearInterval(uptimeTimer);
        uptimeTimer = null;
        if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
        langSel.removeEventListener('change', onLanguageChange);
        catSel.removeEventListener('change', onCategoryChange);
        viewToggleEl?.removeEventListener('click', onViewToggle);
        sortPillsEl?.removeEventListener('click', onSortPill);
        document.removeEventListener('visibilitychange', onVisibility);
    };
}
