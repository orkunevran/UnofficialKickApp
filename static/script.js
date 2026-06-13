/**
 * Kick App v3.2.0 — Main entry point.
 * Thin orchestrator: initializes router, search, theme, shortcuts, chromecast.
 */

import { route, navigate, init as initRouter } from './js/router.js';
import { initializeChromecast } from './js/chromecast.js';
import { initButtonDelegation, renderSearchResults, renderSearchLoading, renderSearchEmpty, handleSuggestionKeydown, updateFavoritesBadge } from './js/ui.js';
import { appState, loadPreferences, preferences, savePreferences } from './js/state.js';
import { initShortcuts } from './js/shortcuts.js';
import { initMiniPlayerControls } from './js/player.js';
import { getFavoriteCount } from './js/favorites.js';
import { fetchSearchResults, fetchChannelSearch, fetchChannelAvatar } from './js/api.js';
import { initialsAvatar } from './js/utils.js';

// Safari perf: add class so CSS can swap expensive effects for lightweight alternatives
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
if (isSafari) document.documentElement.classList.add('safari');

// Prevent Safari pinch-to-zoom — belt-and-suspenders alongside CSS touch-action
if (isSafari) {
    document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
}

// Expose modules for cross-module access without circular imports
window.__favModule = { getFavoriteCount };
window.__routerModule = { navigate };
window.__stateModule = { preferences, savePreferences };

// ── View imports ──────────────────────────────────────────────────────────
import { mount as mountBrowse } from './js/views/browse.js';
import { mount as mountChannel } from './js/views/channel.js';
import { mount as mountFavorites } from './js/views/favorites.js';
import { mount as mountHistory } from './js/views/history.js';
import { mount as mountSettings } from './js/views/settings.js';

// ── Register routes ───────────────────────────────────────────────────────
route('/browse', mountBrowse);
route('/channel/:slug', mountChannel);
route('/favorites', mountFavorites);
route('/history', mountHistory);
route('/settings', mountSettings);

// ── DOMContentLoaded ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Handle unhandled rejections
    window.addEventListener('unhandledrejection', (e) => {
        console.error('Unhandled promise rejection:', e.reason);
    });

    // Load preferences
    loadPreferences();

    // ── Theme system ────────────────────────────────────────────────────────
    function resolveTheme(pref) {
        if (pref === 'light' || pref === 'dark') return pref;
        // 'system' or unset — follow OS preference
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }

    function applyTheme(pref) {
        const resolved = resolveTheme(pref);
        // Add transition class, apply theme, then remove class after animation
        const shouldTransition = !isSafari;
        if (shouldTransition) document.documentElement.classList.add('theme-transitioning');
        if (resolved === 'dark') {
            delete document.documentElement.dataset.theme;
        } else {
            document.documentElement.dataset.theme = resolved;
        }
        updateThemeIcon(pref);
        // Update <meta name="theme-color"> and <meta name="color-scheme">
        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) metaTheme.content = resolved === 'light' ? '#f5f6f8' : '#0b0e14';
        const metaScheme = document.querySelector('meta[name="color-scheme"]');
        if (metaScheme) metaScheme.content = resolved === 'light' ? 'light' : 'dark';
        if (shouldTransition) {
            requestAnimationFrame(() => {
                setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 350);
            });
        }
    }

    function updateThemeIcon(pref) {
        const sun = document.getElementById('theme-icon-sun');
        const moon = document.getElementById('theme-icon-moon');
        const auto = document.getElementById('theme-icon-auto');
        if (!sun || !moon || !auto) return;
        sun.style.display = pref === 'light' ? 'block' : 'none';
        moon.style.display = pref === 'dark' ? 'block' : 'none';
        auto.style.display = (pref === 'system' || !pref) ? 'block' : 'none';
        const btn = document.getElementById('theme-toggle-btn');
        if (btn) {
            const labels = { system: 'Theme: System', light: 'Theme: Light', dark: 'Theme: Dark' };
            btn.title = labels[pref] || labels.system;
        }
    }

    // Expose for shortcuts module
    window.__applyTheme = applyTheme;

    // Apply initial theme (no transition on first load)
    const initialTheme = preferences.theme || 'system';
    const initialResolved = resolveTheme(initialTheme);
    if (initialResolved === 'light') {
        document.documentElement.dataset.theme = 'light';
    }
    updateThemeIcon(initialTheme);

    // Theme toggle button
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const order = ['system', 'light', 'dark'];
            const current = preferences.theme || 'system';
            const next = order[(order.indexOf(current) + 1) % order.length];
            preferences.theme = next;
            savePreferences();
            applyTheme(next);
            // Sync settings dropdown if visible
            const sel = document.getElementById('settings-theme');
            if (sel) sel.value = next;
        });
    }

    // Follow OS changes when theme is 'system'
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        if ((preferences.theme || 'system') === 'system') {
            applyTheme('system');
        }
    });

    // Pre-fetch static config (languages never change at runtime)
    fetch('/config/languages').then(r => r.ok ? r.json() : null).then(cfg => {
        if (cfg) appState.languagesConfig = cfg;
    }).catch(() => {});

    // Initialize systems
    initializeChromecast();
    initButtonDelegation();
    initShortcuts();
    initMiniPlayerControls();

    // ── Dynamic mini-player gap (iPhone safe-area robustness) ────────────
    function syncMiniPlayerGap() {
        const nav = document.querySelector('.mobile-nav');
        if (!nav || window.innerWidth >= 768) return;
        const gap = window.innerHeight - nav.getBoundingClientRect().top + 10;
        document.documentElement.style.setProperty('--mini-player-mobile-bottom-gap', `${gap}px`);
    }
    syncMiniPlayerGap();
    let gapResizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(gapResizeTimer);
        gapResizeTimer = setTimeout(syncMiniPlayerGap, 150);
    });
    window.addEventListener('orientationchange', () => setTimeout(syncMiniPlayerGap, 200));

    // Modal background inert management — prevents tabbing/interaction behind open modals
    const appEl = document.getElementById('app');
    const mobileNav = document.getElementById('mobile-nav');
    const modals = document.querySelectorAll('.modal');
    const inertTargets = [appEl, mobileNav].filter(Boolean);

    const observer = new MutationObserver(() => {
        const anyVisible = [...modals].some(m => m.classList.contains('visible'));
        inertTargets.forEach(el => {
            if (anyVisible) el.setAttribute('inert', '');
            else el.removeAttribute('inert');
        });
    });
    modals.forEach(m => observer.observe(m, { attributes: true, attributeFilter: ['class'] }));

    // Update favorites badge
    updateFavoritesBadge();
    window.addEventListener('favorites-changed', updateFavoritesBadge);

    // Sidebar toggle
    initSidebar();

    // Global search
    initSearch();

    // Start router (reads hash, renders initial view)
    initRouter();
});

// ── Sidebar ───────────────────────────────────────────────────────────────
function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('sidebar-toggle');
    if (!toggle || !sidebar) return;

    // Restore collapsed state
    if (preferences.sidebarCollapsed) {
        sidebar.classList.add('collapsed');
    }

    toggle.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        preferences.sidebarCollapsed = sidebar.classList.contains('collapsed');
        savePreferences();
    });
}

// ── Global Search ─────────────────────────────────────────────────────────
function initSearch() {
    const input = document.getElementById('channelSlugInput');
    if (!input) return;
    const clearBtn = document.getElementById('search-clear-btn');
    const searchContainer = document.getElementById('search-container');
    const sugg = document.getElementById('searchSuggestions');

    const REMOTE_SEARCH_DEBOUNCE_MS = 260;
    const REMOTE_SEARCH_MIN_CHARS = 4;
    const SEARCH_CACHE_TTL_MS = 30_000;
    const SEARCH_CACHE_MAX_ENTRIES = 40;

    let remoteSearchDebounce = null;
    let searchSeqId = 0;
    let activeSearchController = null;
    const serverSearchCache = new Map();

    const hideSuggestions = () => {
        if (sugg) sugg.style.display = 'none';
    };

    const cancelActiveSearch = () => {
        clearTimeout(remoteSearchDebounce);
        remoteSearchDebounce = null;
        if (activeSearchController) {
            activeSearchController.abort();
            activeSearchController = null;
        }
    };

const syncClearButton = () => {
    if (!clearBtn) return;
    clearBtn.hidden = input.value.length === 0;
};

const syncClearVisibility = () => {
    const hasQuery = input.value.length > 0;
    clearBtn.classList.toggle('is-visible', hasQuery);
    searchContainer.classList.toggle('has-query', hasQuery);
};
syncClearVisibility(); // Initialize state on load

    const clearSearch = ({ focus = true } = {}) => {
        searchSeqId++;
        cancelActiveSearch();
        input.value = '';
        hideSuggestions();
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        syncClearButton();
        if (focus) input.focus();
    };

    const onSelect = (slug) => {
        input.value = slug;
        hideSuggestions();
        syncClearButton();
        navigate(`/channel/${slug}`);
    };

    const getPool = () => (appState.searchPool.length > 0 ? appState.searchPool : appState.featuredStreams);

    const readCachedSearch = (queryKey) => {
        const hit = serverSearchCache.get(queryKey);
        if (!hit) return null;
        if ((Date.now() - hit.ts) > SEARCH_CACHE_TTL_MS) {
            serverSearchCache.delete(queryKey);
            return null;
        }
        return hit.data;
    };

    const writeCachedSearch = (queryKey, data) => {
        serverSearchCache.set(queryKey, { ts: Date.now(), data });
        if (serverSearchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
            const oldestKey = serverSearchCache.keys().next().value;
            if (oldestKey) serverSearchCache.delete(oldestKey);
        }
    };

    const enrichSearchResults = (serverData, pool) => {
        const poolMap = new Map();
        pool.forEach(s => {
            const slug = s.channel?.slug || s.slug || '';
            if (slug) poolMap.set(slug, s);
        });

        return serverData.map(r => {
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
    };

    // Sync aria-expanded on the combobox with suggestions visibility
    if (sugg) {
        new MutationObserver(() => {
            const open = sugg.style.display !== 'none';
            input.setAttribute('aria-expanded', String(open));
            if (!open) input.removeAttribute('aria-activedescendant');
        }).observe(sugg, { attributes: true, attributeFilter: ['style'] });
    }

    input.addEventListener('input', () => {
        syncClearVisibility();
        const q = input.value.trim();
        const queryKey = q.toLowerCase();
        searchSeqId++;
        const mySeq = searchSeqId;
        syncClearButton();

        cancelActiveSearch();

        if (q.length < 2) {
            hideSuggestions();
            return;
        }

        // Tier 1: local search (instant, no debounce)
        const pool = getPool();
        const localRes = fetchSearchResults(q, pool);
        if (localRes.data.length > 0) {
            renderSearchResults(localRes.data, onSelect);
        } else {
            renderSearchLoading();
        }

        if (q.length < REMOTE_SEARCH_MIN_CHARS) return;

        remoteSearchDebounce = setTimeout(async () => {
            if (mySeq !== searchSeqId) return;

            let serverData = readCachedSearch(queryKey);
            if (!serverData) {
                activeSearchController = new AbortController();
                const serverRes = await fetchChannelSearch(q, activeSearchController.signal);
                if (mySeq !== searchSeqId) return;
                activeSearchController = null;
                if (serverRes?.status === 'success' && Array.isArray(serverRes.data)) {
                    serverData = serverRes.data;
                    writeCachedSearch(queryKey, serverData);
                }
            }

            if (!Array.isArray(serverData) || serverData.length === 0) {
                if (localRes.data.length === 0) renderSearchEmpty();
                return;
            }

            const enriched = enrichSearchResults(serverData, pool);
            renderSearchResults(enriched, onSelect);

            // Lazy-load missing avatars in background (non-blocking).
            const needsAvatar = enriched.filter(r => !r.profile_picture);
            if (needsAvatar.length > 0) {
                (async () => {
                    const avatarResults = await Promise.allSettled(
                        needsAvatar.map(r => fetchChannelAvatar(r.slug).then(pic => ({ slug: r.slug, pic })))
                    );
                    if (mySeq !== searchSeqId) return;
                    const container = document.getElementById('searchSuggestions');
                    if (!container) return;
                    avatarResults.forEach(res => {
                        if (res.status !== 'fulfilled') return;
                        const { slug, pic } = res.value;
                        if (!pic) return;
                        const item = container.querySelector(`[data-slug="${CSS.escape(slug)}"]`);
                        if (!item) return;
                        const fallback = item.querySelector('.initials-avatar');
                        if (!fallback) return;
                        const img = document.createElement('img');
                        img.src = pic;
                        img.alt = '';
                        img.className = 'suggestion-avatar';
                        fallback.replaceWith(img);
                    });
                })();
            }
        }, REMOTE_SEARCH_DEBOUNCE_MS);
    });

    if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            clearSearch({ focus: true });
        });
        syncClearButton();
    }

    // Enter key → navigate to channel
    input.addEventListener('keydown', (e) => {
        if (handleSuggestionKeydown(e)) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (sugg && sugg.style.display !== 'none') {
                hideSuggestions();
                return;
            }
            if (input.value.length > 0) {
                clearSearch({ focus: true });
                return;
            }
            input.blur();
            return;
        }
        if (e.key === 'Enter') {
            if (sugg && sugg.style.display !== 'none') {
                hideSuggestions();
            }
            const slug = input.value.trim();
            if (slug) navigate(`/channel/${slug}`);
        }
    });

    // Hide suggestions on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#search-container')) {
            hideSuggestions();
        }
    });
}
