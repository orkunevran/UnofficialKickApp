/**
 * Kick App v2 — Main entry point.
 * Thin orchestrator: initializes router, search, shortcuts, chromecast.
 */

import { route, navigate, init as initRouter } from './js/router.js?v=2.4.8';
import { initializeChromecast } from './js/chromecast.js?v=2.4.8';
import { initButtonDelegation, renderSearchResults, renderSearchLoading, renderSearchEmpty, handleSuggestionKeydown, updateFavoritesBadge } from './js/ui.js?v=2.4.8';
import { appState, loadPreferences, preferences } from './js/state.js?v=2.4.8';
import { initShortcuts } from './js/shortcuts.js?v=2.4.8';
import { initMiniPlayerControls } from './js/player.js?v=2.5.0';
import { getFavoriteCount } from './js/favorites.js?v=2.4.8';
import { fetchSearchResults, fetchChannelSearch, fetchChannelAvatar } from './js/api.js?v=2.4.8';
import { initialsAvatar } from './js/utils.js?v=2.4.8';

// Expose modules for cross-module access without circular imports
window.__favModule = { getFavoriteCount };
window.__routerModule = { navigate };

// ── View imports ──────────────────────────────────────────────────────────
import { mount as mountBrowse } from './js/views/browse.js?v=2.4.8';
import { mount as mountChannel } from './js/views/channel.js?v=2.5.0';
import { mount as mountFavorites } from './js/views/favorites.js?v=2.4.8';
import { mount as mountHistory } from './js/views/history.js?v=2.4.8';
import { mount as mountSettings } from './js/views/settings.js?v=2.4.8';

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

    // Apply saved theme
    if (preferences.theme && preferences.theme !== 'dark') {
        document.documentElement.dataset.theme = preferences.theme;
    }

    // Pre-fetch static config (languages never change at runtime)
    fetch('/config/languages').then(r => r.ok ? r.json() : null).then(cfg => {
        if (cfg) appState.languagesConfig = cfg;
    }).catch(() => {});

    // Initialize systems
    initializeChromecast();
    initButtonDelegation();
    initShortcuts();
    initMiniPlayerControls();

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
        localStorage.setItem('kick-api-preferences', JSON.stringify(preferences));
    });
}

// ── Global Search ─────────────────────────────────────────────────────────
function initSearch() {
    const input = document.getElementById('channelSlugInput');
    if (!input) return;

    let searchDebounce = null;
    let searchSeqId = 0;

    input.addEventListener('input', () => {
        const q = input.value.trim();
        clearTimeout(searchDebounce);
        if (q.length < 2) {
            const sugg = document.getElementById('searchSuggestions');
            if (sugg) sugg.style.display = 'none';
            return;
        }
        searchDebounce = setTimeout(async () => {
            const mySeq = ++searchSeqId;
            const onSelect = (slug) => {
                input.value = slug;
                const sugg = document.getElementById('searchSuggestions');
                if (sugg) sugg.style.display = 'none';
                navigate(`/channel/${slug}`);
            };

            // Tier 1: local search
            const pool = appState.searchPool.length > 0 ? appState.searchPool : appState.featuredStreams;
            const localRes = fetchSearchResults(q, pool);
            if (localRes.data.length > 0) {
                renderSearchResults(localRes.data, onSelect);
            } else {
                renderSearchLoading();
            }

            // Tier 2: server-side Typesense search
            const serverRes = await fetchChannelSearch(q);
            if (mySeq !== searchSeqId) return;
            if (serverRes?.status === 'success' && serverRes.data?.length > 0) {
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

                // Lazy-load avatars
                const needsAvatar = enriched.filter(r => !r.profile_picture);
                if (needsAvatar.length > 0) {
                    const avatarResults = await Promise.allSettled(
                        needsAvatar.map(r => fetchChannelAvatar(r.slug).then(pic => ({ slug: r.slug, pic })))
                    );
                    if (mySeq !== searchSeqId) return;
                    const container = document.getElementById('searchSuggestions');
                    if (!container) return;
                    avatarResults.forEach(res => {
                        if (res.status !== 'fulfilled') return;
                        const { slug, pic } = res.value;
                        const item = container.querySelector(`[data-slug="${CSS.escape(slug)}"]`);
                        if (!item) return;
                        const fallback = item.querySelector('.initials-avatar');
                        if (!fallback) return;
                        if (pic) {
                            const img = document.createElement('img');
                            img.src = pic;
                            img.alt = '';
                            img.className = 'suggestion-avatar';
                            fallback.replaceWith(img);
                        }
                    });
                }
            } else if (localRes.data.length === 0) {
                renderSearchEmpty();
            }
        }, 300);
    });

    // Enter key → navigate to channel
    input.addEventListener('keydown', (e) => {
        if (handleSuggestionKeydown(e)) return;
        if (e.key === 'Escape') {
            const sugg = document.getElementById('searchSuggestions');
            if (sugg) sugg.style.display = 'none';
            input.blur();
        }
        if (e.key === 'Enter') {
            const sugg = document.getElementById('searchSuggestions');
            if (sugg && sugg.style.display !== 'none') {
                sugg.style.display = 'none';
            }
            const slug = input.value.trim();
            if (slug) navigate(`/channel/${slug}`);
        }
    });

    // Hide suggestions on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#search-container')) {
            const sugg = document.getElementById('searchSuggestions');
            if (sugg) sugg.style.display = 'none';
        }
    });
}
