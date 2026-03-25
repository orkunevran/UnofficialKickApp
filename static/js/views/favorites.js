/**
 * Favorites view — shows favorited channels with live status.
 * Renders instantly from cache/localStorage, fetches live data once,
 * then does a single sorted re-render (no flashing).
 */

import { getFavorites, removeFavorite } from '../favorites.js';
import { fetchLiveStatus } from '../api.js';
import { escapeHtml, initialsAvatar, formatViewerCount } from '../utils.js';
import { navigate } from '../router.js';
import { updateFavoritesBadge } from '../ui.js';

// Module-level cache so returning to the tab is instant
let _cachedResults = null;   // [{fav, liveData}, ...]
let _cachedAt = 0;           // timestamp of last fetch
const CACHE_FRESH_MS = 60_000; // 60s — don't re-fetch if cache is recent

function renderFavoriteCard(fav, liveStatus = null) {
    const isLive = liveStatus?.data?.status === 'live';
    const d = liveStatus?.data;
    const thumbSrc = isLive ? (d?.livestream_thumbnail_url || '') : '';
    const viewers = isLive ? d?.livestream_viewer_count : null;
    const title = isLive ? d?.livestream_title : (liveStatus === null ? '' : 'Offline');
    const category = isLive ? (d?.livestream_category || '') : '';

    const avatarHTML = fav.profilePicture
        ? `<img src="${escapeHtml(fav.profilePicture)}" alt="" class="card-avatar" loading="lazy">`
        : initialsAvatar(fav.username || fav.slug);

    return `
        <div class="stream-card" data-slug="${escapeHtml(fav.slug)}" style="cursor:pointer" tabindex="0" role="article" aria-label="${escapeHtml(fav.username || fav.slug)}${isLive ? ', Live' : ''}${viewers != null ? ', ' + formatViewerCount(viewers) + ' viewers' : ''}">
            <div class="card-thumbnail">
                ${thumbSrc ? `<img src="${escapeHtml(thumbSrc)}" alt="${escapeHtml(fav.username || fav.slug)} stream thumbnail" class="thumb-fade" onload="this.classList.add('loaded')" onerror="this.onerror=null;this.src='${escapeHtml(fav.profilePicture || '')}';this.style.objectFit='contain';this.classList.add('loaded');">` : '<div style="width:100%;height:100%;background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;color:var(--text-secondary);font-size:13px">' + (liveStatus === null ? '' : (isLive ? '' : 'Offline')) + '</div>'}
                ${isLive ? '<div class="card-live-badge"><span class="card-live-dot"></span>LIVE</div>' : ''}
                ${viewers != null ? `<div class="card-viewers"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>${formatViewerCount(viewers)}</div>` : ''}
                <div class="card-actions-overlay" style="opacity:1;background:linear-gradient(to top, rgba(0,0,0,0.5) 0%, transparent 60%)">
                    <button class="card-action-btn favorited" data-action="unfavorite" data-slug="${escapeHtml(fav.slug)}" title="Remove from favorites">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
                    </button>
                </div>
            </div>
            <div class="card-info">
                ${avatarHTML}
                <div class="card-details">
                    <div class="card-channel">${escapeHtml(fav.username || fav.slug)}</div>
                    <div class="card-title">${escapeHtml(title || '')}</div>
                    ${category ? `<span class="card-category">${escapeHtml(category)}</span>` : ''}
                </div>
            </div>
        </div>`;
}

function sortResolved(resolved) {
    return [...resolved].sort((a, b) => {
        const aLive = a.liveData?.data?.status === 'live' ? 1 : 0;
        const bLive = b.liveData?.data?.status === 'live' ? 1 : 0;
        return bLive - aLive;
    });
}

export async function mount(params, contentEl) {
    const favorites = getFavorites();

    if (favorites.length === 0) {
        _cachedResults = null;
        contentEl.innerHTML = `
            <div class="section-header">
                <h1 class="section-title">Favorites</h1>
            </div>
            <div id="favorites-grid">
                <div class="empty-state">
                    <div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg></div>
                    <div class="empty-state-title">No favorites yet</div>
                    <div class="empty-state-text">Browse streams and click the heart icon to add channels to your favorites.</div>
                    <a href="#/browse" class="btn-primary" style="margin-top:16px;display:inline-flex">Browse Streams</a>
                </div>
            </div>`;
        return;
    }

    // Build initial resolved list from module cache
    let currentResolved;
    const isCacheFresh = _cachedResults && (Date.now() - _cachedAt < CACHE_FRESH_MS);
    if (_cachedResults && _cachedResults.length > 0) {
        const cached = new Map(_cachedResults.map(r => [r.fav.slug, r]));
        currentResolved = favorites.map(fav => cached.get(fav.slug) || { fav, liveData: null });
    } else {
        currentResolved = favorites.map(fav => ({ fav, liveData: null }));
    }

    // Render immediately from cache — no flicker
    contentEl.innerHTML = `
        <div class="section-header">
            <h1 class="section-title">Favorites <span class="section-count">(${favorites.length})</span></h1>
        </div>
        <div id="favorites-grid">
            <div class="stream-grid">${sortResolved(currentResolved).map(r => renderFavoriteCard(r.fav, r.liveData)).join('')}</div>
        </div>`;

    const grid = contentEl.querySelector('#favorites-grid');

    function renderGrid() {
        grid.innerHTML = `<div class="stream-grid">${sortResolved(currentResolved).map(r => renderFavoriteCard(r.fav, r.liveData)).join('')}</div>`;
    }

    // Only fetch live status if cache is stale
    if (!isCacheFresh) {
        const resolvedMap = new Map(currentResolved.map(r => [r.fav.slug, r]));

        // Fetch all statuses, then do ONE re-render at the end (no per-card flashing)
        Promise.allSettled(
            favorites.map(fav =>
                fetchLiveStatus(fav.slug).then(r => {
                    const entry = resolvedMap.get(fav.slug);
                    if (entry) entry.liveData = r;
                }).catch(() => {})
            )
        ).then(() => {
            currentResolved = [...resolvedMap.values()];
            _cachedResults = currentResolved;
            _cachedAt = Date.now();
            renderGrid();
        });
    }

    // Click delegation
    const handleGridClick = (e) => {
        const unfavBtn = e.target.closest('[data-action="unfavorite"]');
        if (unfavBtn) {
            e.stopPropagation();
            const slug = unfavBtn.dataset.slug;
            if (slug) {
                removeFavorite(slug);
                updateFavoritesBadge();
                // Remove card in-place — no full re-render
                const card = unfavBtn.closest('.stream-card');
                if (card) card.remove();
                currentResolved = currentResolved.filter(r => r.fav.slug !== slug);
                _cachedResults = currentResolved;
                const countEl = contentEl.querySelector('.section-count');
                if (countEl) countEl.textContent = currentResolved.length > 0 ? `(${currentResolved.length})` : '';
                if (currentResolved.length === 0) {
                    _cachedResults = null;
                    grid.innerHTML = `<div class="empty-state">
                        <div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg></div>
                        <div class="empty-state-title">No favorites yet</div>
                        <div class="empty-state-text">Browse streams and click the heart icon to add channels to your favorites.</div>
                        <a href="#/browse" class="btn-primary" style="margin-top:16px;display:inline-flex">Browse Streams</a>
                    </div>`;
                    contentEl.querySelector('.section-count')?.remove();
                }
            }
            return;
        }
        const card = e.target.closest('.stream-card');
        if (card) navigate(`/channel/${card.dataset.slug}`);
    };
    grid.addEventListener('click', handleGridClick);

    const onFavChange = () => {
        const newFavs = getFavorites();
        if (newFavs.length !== currentResolved.length) {
            const slugs = new Set(newFavs.map(f => f.slug));
            currentResolved = currentResolved.filter(r => slugs.has(r.fav.slug));
            _cachedResults = currentResolved;
            renderGrid();
        }
    };
    window.addEventListener('favorites-changed', onFavChange);

    return () => {
        grid.removeEventListener('click', handleGridClick);
        window.removeEventListener('favorites-changed', onFavChange);
    };
}
