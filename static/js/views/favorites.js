/**
 * Favorites view — shows favorited channels with live status.
 * Renders instantly from cache/localStorage, fetches live data once,
 * then does a single sorted re-render (no flashing).
 */

import { getFavorites, removeFavorite, addFavorite } from '../favorites.js';
import { fetchLiveStatus } from '../api.js';
import { escapeHtml, initialsAvatar, formatViewerCount } from '../utils.js';
import { navigate } from '../router.js';
import { updateFavoritesBadge } from '../ui.js';
import { toast } from '../toast.js';

// Module-level cache so returning to the tab is instant
let _cachedResults = null;   // [{fav, liveData}, ...]
let _cachedAt = 0;           // timestamp of last fetch
const CACHE_FRESH_MS = 60_000; // 60s — don't re-fetch if cache is recent

function getFavoriteCardState(fav, liveStatus = null) {
    const isLive = liveStatus?.data?.status === 'live';
    const isPending = liveStatus === null;
    const d = liveStatus?.data;
    const channelName = fav.username || fav.slug;
    const title = isLive
        ? (d?.livestream_title || channelName)
        : channelName;

    return {
        isLive,
        isPending,
        thumbSrc: isLive
            ? (d?.livestream_thumbnail_url || fav.profilePicture || '')
            : (fav.profilePicture || ''),
        viewers: isLive ? d?.livestream_viewer_count : null,
        title,
        category: isLive ? (d?.livestream_category || '') : '',
        statusLabel: isLive ? 'LIVE' : (isPending ? 'Checking' : 'Offline'),
        ariaLabel: channelName + (isLive ? `, Live, ${d?.livestream_title || channelName}` : (isPending ? ', Checking live status' : ', Offline')),
    };
}

function getFavoriteCardKey(fav, state) {
    return [
        state.isLive ? 'live' : 'offline',
        state.isPending ? 'pending' : 'ready',
        state.thumbSrc || '',
        state.viewers ?? '',
        state.title || '',
        state.category || '',
        fav.profilePicture || '',
    ].join('|');
}

function renderFavoriteCardBody(fav, state) {
    const avatarHTML = fav.profilePicture
        ? `<img src="${escapeHtml(fav.profilePicture)}" alt="" class="card-avatar" loading="lazy" decoding="async">`
        : initialsAvatar(fav.username || fav.slug);
    const bodyAriaLabel = `${state.ariaLabel}${state.viewers != null ? ', ' + formatViewerCount(state.viewers) + ' viewers' : ''}`;

    // On thumbnail load failure: fall back to the profile picture if we have
    // one, otherwise hide the <img> — never set src='' (which resolves to the
    // page URL and renders a broken-image glyph).
    const thumbOnError = fav.profilePicture
        ? `this.onerror=null;this.src='${escapeHtml(fav.profilePicture)}';this.style.objectFit='contain';this.classList.add('loaded');`
        : `this.onerror=null;this.style.display='none';`;

    return `
            <a class="stream-card-link" href="#/channel/${encodeURIComponent(fav.slug)}" aria-label="${escapeHtml(bodyAriaLabel)}"></a>
            <div class="card-thumbnail">
                ${state.thumbSrc ? `<img src="${escapeHtml(state.thumbSrc)}" alt="${escapeHtml(fav.username || fav.slug)} stream thumbnail" class="thumb-fade" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="${thumbOnError}">` : `<div class="favorite-thumb-placeholder ${state.isPending ? 'pending' : ''}">${state.statusLabel}</div>`}
                <div class="card-uptime-badge ${state.isLive ? '' : 'card-uptime-badge--muted'}">${state.isLive ? '<span class="card-live-dot"></span>' : ''}${state.statusLabel}</div>
                ${state.viewers != null ? `<div class="card-viewers"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>${formatViewerCount(state.viewers)}</div>` : ''}
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
                    <div class="card-title">${escapeHtml(state.title)}</div>
                    ${state.category ? `<span class="card-category">${escapeHtml(state.category)}</span>` : ''}
                </div>
            </div>
    `;
}

function renderFavoriteCard(fav, liveStatus = null) {
    const state = getFavoriteCardState(fav, liveStatus);
    const cardKey = getFavoriteCardKey(fav, state);
    return `
        <article class="stream-card" data-slug="${escapeHtml(fav.slug)}" data-card-key="${escapeHtml(cardKey)}">${renderFavoriteCardBody(fav, state)}</article>`;
}

function renderFavoritesEmptyState() {
    return `<div class="empty-state">
        <div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg></div>
        <div class="empty-state-title">No favorites yet</div>
        <div class="empty-state-text">Browse streams and click the heart icon to add channels to your favorites.</div>
        <a href="#/browse" class="btn-primary" style="margin-top:16px;display:inline-flex">Browse Streams</a>
    </div>`;
}

function syncFavoriteGrid(grid, resolved) {
    if (!grid) return;
    const ordered = sortResolved(resolved);
    const existing = new Map();
    grid.querySelectorAll('.stream-card[data-slug]').forEach(card => {
        existing.set(card.dataset.slug, card);
    });

    const seen = new Set();
    ordered.forEach((entry, index) => {
        const slug = entry.fav.slug;
        const state = getFavoriteCardState(entry.fav, entry.liveData);
        const cardKey = getFavoriteCardKey(entry.fav, state);
        let card = existing.get(slug);
        if (card) {
            if (card.dataset.cardKey !== cardKey) {
                card.setAttribute('aria-label', `${state.ariaLabel}${state.viewers != null ? ', ' + formatViewerCount(state.viewers) + ' viewers' : ''}`);
                card.dataset.cardKey = cardKey;
                card.innerHTML = renderFavoriteCardBody(entry.fav, state);
            }
        } else {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = renderFavoriteCard(entry.fav, entry.liveData);
            card = wrapper.firstElementChild;
        }
        seen.add(slug);
        if (card) card.dataset.cardKey = cardKey;
        if (grid.children[index] !== card) {
            grid.insertBefore(card, grid.children[index] || null);
        }
    });

    existing.forEach((card, slug) => {
        if (!seen.has(slug)) card.remove();
    });
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
                <div class="favorites-empty-state">
                    ${renderFavoritesEmptyState()}
                </div>
                <div class="stream-grid hidden"></div>
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
            <div class="favorites-empty-state hidden">
                ${renderFavoritesEmptyState()}
            </div>
            <div class="stream-grid">${sortResolved(currentResolved).map(r => renderFavoriteCard(r.fav, r.liveData)).join('')}</div>
        </div>`;

    let grid = contentEl.querySelector('#favorites-grid .stream-grid');
    const emptyStateEl = contentEl.querySelector('#favorites-grid .favorites-empty-state');
    let suppressNextFavoritesChange = false;

    function renderGrid() {
        if (currentResolved.length === 0) {
            if (grid) grid.innerHTML = '';
            if (emptyStateEl) emptyStateEl.classList.remove('hidden');
            if (grid) grid.classList.add('hidden');
            return;
        }
        if (!grid) {
            grid = contentEl.querySelector('#favorites-grid .stream-grid');
        }
        if (emptyStateEl) emptyStateEl.classList.add('hidden');
        if (grid) grid.classList.remove('hidden');
        syncFavoriteGrid(grid, currentResolved);
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

    // Click delegation — the overlay <a> inside each card handles navigation
    // natively, so we only need to intercept the unfavorite button here.
    const handleGridClick = (e) => {
        const unfavBtn = e.target.closest('[data-action="unfavorite"]');
        if (unfavBtn) {
            e.preventDefault();
            e.stopPropagation();
            const slug = unfavBtn.dataset.slug;
            if (slug) {
                const removed = currentResolved.find(r => r.fav.slug === slug);
                suppressNextFavoritesChange = true;
                removeFavorite(slug);
                updateFavoritesBadge();
                const card = unfavBtn.closest('.stream-card');
                if (card) card.remove();
                currentResolved = currentResolved.filter(r => r.fav.slug !== slug);
                _cachedResults = currentResolved;
                const countEl = contentEl.querySelector('.section-count');
                if (countEl) countEl.textContent = currentResolved.length > 0 ? `(${currentResolved.length})` : '';
                if (currentResolved.length === 0) {
                    _cachedResults = null;
                    contentEl.querySelector('.section-count')?.remove();
                    renderGrid();
                }
                // Offer an Undo — mirrors history removal so an accidental tap
                // (easy on touch) isn't silent, irreversible data loss.
                const fav = removed?.fav;
                toast(`Removed ${fav?.username || slug} from favorites`, 'info', {
                    action: {
                        label: 'Undo',
                        onClick: () => {
                            if (!fav) return;
                            suppressNextFavoritesChange = true;
                            addFavorite(fav.slug, fav.username, fav.profilePicture);
                            if (!currentResolved.some(r => r.fav.slug === fav.slug)) {
                                currentResolved.push(removed);
                            }
                            _cachedResults = currentResolved;
                            updateFavoritesBadge();
                            renderGrid();
                        },
                    },
                });
            }
        }
    };
    grid.addEventListener('click', handleGridClick);

    const onFavChange = () => {
        if (suppressNextFavoritesChange) {
            suppressNextFavoritesChange = false;
            return;
        }
        const newFavs = getFavorites();
        const resolvedMap = new Map(currentResolved.map(r => [r.fav.slug, r]));
        currentResolved = newFavs.map(fav => resolvedMap.get(fav.slug) || { fav, liveData: null });
        _cachedResults = currentResolved;
        renderGrid();
    };
    window.addEventListener('favorites-changed', onFavChange);

    return () => {
        grid.removeEventListener('click', handleGridClick);
        window.removeEventListener('favorites-changed', onFavChange);
    };
}
