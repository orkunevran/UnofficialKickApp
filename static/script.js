import { fetchFeaturedStreams, fetchChannelData, fetchSearchResults, fetchChannelSearch, fetchChannelAvatar, fetchViewerCount } from './js/api.js';
import { showMessage, clearPreviousData, renderLiveStreamInfo, renderVodsInfo, renderClipsInfo, renderFeaturedStreamsTable, renderSearchResults, showLoadingIndicator, hideLoadingIndicator, addSortEventListeners, initButtonDelegation } from './js/ui.js';
import { appState, featuredSortState } from './js/state.js';
import { initializeChromecast } from './js/chromecast.js';
import { applyFeaturedStreamsSort } from './js/sorting.js';

// Viewer count auto-refresh timer
let viewerRefreshTimer = null;

let featuredTableRefreshTimer = null;
let currentFeaturedLanguage = null;
let featuredRefreshInFlight = false;
let featuredNetworkActivityCount = 0;
let queuedFeaturedRefresh = null;
let deferredFeaturedRefresh = null;
let isFeaturedHovered = false;
let isFeaturedFocusWithin = false;
let featuredPageCache = new Map();
let featuredPageMetaCache = new Map();
let featuredLoadedPageCount = 0;
let featuredCurrentPage = 1;
let featuredPageSize = 14;
let featuredHasNextPage = true;
let featuredActiveGeneration = 0;
let featuredRefreshGeneration = 0;
let featuredPageNavigationInFlight = false;
let featuredPrefetchInFlightPages = new Map();
// '' = featured mode; non-empty slug = server-side filtered category mode
let currentCategoryFilter = '';

const FEATURED_TABLE_REFRESH_INTERVAL_MS = 90_000;
const FEATURED_DEFAULT_PAGE_SIZE = 14;
const FEATURED_INITIAL_PAGES = [1, 2, 3];
const FEATURED_LOOKAHEAD_PAGES = 2;

function getFeaturedRefreshLanguage(language = null) {
    return language || currentFeaturedLanguage || document.getElementById('languageSelector')?.value || 'en';
}

function isFeaturedRefreshPaused() {
    return document.visibilityState !== 'visible' || isFeaturedHovered || isFeaturedFocusWithin;
}

function setFeaturedUpdating(isActive) {
    const featuredSpinner = document.getElementById('featured-spinner');
    if (featuredSpinner) {
        featuredSpinner.classList.toggle('is-active', isActive);
    }
}

function beginFeaturedNetworkActivity() {
    featuredNetworkActivityCount += 1;
    setFeaturedUpdating(true);
}

function endFeaturedNetworkActivity() {
    featuredNetworkActivityCount = Math.max(0, featuredNetworkActivityCount - 1);
    setFeaturedUpdating(featuredNetworkActivityCount > 0);
}

function buildFeaturedPageRange(lastPage) {
    return Array.from({ length: lastPage }, (_, index) => index + 1);
}

function getContiguousFeaturedPageCount(pageCache) {
    let contiguousCount = 0;
    while (pageCache.has(contiguousCount + 1)) {
        contiguousCount += 1;
    }
    return contiguousCount;
}

function mergeFeaturedPageCache(pageCache, pageCount) {
    const seen = new Set();
    const mergedStreams = [];

    for (let page = 1; page <= pageCount; page += 1) {
        const streams = pageCache.get(page) || [];
        streams.forEach(stream => {
            const slug = stream.channel?.slug || stream.slug || '';
            if (!slug || seen.has(slug)) return;
            seen.add(slug);
            mergedStreams.push(stream);
        });
    }

    return mergedStreams;
}

function syncFeaturedLoadedRange() {
    featuredLoadedPageCount = getContiguousFeaturedPageCount(featuredPageCache);

    if (featuredLoadedPageCount === 0) {
        featuredHasNextPage = false;
        featuredPageSize = FEATURED_DEFAULT_PAGE_SIZE;
        return;
    }

    const pageMeta = featuredPageMetaCache.get(featuredLoadedPageCount);
    if (pageMeta?.perPage) {
        featuredPageSize = pageMeta.perPage;
    }
    featuredHasNextPage = Boolean(pageMeta?.hasNext);
}

function syncFeaturedSearchPool() {
    appState.searchPool = [...appState.featuredStreams];
}

function hasFreshFeaturedCache() {
    return featuredActiveGeneration === featuredRefreshGeneration;
}

function flushDeferredFeaturedRefresh() {
    if (!deferredFeaturedRefresh || isFeaturedRefreshPaused() || featuredRefreshInFlight) {
        return;
    }

    const nextRefresh = deferredFeaturedRefresh;
    deferredFeaturedRefresh = null;
    queueFeaturedRefresh(nextRefresh.language, nextRefresh);
}

function getFilteredFeaturedStreams() {
    return appState.featuredStreams;
}

function getFeaturedServerSort() {
    if (!currentCategoryFilter) {
        return '';
    }

    if (!featuredSortState.column) {
        return 'featured';
    }

    if (featuredSortState.column === 'viewer_count') {
        return featuredSortState.direction === 'asc' ? 'asc' : 'desc';
    }

    return 'featured';
}

function getFilteredFeaturedPageCount(filteredStreams = getFilteredFeaturedStreams()) {
    if (!featuredPageSize) return 0;
    return Math.ceil(filteredStreams.length / featuredPageSize);
}

function renderVisibleFeaturedStreams({ resetPage = false } = {}) {
    const filteredStreams = getFilteredFeaturedStreams();
    const totalPages = getFilteredFeaturedPageCount(filteredStreams);

    if (resetPage || totalPages === 0) {
        featuredCurrentPage = 1;
    } else {
        featuredCurrentPage = Math.max(1, Math.min(featuredCurrentPage, totalPages));
    }

    const startIndex = totalPages > 0 ? (featuredCurrentPage - 1) * featuredPageSize : 0;
    const visibleStreams = totalPages > 0
        ? filteredStreams.slice(startIndex, startIndex + featuredPageSize)
        : [];
    const isBusy = featuredRefreshInFlight || featuredPageNavigationInFlight || !hasFreshFeaturedCache();

    renderFeaturedStreamsTable(visibleStreams, {
        currentPage: totalPages > 0 ? featuredCurrentPage : 1,
        totalPages,
        totalCount: filteredStreams.length,
        loadedCount: appState.featuredStreams.length,
        loadedPageCount: featuredLoadedPageCount,
        hasMorePages: featuredHasNextPage,
        canGoPrev: !isBusy && totalPages > 0 && featuredCurrentPage > 1,
        canGoNext: !isBusy && (featuredCurrentPage < totalPages || featuredHasNextPage),
        canLoadMoreResults: !isBusy && totalPages === 0 && featuredHasNextPage,
        isRefreshing: featuredRefreshInFlight || !hasFreshFeaturedCache(),
        isPaging: featuredPageNavigationInFlight,
    });
}

function rebuildFeaturedDataset({ resetVisible = false } = {}) {
    const mergedStreams = mergeFeaturedPageCache(featuredPageCache, featuredLoadedPageCount);
    appState.featuredStreams = applyFeaturedStreamsSort(mergedStreams, featuredSortState);
    syncFeaturedSearchPool();
    if (!currentCategoryFilter) {
        populateCategorySelector(appState.featuredStreams);
    }
    renderVisibleFeaturedStreams({ resetPage: resetVisible });
}

function commitFeaturedPageCache(nextPageCache, nextPageMetaCache, { resetVisible = false } = {}) {
    featuredPageCache = nextPageCache;
    featuredPageMetaCache = nextPageMetaCache;
    featuredActiveGeneration = featuredRefreshGeneration;
    syncFeaturedLoadedRange();
    rebuildFeaturedDataset({ resetVisible });
}

function applyFeaturedPageResult(pageCache, pageMetaCache, pageResult) {
    if (!pageResult) return;

    pageCache.set(pageResult.page, pageResult.streams);
    pageMetaCache.set(pageResult.page, {
        hasNext: pageResult.hasNext,
        perPage: pageResult.perPage,
    });
}

async function fetchFeaturedPageData(language, page, generation) {
    const filters = currentCategoryFilter
        ? {
            subcategory: currentCategoryFilter,
            sort: getFeaturedServerSort(),
            strict: true,
        }
        : {};
    const response = await fetchFeaturedStreams(language, page, filters);

    if (generation !== featuredRefreshGeneration) {
        return null;
    }

    if (response?.status !== 'success') {
        throw new Error(`Featured page ${page} returned an invalid response.`);
    }

    return {
        page,
        streams: Array.isArray(response.data) ? response.data : [],
        perPage: response.pagination?.per_page || FEATURED_DEFAULT_PAGE_SIZE,
        hasNext: Boolean(response.pagination?.has_next),
    };
}

async function prefetchFeaturedPage(page) {
    if (
        featuredRefreshInFlight
        || !currentFeaturedLanguage
        || !hasFreshFeaturedCache()
        || featuredPageCache.has(page)
    ) {
        return null;
    }

    const existingPromise = featuredPrefetchInFlightPages.get(page);
    if (existingPromise) {
        return existingPromise;
    }

    const generation = featuredRefreshGeneration;
    const language = currentFeaturedLanguage;

    const prefetchPromise = (async () => {
        beginFeaturedNetworkActivity();

        try {
            const pageResult = await fetchFeaturedPageData(language, page, generation);

            if (!pageResult || generation !== featuredRefreshGeneration || language !== currentFeaturedLanguage) {
                return;
            }

            applyFeaturedPageResult(featuredPageCache, featuredPageMetaCache, pageResult);
            syncFeaturedLoadedRange();
            rebuildFeaturedDataset();
            void ensureFeaturedLookahead();
        } catch (error) {
            console.error(`Error prefetching featured page ${page}:`, error);
        } finally {
            featuredPrefetchInFlightPages.delete(page);
            endFeaturedNetworkActivity();
        }
    })();

    featuredPrefetchInFlightPages.set(page, prefetchPromise);
    return prefetchPromise;
}

async function prefetchFeaturedCoverage(targetLoadedPageCount, { wait = false } = {}) {
    if (featuredRefreshInFlight || !currentFeaturedLanguage || !hasFreshFeaturedCache()) {
        return false;
    }

    const fetchPromises = [];
    for (let page = featuredLoadedPageCount + 1; page <= targetLoadedPageCount; page += 1) {
        const pagePromise = prefetchFeaturedPage(page);
        if (wait && pagePromise) {
            fetchPromises.push(pagePromise);
        }
    }

    if (wait && fetchPromises.length > 0) {
        await Promise.allSettled(fetchPromises);
    }

    return featuredLoadedPageCount >= targetLoadedPageCount || !featuredHasNextPage;
}

async function ensureFeaturedLookahead(targetPage = featuredCurrentPage) {
    if (featuredRefreshInFlight || !currentFeaturedLanguage || !featuredHasNextPage || !hasFreshFeaturedCache()) {
        return;
    }

    const targetLoadedPageCount = Math.max(
        targetPage + FEATURED_LOOKAHEAD_PAGES,
        FEATURED_INITIAL_PAGES.length
    );
    void prefetchFeaturedCoverage(targetLoadedPageCount);
}

async function ensureFeaturedPageAvailable(targetPage) {
    if (getFilteredFeaturedPageCount() >= targetPage) {
        void ensureFeaturedLookahead(targetPage);
        return true;
    }

    while (!featuredRefreshInFlight && hasFreshFeaturedCache() && currentFeaturedLanguage) {
        if (!featuredHasNextPage) {
            return getFilteredFeaturedPageCount() >= targetPage;
        }

        const previousLoadedPageCount = featuredLoadedPageCount;
        const targetLoadedPageCount = Math.max(
            targetPage + FEATURED_LOOKAHEAD_PAGES,
            featuredLoadedPageCount + FEATURED_LOOKAHEAD_PAGES
        );

        await prefetchFeaturedCoverage(targetLoadedPageCount, { wait: true });

        if (getFilteredFeaturedPageCount() >= targetPage) {
            void ensureFeaturedLookahead(targetPage);
            return true;
        }

        if (featuredLoadedPageCount === previousLoadedPageCount) {
            return false;
        }
    }

    return getFilteredFeaturedPageCount() >= targetPage;
}

async function navigateToFeaturedPage(page) {
    const targetPage = Math.max(1, Number(page) || 1);
    const availablePages = getFilteredFeaturedPageCount();

    if (availablePages >= targetPage) {
        featuredCurrentPage = targetPage;
        renderVisibleFeaturedStreams();
        void ensureFeaturedLookahead(targetPage);
        return;
    }

    if (!featuredHasNextPage || featuredRefreshInFlight || !hasFreshFeaturedCache()) {
        return;
    }

    featuredPageNavigationInFlight = true;
    renderVisibleFeaturedStreams();

    try {
        const pageAvailable = await ensureFeaturedPageAvailable(targetPage);
        const nextAvailablePages = getFilteredFeaturedPageCount();

        if (pageAvailable && nextAvailablePages > 0) {
            featuredCurrentPage = Math.min(targetPage, nextAvailablePages);
        } else if (nextAvailablePages > 0) {
            featuredCurrentPage = Math.min(featuredCurrentPage, nextAvailablePages);
        } else {
            featuredCurrentPage = 1;
        }
    } finally {
        featuredPageNavigationInFlight = false;
        renderVisibleFeaturedStreams();
        void ensureFeaturedLookahead(featuredCurrentPage);
    }
}

function queueFeaturedRefresh(language, { background = false, resetVisible = false } = {}) {
    const nextRefresh = {
        language: getFeaturedRefreshLanguage(language),
        background,
        resetVisible,
        refreshLoadedRange: background,
    };

    if (nextRefresh.background && isFeaturedRefreshPaused()) {
        deferredFeaturedRefresh = nextRefresh;
        return;
    }

    if (featuredRefreshInFlight) {
        queuedFeaturedRefresh = nextRefresh;
        return;
    }

    void handleFetchFeaturedStreams(nextRefresh.language, nextRefresh);
}

function startFeaturedAutoRefresh(language) {
    stopFeaturedAutoRefresh();
    currentFeaturedLanguage = language;
    featuredTableRefreshTimer = setInterval(() => {
        queueFeaturedRefresh(language, { background: true, resetVisible: false });
    }, FEATURED_TABLE_REFRESH_INTERVAL_MS);
}

function stopFeaturedAutoRefresh() {
    clearInterval(featuredTableRefreshTimer);
    featuredTableRefreshTimer = null;
}

document.addEventListener('DOMContentLoaded', () => {
    window.addEventListener('unhandledrejection', (event) => {
        console.error('Unhandled promise rejection:', event.reason);
    });

    initializeChromecast();
    initButtonDelegation();

    const mainTitle = document.querySelector('.main-title');
    if (mainTitle) {
        mainTitle.addEventListener('click', (event) => {
            event.preventDefault();
            location.reload();
        });
    }
    const checkChannelBtn = document.getElementById('checkChannelBtn');
    const channelSlugInput = document.getElementById('channelSlugInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    const languageSelector = document.getElementById('languageSelector');
    const categorySelector = document.getElementById('categorySelector');

    // Initial setup for featured streams
    populateLanguageSelector().then(() => {
        currentFeaturedLanguage = languageSelector.value;
        queueFeaturedRefresh(languageSelector.value, { resetVisible: true });
        startFeaturedAutoRefresh(languageSelector.value);
    });
    addSortEventListeners('featuredLivestreams', () => {
        if (currentCategoryFilter && featuredSortState.column === 'viewer_count') {
            queueFeaturedRefresh(currentFeaturedLanguage, { resetVisible: true });
            return;
        }
        filterAndRenderFeaturedStreams();
    });

    // Featured table interactions and pagination
    const featuredSection = document.getElementById('featuredLivestreams');
    if (featuredSection) {
        featuredSection.addEventListener('mouseenter', () => {
            isFeaturedHovered = true;
        });
        featuredSection.addEventListener('mouseleave', () => {
            isFeaturedHovered = false;
            flushDeferredFeaturedRefresh();
        });
        featuredSection.addEventListener('focusin', () => {
            isFeaturedFocusWithin = true;
        });
        featuredSection.addEventListener('focusout', () => {
            requestAnimationFrame(() => {
                isFeaturedFocusWithin = featuredSection.contains(document.activeElement);
                if (!isFeaturedFocusWithin) {
                    flushDeferredFeaturedRefresh();
                }
            });
        });
        featuredSection.addEventListener('click', (event) => {
            const paginationButton = event.target.closest('[data-featured-page], [data-featured-page-action]');
            if (paginationButton) {
                event.preventDefault();

                if (paginationButton.disabled) {
                    return;
                }

                const { featuredPageAction, featuredPage } = paginationButton.dataset;
                if (featuredPageAction === 'prev') {
                    void navigateToFeaturedPage(featuredCurrentPage - 1);
                    return;
                }

                if (featuredPageAction === 'next') {
                    void navigateToFeaturedPage(featuredCurrentPage + 1);
                    return;
                }

                if (featuredPageAction === 'load-more') {
                    void navigateToFeaturedPage(Math.max(1, featuredCurrentPage));
                    return;
                }

                if (featuredPage) {
                    void navigateToFeaturedPage(Number(featuredPage));
                    return;
                }
            }

            // Channel cell click — load channel data
            const cell = event.target.closest('td[data-label="Channel"]');
            if (cell) {
                event.preventDefault();
                const channelSlug = cell.textContent.trim();
                channelSlugInput.value = channelSlug;
                handleFetchChannelData();
                return;
            }
        });
        featuredSection.classList.add('featured-clickable');
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            flushDeferredFeaturedRefresh();
        }
    });

    languageSelector.addEventListener('change', () => {
        currentFeaturedLanguage = languageSelector.value;
        // Reset category filter when switching language — the new language's
        // featured streams may have completely different categories.
        currentCategoryFilter = '';
        categorySelector.value = '';
        updateFeaturedSectionTitle(categorySelector);
        queueFeaturedRefresh(languageSelector.value, { resetVisible: true });
        startFeaturedAutoRefresh(languageSelector.value);
    });

    categorySelector.addEventListener('change', () => {
        const slug = categorySelector.value;
        currentCategoryFilter = slug;
        updateFeaturedSectionTitle(categorySelector);
        queueFeaturedRefresh(currentFeaturedLanguage, { resetVisible: true });
    });

    checkChannelBtn.addEventListener('click', handleFetchChannelData);
    channelSlugInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter' && !checkChannelBtn.disabled) {
            const sugg = document.getElementById('searchSuggestions');
            if (sugg && sugg.style.display !== 'none') {
                sugg.style.display = 'none';
            }
            handleFetchChannelData();
        }
    });

    // Channel search — two-tier: instant local results then server-side upgrade.
    // Server search (Typesense) covers ALL Kick channels (500k+, 8k+ live).
    // Local pool comes from the currently loaded featured page cache.
    // A monotonically-increasing sequence ID prevents stale responses from
    // overwriting newer ones when the user types quickly.
    let searchDebounce = null;
    let searchSeqId = 0;

    channelSlugInput.addEventListener('input', () => {
        const q = channelSlugInput.value.trim();
        clearTimeout(searchDebounce);
        if (q.length < 2) {
            const sugg = document.getElementById('searchSuggestions');
            if (sugg) sugg.style.display = 'none';
            return;
        }
        searchDebounce = setTimeout(async () => {
            const mySeq = ++searchSeqId;
            const sugg = document.getElementById('searchSuggestions');

            const onSelect = (slug) => {
                channelSlugInput.value = slug;
                if (sugg) sugg.style.display = 'none';
                handleFetchChannelData();
            };

            // Tier 1: instant local results from the already-loaded stream pool
            const pool = appState.searchPool.length > 0 ? appState.searchPool : appState.featuredStreams;
            const localRes = fetchSearchResults(q, pool);
            if (localRes.data.length > 0) {
                renderSearchResults(localRes.data, onSelect);
            }

            // Tier 2: upgrade with full Typesense server-side results
            // (covers all 500k+ Kick channels, not just featured/pooled ones)
            const serverRes = await fetchChannelSearch(q);
            if (mySeq !== searchSeqId) return; // a newer query superseded this one
            if (serverRes?.status === 'success' && serverRes.data?.length > 0) {
                // Enrich Typesense results with richer pool data where the slug
                // matches — adds profile_picture, viewer_count, stream_title, category.
                // Channels outside the pool fall back to followers_count (Typesense has it).
                const poolMap = new Map();
                pool.forEach(s => {
                    const slug = s.channel?.slug || s.slug || '';
                    if (slug) poolMap.set(slug, s);
                });
                const enriched = serverRes.data.map(r => {
                    const p = poolMap.get(r.slug);
                    if (!p) return r;
                    const user = p.channel?.user || {};
                    return {
                        ...r,
                        profile_picture: user.profilepic || null,
                        viewer_count: p.viewer_count || null,
                        stream_title: p.session_title || null,
                        category: p.categories?.[0]?.name || null,
                    };
                });
                renderSearchResults(enriched, onSelect);

                // Lazy-load avatars for all results still missing a profile picture.
                // Server caches each for 7 days, so first lookup costs 1 Kick API
                // call per channel; every subsequent search is free.
                const needsAvatar = enriched.filter(r => !r.profile_picture);

                if (needsAvatar.length > 0) {
                    const avatarResults = await Promise.allSettled(
                        needsAvatar.map(r =>
                            fetchChannelAvatar(r.slug).then(pic => ({ slug: r.slug, pic }))
                        )
                    );
                    if (mySeq !== searchSeqId) return; // user typed ahead — discard

                    const container = document.getElementById('searchSuggestions');
                    if (!container) return;
                    avatarResults.forEach(res => {
                        if (res.status !== 'fulfilled') return;
                        const { slug, pic } = res.value;
                        const item = container.querySelector(`[data-slug="${CSS.escape(slug)}"]`);
                        if (!item) return;
                        // Target both the old grey placeholder and the new initials avatar
                        const fallback = item.querySelector(
                            '.suggestion-avatar--placeholder, .suggestion-avatar--initials'
                        );
                        if (!fallback) return; // already showing a real image
                        if (pic) {
                            // Replace with real profile picture
                            const img = document.createElement('img');
                            img.src = pic;
                            img.alt = '';
                            img.className = 'suggestion-avatar';
                            fallback.replaceWith(img);
                        }
                        // No pic → initials avatar already shown, nothing to do
                    });
                }
            }
        }, 300);
    });

    // Hide suggestions on outside click or Escape
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.input-section')) {
            const sugg = document.getElementById('searchSuggestions');
            if (sugg) sugg.style.display = 'none';
        }
    });
    channelSlugInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const sugg = document.getElementById('searchSuggestions');
            if (sugg) sugg.style.display = 'none';
        }
    });

    if (clearSearchBtn) {
        clearSearchBtn.addEventListener('click', () => {
            channelSlugInput.value = '';
            clearPreviousData();
            stopViewerRefresh();
            showMessage('Search cleared.', 'info');
        });
    }
});

async function populateLanguageSelector() {
    try {
        const response = await fetch('/config/languages');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const config = await response.json();
        const languageSelector = document.getElementById('languageSelector');
        languageSelector.innerHTML = '';
        config.languages.forEach(lang => {
            const option = document.createElement('option');
            option.value = lang.code;
            option.textContent = lang.name;
            if (lang.code === config.default_language) option.selected = true;
            languageSelector.appendChild(option);
        });
    } catch (error) {
        console.error('Error fetching languages:', error);
        const languageSelector = document.getElementById('languageSelector');
        const fallback = document.createElement('option');
        fallback.value = 'en';
        fallback.textContent = 'English (default)';
        languageSelector.appendChild(fallback);
        showMessage('Could not load language options. Using default.', 'error');
    }
}

async function handleFetchFeaturedStreams(language = 'en', options = {}) {
    const { background = false, resetVisible = false, refreshLoadedRange = background } = options;
    currentFeaturedLanguage = language;
    const generation = ++featuredRefreshGeneration;
    featuredRefreshInFlight = true;
    featuredPrefetchInFlightPages.clear();
    beginFeaturedNetworkActivity();

    try {
        const pagesToFetch = refreshLoadedRange && featuredLoadedPageCount > 0
            ? buildFeaturedPageRange(featuredLoadedPageCount)
            : [...FEATURED_INITIAL_PAGES];
        const nextPageCache = new Map();
        const nextPageMetaCache = new Map();

        const pageResults = await Promise.allSettled(
            pagesToFetch.map(page => fetchFeaturedPageData(language, page, generation))
        );

        if (generation !== featuredRefreshGeneration) {
            return;
        }

        const hasSupersedingQueuedRefresh = queuedFeaturedRefresh && (
            queuedFeaturedRefresh.language !== language
            || queuedFeaturedRefresh.resetVisible
            || !queuedFeaturedRefresh.background
        );

        if (hasSupersedingQueuedRefresh) {
            return;
        }

        let successfulPages = 0;
        pageResults.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                applyFeaturedPageResult(nextPageCache, nextPageMetaCache, result.value);
                successfulPages += 1;
                return;
            }

            if (result.status === 'rejected') {
                console.error('Error fetching featured livestream page:', result.reason);
            }
        });

        const nextLoadedPageCount = getContiguousFeaturedPageCount(nextPageCache);
        if (successfulPages > 0 && nextLoadedPageCount > 0) {
            commitFeaturedPageCache(nextPageCache, nextPageMetaCache, { resetVisible });
            if (!featuredRefreshInFlight) {
                void ensureFeaturedLookahead();
            }
            return;
        }

        if (!background) {
            showMessage('Failed to load featured livestreams.', 'error', () => queueFeaturedRefresh(language, { resetVisible }));
        }
    } catch (error) {
        console.error('Error fetching featured livestreams:', error);
        if (!background) {
            showMessage('Failed to load featured livestreams.', 'error', () => queueFeaturedRefresh(language, { resetVisible }));
        }
    } finally {
        if (generation === featuredRefreshGeneration) {
            featuredRefreshInFlight = false;
        }
        endFeaturedNetworkActivity();

        if (queuedFeaturedRefresh) {
            const nextRefresh = queuedFeaturedRefresh;
            queuedFeaturedRefresh = null;
            if (nextRefresh.background && isFeaturedRefreshPaused()) {
                deferredFeaturedRefresh = nextRefresh;
            } else {
                void handleFetchFeaturedStreams(nextRefresh.language, nextRefresh);
            }
            return;
        }

        flushDeferredFeaturedRefresh();
        if (!featuredRefreshInFlight) {
            renderVisibleFeaturedStreams();
            void ensureFeaturedLookahead();
        }
    }
}

function populateCategorySelector(streams) {
    const categorySelector = document.getElementById('categorySelector');
    const previousValue = categorySelector.value; // slug or ''

    // Build slug -> display name map from loaded featured streams so filtering
    // options reflect the currently loaded promoted featured dataset.
    const categoryMap = new Map(); // slug → name
    streams.forEach(stream => {
        const cat = stream.categories?.[0];
        if (cat?.slug && cat?.name) {
            categoryMap.set(cat.slug, cat.name);
        }
    });

    const sortedSlugs = [...categoryMap.keys()].sort((a, b) =>
        categoryMap.get(a).localeCompare(categoryMap.get(b))
    );

    categorySelector.innerHTML = '<option value="">All Categories</option>';
    sortedSlugs.forEach(slug => {
        const option = document.createElement('option');
        option.value = slug;
        option.textContent = categoryMap.get(slug);
        categorySelector.appendChild(option);
    });

    // Restore previous selection if the slug is still present
    if (previousValue && sortedSlugs.includes(previousValue)) {
        categorySelector.value = previousValue;
    } else if (currentCategoryFilter && !sortedSlugs.includes(currentCategoryFilter)) {
        currentCategoryFilter = '';
        categorySelector.value = '';
        updateFeaturedSectionTitle(categorySelector);
    }
}

function updateFeaturedSectionTitle(categorySelector) {
    const title = document.getElementById('featuredSectionTitle');
    if (!title) return;
    if (categorySelector?.value) {
        const name = categorySelector.options[categorySelector.selectedIndex]?.text || categorySelector.value;
        title.textContent = name;
    } else {
        title.textContent = 'Featured Streams';
    }
}

function filterAndRenderFeaturedStreams(options = {}) {
    renderVisibleFeaturedStreams(options);
    if (!featuredRefreshInFlight) {
        void ensureFeaturedLookahead();
    }
}

// --- Viewer count auto-refresh ---
function getLastKnownViewerCount(el) {
    if (!el) return null;

    const datasetValue = Number(el.dataset.lastKnownViewerCount);
    if (Number.isFinite(datasetValue) && datasetValue > 0) {
        return datasetValue;
    }

    const parsedTextValue = Number(String(el.textContent || '').replace(/[^\d]/g, ''));
    return Number.isFinite(parsedTextValue) && parsedTextValue > 0
        ? parsedTextValue
        : null;
}

function updateLiveViewerCountDisplay(el, viewerCount) {
    if (!el) return;

    const numericViewerCount = Number(viewerCount);
    if (Number.isFinite(numericViewerCount) && numericViewerCount > 0) {
        el.dataset.lastKnownViewerCount = String(numericViewerCount);
        el.textContent = numericViewerCount.toLocaleString('en-US');
        return;
    }

    const lastKnownViewerCount = getLastKnownViewerCount(el);
    if (lastKnownViewerCount) {
        el.textContent = lastKnownViewerCount.toLocaleString('en-US');
        el.dataset.lastKnownViewerCount = String(lastKnownViewerCount);
        return;
    }

    if (Number.isFinite(numericViewerCount) && numericViewerCount === 0) {
        el.textContent = '0';
        return;
    }

    el.textContent = 'N/A';
}

async function refreshLiveViewerCount(livestreamId) {
    if (!livestreamId) return;

    const result = await fetchViewerCount(livestreamId);
    if (result?.status !== 'success') return;

    const el = document.getElementById('liveViewerCount');
    if (!el || String(el.dataset.livestreamId || '') !== String(livestreamId)) return;

    updateLiveViewerCountDisplay(el, result.data?.viewer_count);
}

function startViewerRefresh(livestreamId, { immediate = false } = {}) {
    stopViewerRefresh();
    if (!livestreamId) return;

    if (immediate) {
        // The live payload is cached longer than the viewer endpoint, so when
        // Kick reports 0 viewers in the main payload we hydrate once from the
        // lighter, 10-second cached viewer route before the regular interval.
        void refreshLiveViewerCount(livestreamId);
    }

    viewerRefreshTimer = setInterval(() => {
        void refreshLiveViewerCount(livestreamId);
    }, 30000);
}

function stopViewerRefresh() {
    if (viewerRefreshTimer) {
        clearInterval(viewerRefreshTimer);
        viewerRefreshTimer = null;
    }
}

async function handleFetchChannelData() {
    const channelSlug = document.getElementById('channelSlugInput').value.trim();
    if (!channelSlug) {
        showMessage('Please enter a channel slug.', 'error');
        return;
    }

    const checkBtn = document.getElementById('checkChannelBtn');
    if (checkBtn) checkBtn.disabled = true;

    stopViewerRefresh();
    clearPreviousData();
    showMessage('Fetching data...', 'info');
    showLoadingIndicator();

    try {
        const { liveData, vodsData, clipsData } = await fetchChannelData(channelSlug);
        renderLiveStreamInfo(liveData, channelSlug);

        // Start viewer count auto-refresh if live
        if (liveData.status === 'success' && liveData.data?.status === 'live') {
            const initialViewerCount = Number(liveData.data.livestream_viewer_count);
            startViewerRefresh(liveData.data.livestream_id, {
                immediate: !Number.isFinite(initialViewerCount) || initialViewerCount <= 0,
            });
        }

        appState.vods = vodsData.status === 'success' ? (vodsData.data?.vods || []) : [];
        renderVodsInfo(vodsData, channelSlug);

        appState.clips = clipsData?.status === 'success' ? (clipsData.data?.clips || []) : [];
        renderClipsInfo(clipsData || { status: 'error' }, channelSlug);

        document.getElementById('statusMessage').style.display = 'none';
    } catch (error) {
        console.error('Error fetching channel data:', error);
        showMessage(`An error occurred: ${error.message}`, 'error', () => handleFetchChannelData());
        clearPreviousData();
    } finally {
        hideLoadingIndicator();
        if (checkBtn) checkBtn.disabled = false;
    }
}
