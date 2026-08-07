/**
 * UI rendering module — card-based grids instead of tables.
 */

import { escapeHtml, safeUrl, formatDuration, formatDate, formatViewerCount, formatUptime, initialsAvatar, copyToClipboard } from './utils.js';
import { appState, vodsSortState, featuredSortState } from './state.js';
import { castStream } from './chromecast_logic.js';
import { isFavorite, toggleFavorite } from './favorites.js';
import { navigate } from './router.js';

const VERIFIED_BADGE_SVG = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 2.5 19.2 5.7V12c0 4.7-2.8 8.6-7.2 10.3C7.6 20.6 4.8 16.7 4.8 12V5.7Z" fill="currentColor" stroke="rgba(6, 13, 8, 0.58)" stroke-width="1.2" stroke-linejoin="round"/>
        <path d="M8.15 12.1 10.7 14.65 15.85 9.45" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

function renderVerifiedBadge(modifier = '') {
    return `<span class="verified-badge${modifier ? ` ${modifier}` : ''}" title="Verified" aria-label="Verified" role="img">${VERIFIED_BADGE_SVG}</span>`;
}

function socialHref(platform, rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) return '#';
    if (/^https?:\/\//i.test(value)) return safeUrl(value);

    const handle = value.replace(/^@/, '').replace(/^\/+|\/+$/g, '');
    const builders = {
        instagram: v => `https://www.instagram.com/${v}`,
        twitter: v => `https://x.com/${v}`,
        youtube: v => `https://www.youtube.com/${v.startsWith('@') ? v : `@${v}`}`,
        discord: v => /^discord\.(?:gg|com)\//i.test(v) ? `https://${v}` : `https://discord.gg/${v}`,
        tiktok: v => `https://www.tiktok.com/@${v.replace(/^@/, '')}`,
    };
    return safeUrl(builders[platform]?.(handle) || '#');
}

// ── Skeleton Loaders ──────────────────────────────────────────────────────

export function renderCardSkeleton(count = 8) {
    let html = '';
    for (let i = 0; i < count; i++) {
        html += `
            <div class="skeleton-card" style="animation-delay:${i * 0.05}s">
                <div class="skeleton-thumb"></div>
                <div style="padding:12px;display:flex;gap:10px">
                    <div class="skeleton-circle"></div>
                    <div style="flex:1">
                        <div class="skeleton-bar skeleton-bar--wide" style="margin-bottom:6px"></div>
                        <div class="skeleton-bar skeleton-bar--medium" style="margin-bottom:4px"></div>
                        <div class="skeleton-bar skeleton-bar--short"></div>
                    </div>
                </div>
            </div>`;
    }
    return html;
}

export function renderProfileSkeleton() {
    return `
        <div class="skeleton-card" style="border-radius:var(--radius-lg)">
            <div class="skeleton-thumb" style="height:200px;aspect-ratio:auto"></div>
        </div>
        <div style="display:flex;gap:16px;margin-top:-48px;position:relative;z-index:1;padding:0 8px">
            <div class="skeleton-circle" style="width:96px;height:96px;border:4px solid var(--bg-color)"></div>
            <div style="flex:1;padding-top:52px">
                <div class="skeleton-bar skeleton-bar--medium" style="height:20px;margin-bottom:8px"></div>
                <div class="skeleton-bar skeleton-bar--short"></div>
            </div>
        </div>`;
}

// Skeleton grid for the VOD / Clip tabs while their data loads — reuses the
// stream-card skeleton (shimmer is transform-based, Safari-safe).
export function renderVodSkeleton(count = 6) {
    let html = '';
    for (let i = 0; i < count; i++) {
        html += `
            <div class="skeleton-card" style="animation-delay:${i * 0.05}s">
                <div class="skeleton-thumb"></div>
                <div style="padding:12px">
                    <div class="skeleton-bar skeleton-bar--wide" style="margin-bottom:8px"></div>
                    <div class="skeleton-bar skeleton-bar--short"></div>
                </div>
            </div>`;
    }
    return `<div class="vod-grid">${html}</div>`;
}

// Reusable error state — used by the router error boundary and per-view
// failures. The retry button is found via [data-error-retry] by the caller.
export function renderErrorState(title = 'Something went wrong', message = '', { retry = true } = {}) {
    return `
        <div class="empty-state error-state">
            <div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
            <div class="empty-state-title">${escapeHtml(title)}</div>
            ${message ? `<div class="empty-state-text">${escapeHtml(message)}</div>` : ''}
            ${retry ? `<button type="button" class="btn-primary" data-error-retry style="margin-top:16px">Try again</button>` : ''}
        </div>`;
}

// ── Stream Card ───────────────────────────────────────────────────────────

export function renderStreamCard(stream, { showActions = true } = {}) {
    const slug = stream.channel?.slug || stream.slug || '';
    const username = stream.channel?.user?.username || slug;
    const title = stream.session_title || username || 'Live Stream';
    const category = stream.categories?.[0]?.name || '';
    const viewers = stream.viewer_count;
    const thumbSrc = stream.thumbnail?.src || '';
    const profilePic = stream.channel?.user?.profilepic || '';
    const playbackUrl = stream.playback_url || stream.channel?.playback_url || `/streams/go/${encodeURIComponent(slug)}`;
    const isFav = isFavorite(slug);

    const avatarHTML = profilePic
        ? `<img src="${escapeHtml(profilePic)}" alt="${escapeHtml(username)}" class="card-avatar" loading="lazy" decoding="async">`
        : initialsAvatar(username);

    const actionsHTML = showActions ? `
        <div class="card-actions-overlay">
            <button class="card-action-btn ${isFav ? 'favorited' : ''}" data-action="favorite" data-slug="${escapeHtml(slug)}" data-username="${escapeHtml(username)}" data-pic="${escapeHtml(profilePic)}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${isFav ? 'Remove' : 'Add'} ${escapeHtml(username)} ${isFav ? 'from' : 'to'} favorites">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
            </button>
            <button type="button" class="card-action-btn cast-button" data-stream-url="${escapeHtml(playbackUrl)}" data-stream-title="${escapeHtml(title)}" title="Cast" aria-label="Cast ${escapeHtml(username)} to Chromecast">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 16.1A5 5 0 015.9 20M2 12.05A9 9 0 019.95 20M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6"/><line x1="2" y1="20" x2="2.01" y2="20"/></svg>
            </button>
        </div>` : '';

    // Thumbnail fallback chain: stream thumb → profile pic → placeholder div.
    // Inline handlers avoid extra JS — the first failure swaps to profilePic;
    // the second failure (rare) drops to the placeholder.
    const thumbFallback = profilePic
        ? `this.onerror=null;this.src='${escapeHtml(profilePic)}';this.style.objectFit='contain';this.classList.add('loaded');`
        : `this.onerror=null;this.style.display='none';`;

    const cardAriaLabel = `${username} — ${title}${viewers != null ? `, ${formatViewerCount(viewers)} viewers` : ''}`;

    // Card pattern: the whole card is wrapped by an absolute-positioned <a>
    // overlay link as a sibling of the action buttons. This gives middle-click
    // "open in new tab", right-click context menu, native Enter activation,
    // and clean screen-reader semantics — none of which a click-delegated
    // div with role="article" could provide. Action buttons sit on a higher
    // z-index so they receive their own clicks without bubbling to the link.
    return `
        <article class="stream-card" data-slug="${escapeHtml(slug)}" data-start-time="${escapeHtml(stream.start_time || '')}">
            <a class="stream-card-link" href="#/channel/${encodeURIComponent(slug)}" aria-label="${escapeHtml(cardAriaLabel)}"></a>
            <div class="card-thumbnail">
                ${thumbSrc ? `<img src="${escapeHtml(thumbSrc)}" alt="" loading="lazy" decoding="async" class="thumb-fade" onload="this.classList.add('loaded')" onerror="${thumbFallback}">` : '<div style="width:100%;height:100%;background:rgba(255,255,255,0.03)"></div>'}
                <div class="card-uptime-badge"><span class="card-live-dot"></span><span class="card-uptime-text">${escapeHtml(formatUptime(stream.start_time) || 'LIVE')}</span></div>
                ${viewers != null ? `<div class="card-viewers" data-count="${viewers}"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg><span class="viewer-num">${formatViewerCount(viewers)}</span></div>` : ''}
                ${actionsHTML}
            </div>
            <div class="card-info">
                ${avatarHTML}
                <div class="card-details">
                    <div class="card-channel">${escapeHtml(username)}</div>
                    <div class="card-title">${escapeHtml(title)}</div>
                    ${category ? `<span class="card-category">${escapeHtml(category)}</span>` : ''}
                </div>
            </div>
        </article>`;
}

// ── Stream List Item ──────────────────────────────────────────────────────

export function renderStreamListItem(stream) {
    const slug = stream.channel?.slug || stream.slug || '';
    const username = stream.channel?.user?.username || slug;
    const title = stream.session_title || username || 'Live Stream';
    const category = stream.categories?.[0]?.name || '';
    const viewers = stream.viewer_count;
    const thumbSrc = stream.thumbnail?.src || '';

    const profilePic = stream.channel?.user?.profilepic || '';
    const playbackUrl = stream.playback_url || stream.channel?.playback_url || `/streams/go/${encodeURIComponent(slug)}`;
    const isFav = isFavorite(slug);
    const listThumbFallback = profilePic
        ? `this.onerror=null;this.src='${escapeHtml(profilePic)}';this.style.objectFit='contain';`
        : `this.onerror=null;this.style.display='none';`;
    const listAriaLabel = `${username} — ${title}${viewers != null ? `, ${formatViewerCount(viewers)} viewers` : ''}`;

    return `
        <article class="stream-list-item" data-slug="${escapeHtml(slug)}">
            <a class="stream-card-link" href="#/channel/${encodeURIComponent(slug)}" aria-label="${escapeHtml(listAriaLabel)}"></a>
            <div class="list-thumb">
                ${thumbSrc ? `<img src="${escapeHtml(thumbSrc)}" alt="" loading="lazy" decoding="async" onerror="${listThumbFallback}">` : ''}
                ${viewers != null ? `<div class="card-viewers" style="position:absolute;top:4px;right:4px;font-size:11px;padding:1px 6px"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>${formatViewerCount(viewers)}</div>` : ''}
                <div class="list-actions-overlay">
                    <button class="card-action-btn ${isFav ? 'favorited' : ''}" data-action="favorite" data-slug="${escapeHtml(slug)}" data-username="${escapeHtml(username)}" data-pic="${escapeHtml(profilePic)}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${isFav ? 'Remove' : 'Add'} ${escapeHtml(username)} ${isFav ? 'from' : 'to'} favorites">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
                    </button>
                    <button type="button" class="card-action-btn cast-button" data-stream-url="${escapeHtml(playbackUrl)}" data-stream-title="${escapeHtml(title)}" title="Cast" aria-label="Cast ${escapeHtml(username)} to Chromecast">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 16.1A5 5 0 015.9 20M2 12.05A9 9 0 019.95 20M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6"/><line x1="2" y1="20" x2="2.01" y2="20"/></svg>
                    </button>
                </div>
            </div>
            <div class="list-info">
                <div class="list-title">${escapeHtml(title)}</div>
                <div class="list-meta">
                    <span>${escapeHtml(username)}</span>
                    ${category ? `<span>${escapeHtml(category)}</span>` : ''}
                    ${viewers != null ? `<span>${formatViewerCount(viewers)} viewers</span>` : ''}
                </div>
            </div>
        </article>`;
}

// ── Stream Grid / List ────────────────────────────────────────────────────

function renderStreamWindowSpacer(options = {}) {
    const height = Math.max(0, Math.round(Number(options.windowSpacerHeight) || 0));
    if (height <= 0) return '';
    return `<div class="stream-window-spacer" aria-hidden="true" style="height:${height}px"></div>`;
}

function interleaveStreamWindowSpacer(items, options = {}) {
    const spacer = renderStreamWindowSpacer(options);
    if (!spacer) return items;
    const index = Math.max(0, Math.min(Number(options.windowSpacerAfter) || 0, items.length));
    const withSpacer = [...items];
    withSpacer.splice(index, 0, spacer);
    return withSpacer;
}

export function renderStreamGrid(streams, viewMode = 'grid', options = {}) {
    if (!streams || streams.length === 0) {
        return `<div class="empty-state">
            <div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div>
            <div class="empty-state-title">No streams found</div>
            <div class="empty-state-text">Try changing the language or category filter.</div>
        </div>`;
    }

    if (viewMode === 'list') {
        const items = interleaveStreamWindowSpacer(streams.map(s => renderStreamListItem(s)), options);
        return `<div class="stream-list">${items.join('')}</div>`;
    }
    const cards = interleaveStreamWindowSpacer(streams.map(s => renderStreamCard(s)), options);
    return `<div class="stream-grid">${cards.join('')}</div>`;
}

// ── VOD Card ──────────────────────────────────────────────────────────────

export function renderVodCard(vod, channelSlug) {
    const safeSlug = encodeURIComponent(channelSlug);
    const safeVodId = encodeURIComponent(vod.vod_id);
    const url = `/streams/vods/${safeSlug}/${safeVodId}`;
    const playbackUrl = vod.source_url || '';

    const safeTitle = escapeHtml(vod.title || 'VOD');
    const cardLabel = escapeHtml(`${vod.title || 'VOD'} — ${formatDate(vod.created_at)}, ${vod.views?.toLocaleString('en-US') || '0'} views`);

    return `
        <article class="vod-card" data-play-vod="${safeVodId}" data-source-url="${url}" data-playback-url="${escapeHtml(playbackUrl)}" data-vod-title="${safeTitle}" data-vod-thumb="${escapeHtml(vod.thumbnail_url || '')}" data-vod-duration="${vod.duration_seconds || ''}" data-vod-date="${escapeHtml(vod.created_at || '')}" data-vod-views="${vod.views || 0}" data-channel-slug="${escapeHtml(channelSlug)}" data-title="${escapeHtml((vod.title || '').toLowerCase())}">
            <button type="button" class="vod-card-play" aria-label="Play ${cardLabel}"></button>
            <div class="vod-card-thumb">
                ${vod.thumbnail_url ? `<img src="${escapeHtml(vod.thumbnail_url)}" alt="${safeTitle} thumbnail" loading="lazy" decoding="async" onerror="this.style.display='none'">` : '<div style="width:100%;height:100%;background:rgba(255,255,255,0.03)"></div>'}
                ${vod.duration_seconds ? `<span class="vod-card-duration">${formatDuration(vod.duration_seconds)}</span>` : ''}
                <div class="card-actions-overlay">
                    <button type="button" class="card-action-btn cast-button" data-stream-url="${escapeHtml(playbackUrl || url)}" data-stream-title="${safeTitle}" title="Cast VOD" aria-label="Cast ${safeTitle} to Chromecast">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 16.1A5 5 0 015.9 20M2 12.05A9 9 0 019.95 20M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6"/><line x1="2" y1="20" x2="2.01" y2="20"/></svg>
                    </button>
                    <a href="${url}" target="_blank" rel="noopener noreferrer" class="card-action-btn" title="Open in new tab" aria-label="Open ${safeTitle} in new tab" onclick="event.stopPropagation()">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>
                </div>
            </div>
            <div class="vod-card-info">
                <div class="vod-card-title">${safeTitle}</div>
                <div class="vod-card-meta">
                    <span>${formatDate(vod.created_at)}</span>
                    <span>${vod.views?.toLocaleString('en-US') || '0'} views</span>
                </div>
            </div>
        </article>`;
}

// ── Clip Card ─────────────────────────────────────────────────────────────

export function renderClipCard(clip) {
    const safeTitle = escapeHtml(clip.title || 'Clip');
    const sourceUrl = escapeHtml(safeUrl(clip.clip_url));
    const playbackUrl = escapeHtml(safeUrl(clip.playback_url || clip.clip_url));
    const cardLabel = escapeHtml(`${clip.title || 'Clip'} — ${formatDate(clip.created_at)}, ${clip.views?.toLocaleString('en-US') || '0'} views`);

    return `
        <article class="vod-card" data-play-clip="true" data-clip-url="${playbackUrl}" data-clip-source-url="${sourceUrl}" data-clip-title="${safeTitle}" data-clip-thumb="${escapeHtml(clip.thumbnail_url || '')}" data-clip-duration="${clip.duration_seconds || ''}" data-clip-date="${escapeHtml(clip.created_at || '')}" data-clip-views="${clip.views || 0}" data-title="${escapeHtml((clip.title || '').toLowerCase())}">
            <button type="button" class="vod-card-play" aria-label="Play ${cardLabel}"></button>
            <div class="vod-card-thumb">
                ${clip.thumbnail_url ? `<img src="${escapeHtml(clip.thumbnail_url)}" alt="${safeTitle} thumbnail" loading="lazy" decoding="async" onerror="this.style.display='none'">` : '<div style="width:100%;height:100%;background:rgba(255,255,255,0.03)"></div>'}
                ${clip.duration_seconds ? `<span class="vod-card-duration">${formatDuration(clip.duration_seconds)}</span>` : ''}
                <div class="card-actions-overlay">
                    <button type="button" class="card-action-btn cast-button" data-stream-url="${sourceUrl}" data-stream-title="${safeTitle}" title="Cast Clip" aria-label="Cast ${safeTitle} to Chromecast">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 16.1A5 5 0 015.9 20M2 12.05A9 9 0 019.95 20M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6"/><line x1="2" y1="20" x2="2.01" y2="20"/></svg>
                    </button>
                    <a href="${sourceUrl}" target="_blank" rel="noopener noreferrer" class="card-action-btn" title="Open in new tab" aria-label="Open ${safeTitle} in new tab" onclick="event.stopPropagation()">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>
                </div>
            </div>
            <div class="vod-card-info">
                <div class="vod-card-title">${safeTitle}</div>
                <div class="vod-card-meta">
                    <span>${formatDate(clip.created_at)}</span>
                    <span>${clip.views?.toLocaleString('en-US') || '0'} views</span>
                    ${clip.category_name ? `<span>${escapeHtml(clip.category_name)}</span>` : ''}
                </div>
            </div>
        </article>`;
}

// ── VOD / Clip Inline Player Content ─────────────────────────────────────

export function renderVodPlayerContent(card) {
    const title = card.dataset.vodTitle || 'VOD';
    const sourceUrl = card.dataset.sourceUrl || '';
    const playbackUrl = card.dataset.playbackUrl || sourceUrl;
    const duration = card.dataset.vodDuration;
    const date = card.dataset.vodDate;
    const views = card.dataset.vodViews;

    return `
        <div class="stream-details">
            <div><span class="stream-detail-label">Title: </span><span class="stream-detail-value">${escapeHtml(title)}</span></div>
            ${duration ? `<div><span class="stream-detail-label">Duration: </span><span class="stream-detail-value">${formatDuration(Number(duration))}</span></div>` : ''}
            ${date ? `<div><span class="stream-detail-label">Date: </span><span class="stream-detail-value">${formatDate(date)}</span></div>` : ''}
            ${views ? `<div><span class="stream-detail-label">Views: </span><span class="stream-detail-value">${Number(views).toLocaleString('en-US')}</span></div>` : ''}
        </div>
        <div class="stream-actions">
            <button type="button" class="cast-button" data-stream-url="${escapeHtml(playbackUrl)}" data-stream-title="${escapeHtml(title)}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 16.1A5 5 0 015.9 20M2 12.05A9 9 0 019.95 20M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6"/><line x1="2" y1="20" x2="2.01" y2="20"/></svg>
                Cast
            </button>
            <a href="${escapeHtml(safeUrl(sourceUrl))}" target="_blank" rel="noopener noreferrer" class="btn-secondary">Open in new tab &rarr;</a>
            <button type="button" class="btn-secondary vod-back-btn">Back to list</button>
        </div>`;
}

export function renderClipPlayerContent(card) {
    const title = card.dataset.clipTitle || 'Clip';
    const clipUrl = card.dataset.clipUrl || '';
    const sourceUrl = card.dataset.clipSourceUrl || clipUrl;
    const duration = card.dataset.clipDuration;
    const date = card.dataset.clipDate;
    const views = card.dataset.clipViews;

    return `
        <div class="stream-details">
            <div><span class="stream-detail-label">Title: </span><span class="stream-detail-value">${escapeHtml(title)}</span></div>
            ${duration ? `<div><span class="stream-detail-label">Duration: </span><span class="stream-detail-value">${formatDuration(Number(duration))}</span></div>` : ''}
            ${date ? `<div><span class="stream-detail-label">Date: </span><span class="stream-detail-value">${formatDate(date)}</span></div>` : ''}
            ${views ? `<div><span class="stream-detail-label">Views: </span><span class="stream-detail-value">${Number(views).toLocaleString('en-US')}</span></div>` : ''}
        </div>
        <div class="stream-actions">
            <button type="button" class="cast-button" data-stream-url="${escapeHtml(sourceUrl)}" data-stream-title="${escapeHtml(title)}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 16.1A5 5 0 015.9 20M2 12.05A9 9 0 019.95 20M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6"/><line x1="2" y1="20" x2="2.01" y2="20"/></svg>
                Cast
            </button>
            <a href="${escapeHtml(safeUrl(sourceUrl))}" target="_blank" rel="noopener noreferrer" class="btn-secondary">Open in new tab &rarr;</a>
            <button type="button" class="btn-secondary vod-back-btn">Back to list</button>
        </div>`;
}

// ── VOD / Clip Grids ──────────────────────────────────────────────────────

export function renderVodGrid(vods, channelSlug) {
    if (!vods || vods.length === 0) {
        return '<div class="empty-state"><div class="empty-state-text">No VODs available.</div></div>';
    }
    return `<div class="vod-grid">${vods.map(v => renderVodCard(v, channelSlug)).join('')}</div>`;
}

export function renderClipGrid(clips) {
    if (!clips || clips.length === 0) {
        return '<div class="empty-state"><div class="empty-state-text">No clips available.</div></div>';
    }
    return `<div class="vod-grid">${clips.map(c => renderClipCard(c)).join('')}</div>`;
}

export function syncCardUptimeBadge(badge, startTime) {
    if (!badge || !startTime) return;
    const text = formatUptime(startTime) || 'LIVE';
    const textEl = badge.querySelector('.card-uptime-text');
    if (textEl) {
        if (textEl.textContent !== text) textEl.textContent = text;
        return;
    }

    const dot = badge.querySelector('.card-live-dot');
    const dotHTML = dot ? dot.outerHTML : '<span class="card-live-dot"></span>';
    badge.innerHTML = `${dotHTML}<span class="card-uptime-text">${escapeHtml(text)}</span>`;
}

// ── Channel Profile ───────────────────────────────────────────────────────

export function renderChannelProfile(data, channelSlug, { activeTab = 'stream' } = {}) {
    const d = data;
    const isLive = d?.status === 'live';

    // Banner
    const bannerHTML = d?.banner_image_url
        ? `<div class="profile-banner"><img src="${escapeHtml(d.banner_image_url)}" alt="${escapeHtml(d?.username || channelSlug)} channel banner" decoding="async"><div class="profile-banner-overlay"></div></div>`
        : `<div class="profile-banner"><div class="profile-banner-overlay"></div></div>`;

    // Avatar
    const avatarHTML = d?.profile_picture
        ? `<img src="${escapeHtml(d.profile_picture)}" alt="${escapeHtml(d.username || channelSlug)}" decoding="async">`
        : initialsAvatar(d?.username || channelSlug, true);

    // Followers
    const followersHTML = d?.followers_count
        ? `<div class="profile-followers">${Number(d.followers_count).toLocaleString('en-US')} followers</div>`
        : '';

    // Social links
    const socialPlatforms = [
        { key: 'instagram', label: 'Instagram', icon: 'IG' },
        { key: 'twitter', label: 'Twitter / X', icon: 'X' },
        { key: 'youtube', label: 'YouTube', icon: 'YT' },
        { key: 'discord', label: 'Discord', icon: 'DC' },
        { key: 'tiktok', label: 'TikTok', icon: 'TT' },
    ];
    const socials = d?.social_links || {};
    const socialsHTML = socialPlatforms
        .filter(p => socials[p.key])
        .map(p => `<a class="social-pill" href="${escapeHtml(socialHref(p.key, socials[p.key]))}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(p.label)}">${p.icon}: <strong>${escapeHtml(socials[p.key])}</strong><span aria-hidden="true">↗</span></a>`)
        .join('');

    // Categories
    const categoriesHTML = (d?.recent_categories || [])
        .map(c => `<span class="category-tag">${escapeHtml(c)}</span>`)
        .join('');

    // Favorite button
    const isFav = isFavorite(channelSlug);

    const tabs = ['stream', 'vods', 'clips'];
    const tabLabels = { stream: 'Stream', vods: 'VODs', clips: 'Clips' };
    // Keep the dock in the DOM for live partial responses, but only reveal it
    // once the background profile refresh supplies a usable chatroom ID.
    const liveChatHTML = isLive ? `
        <aside id="channel-chat-dock" class="channel-chat-dock" aria-labelledby="channel-chat-title">
            <header class="channel-chat-header">
                <div class="channel-chat-heading">
                    <div class="channel-chat-kicker"><span class="viewer-live-dot"></span> On air</div>
                    <h2 id="channel-chat-title">Live chat</h2>
                </div>
                <span id="channel-chat-status" class="channel-chat-status" data-state="connecting">Connecting</span>
            </header>
            <div id="channel-chat-messages" class="channel-chat-messages" role="log" aria-label="${escapeHtml(d?.username || channelSlug)} live chat messages" aria-live="off">
                <div id="channel-chat-empty" class="channel-chat-empty">
                    <span class="channel-chat-loader" aria-hidden="true"></span>
                    Connecting to chat…
                </div>
            </div>
            <button id="channel-chat-new" class="channel-chat-new hidden" type="button">New messages ↓</button>
            <footer class="channel-chat-footer">
                <span>Read-only preview</span>
                <a href="https://kick.com/popout/${encodeURIComponent(channelSlug)}/chat" target="_blank" rel="noopener noreferrer">
                    Join on KICK <span aria-hidden="true">↗</span>
                </a>
            </footer>
        </aside>` : '';

    return `
        <div id="channel-watch-stage" class="channel-watch-stage" aria-label="Channel player and live chat">
            <div class="channel-player-column">
                <div id="channel-player-anchor" class="channel-player-anchor"></div>
            </div>
            ${liveChatHTML}
        </div>
        <section class="profile-summary ${isLive ? 'profile-summary-live' : ''}" aria-label="${escapeHtml(d?.username || channelSlug)} channel profile">
            ${bannerHTML}
            <div class="profile-header">
                <div class="profile-avatar-wrap ${isLive ? 'live-ring' : ''}">${avatarHTML}</div>
                <div class="profile-identity">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                        <h1 class="profile-username">${escapeHtml(d?.username || channelSlug)}</h1>
                        ${d?.verified ? renderVerifiedBadge() : ''}
                        <span class="status-badge ${isLive ? 'live' : 'offline'}">${isLive ? 'LIVE' : 'OFFLINE'}</span>
                        <button class="btn-icon favorite-profile-btn ${isFav ? 'favorited' : ''}" data-slug="${escapeHtml(channelSlug)}" data-username="${escapeHtml(d?.username || channelSlug)}" data-pic="${escapeHtml(d?.profile_picture || '')}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${isFav ? 'Remove from favorites' : 'Add to favorites'}">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? 'var(--live-color)' : 'none'}" stroke="${isFav ? 'var(--live-color)' : 'currentColor'}" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
                        </button>
                    </div>
                    ${followersHTML}
                </div>
            </div>

            <div class="profile-about">
                ${d?.bio ? `<p class="profile-bio">"${escapeHtml(d.bio)}"</p>` : ''}
                ${socialsHTML ? `<div class="profile-socials">${socialsHTML}</div>` : ''}
                ${categoriesHTML ? `<div class="profile-section-label">Recent categories</div><div class="category-tags">${categoriesHTML}</div>` : ''}
            </div>
        </section>

        <div class="profile-tabs" role="tablist" aria-label="Channel content">
            ${tabs.map(t => `<button class="profile-tab ${t === activeTab ? 'active' : ''}" data-tab="${t}" role="tab" aria-selected="${t === activeTab}" tabindex="${t === activeTab ? '0' : '-1'}" aria-controls="profile-tab-content" id="tab-${t}">${tabLabels[t]}</button>`).join('')}
        </div>

        <div id="profile-tab-content" role="tabpanel" aria-labelledby="tab-${activeTab}"></div>
    `;
}

// ── Live Stream Tab Content ───────────────────────────────────────────────

export function renderStreamTabContent(data, channelSlug) {
    const d = data;
    const isLive = d?.status === 'live';

    if (!isLive) {
        return `
            <div class="empty-state">
                <div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
                <div class="empty-state-title">Channel is offline</div>
                <div class="empty-state-text">Check back later or browse their VODs and clips.</div>
            </div>
            <div style="text-align:center;margin-top:16px">
                <a href="https://kick.com/${encodeURIComponent(channelSlug)}" target="_blank" rel="noopener noreferrer" class="btn-secondary">View on Kick.com</a>
            </div>`;
    }

    const initialViewerCount = Number(d.livestream_viewer_count);
    const hasInitialViewerCount = Number.isFinite(initialViewerCount) && initialViewerCount >= 0;
    const initialViewerLabel = hasInitialViewerCount ? initialViewerCount.toLocaleString('en-US') : 'N/A';
    const initialViewerData = hasInitialViewerCount ? ` data-last-known-viewer-count="${initialViewerCount}"` : '';

    return `
        <div class="stream-details">
            <div>
                <span class="stream-detail-label">Title: </span>
                <span class="stream-detail-value">${escapeHtml(d.livestream_title || d.username || 'Live Stream')}</span>
            </div>
            <div class="viewer-count">
                <span class="stream-detail-label">Viewers: </span>
                <span id="liveViewerCount" class="stream-detail-value" data-livestream-id="${d.livestream_id || ''}"${initialViewerData}>${initialViewerLabel}</span>
                <span class="viewer-live-dot" title="Updates automatically"></span>
            </div>
            <div>
                <span class="stream-detail-label">Category: </span>
                <span class="stream-detail-value">${escapeHtml(d.livestream_category || 'N/A')}</span>
            </div>
        </div>

        <div class="stream-actions">
            <button class="copy-button" data-url="${escapeHtml(d.playback_url || '')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                Copy Stream URL
            </button>
            <button type="button" class="cast-button" data-stream-url="${escapeHtml(d.playback_url || '')}" data-stream-title="${escapeHtml(d.livestream_title || 'Kick Stream')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 16.1A5 5 0 015.9 20M2 12.05A9 9 0 019.95 20M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6"/><line x1="2" y1="20" x2="2.01" y2="20"/></svg>
                Cast
            </button>
            <a href="/streams/go/${encodeURIComponent(channelSlug)}" target="_blank" rel="noopener noreferrer" class="btn-secondary">
                Open Live Stream &rarr;
            </a>
        </div>`;
}

// ── Search Results ────────────────────────────────────────────────────────

let suggestionSelectedIndex = -1;
let suggestionOnSelect = null;

export function renderSearchResults(results, onSelect) {
    const container = document.getElementById('searchSuggestions');
    if (!container) return;

    if (!results || results.length === 0) {
        container.style.display = 'none';
        return;
    }

    suggestionSelectedIndex = -1;
    suggestionOnSelect = onSelect;

    container.innerHTML = '';
    const frag = document.createDocumentFragment();
    container.setAttribute('role', 'listbox');
    container.setAttribute('aria-label', 'Search results');

    // Header with result count
    const header = document.createElement('div');
    header.className = 'search-suggestions-header';
    header.textContent = `${results.length} channel${results.length !== 1 ? 's' : ''} found`;
    frag.appendChild(header);

    results.forEach((r, idx) => {
        const item = document.createElement('div');
        item.className = 'search-suggestion-item';
        item.dataset.slug = r.slug;
        item.dataset.index = idx;
        item.setAttribute('role', 'option');
        item.setAttribute('id', `search-option-${idx}`);
        item.setAttribute('aria-selected', 'false');
        item.style.animationDelay = `${idx * 30}ms`;

        const liveBadge = r.is_live ? '<span class="suggestion-live"><span class="suggestion-live-dot"></span>LIVE</span>' : '';
        const verifiedBadge = r.verified ? renderVerifiedBadge('verified-badge--suggestion') : '';
        const viewerInfo = r.is_live && r.viewer_count
            ? `<span class="suggestion-viewers"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>${Number(r.viewer_count).toLocaleString('en-US')}</span>` : '';
        const followerInfo = !r.is_live && r.followers_count
            ? `<span class="suggestion-followers">${Number(r.followers_count).toLocaleString('en-US')} followers</span>` : '';
        const categoryPill = r.category
            ? `<span class="suggestion-category">${escapeHtml(r.category)}</span>` : '';
        const avatarRingClass = r.is_live ? ' suggestion-avatar-live' : '';

        item.innerHTML = `
            <div class="suggestion-avatar-wrap${avatarRingClass}">
                ${r.profile_picture
                    ? `<img src="${escapeHtml(r.profile_picture)}" alt="${escapeHtml(r.username || r.slug)}" class="suggestion-avatar" loading="lazy" decoding="async">`
                    : initialsAvatar(r.username || r.slug)}
            </div>
            <div class="suggestion-info">
                <div class="suggestion-name-row">
                    <span class="suggestion-name">${escapeHtml(r.username || r.slug)}</span>
                    ${verifiedBadge}
                    ${liveBadge}
                </div>
                ${r.stream_title ? `<span class="suggestion-title">${escapeHtml(r.stream_title)}</span>` : ''}
                <div class="suggestion-meta-row">
                    ${viewerInfo}${followerInfo}${categoryPill}
                </div>
            </div>`;
        frag.appendChild(item);
    });
    container.appendChild(frag);

    // Delegated click handler — one listener instead of N per-item listeners
    container.onclick = (e) => {
        const item = e.target.closest('.search-suggestion-item');
        if (item?.dataset.slug && suggestionOnSelect) suggestionOnSelect(item.dataset.slug);
    };
    container.style.display = 'block';
    document.getElementById('channelSlugInput')?.setAttribute('aria-expanded', 'true');
}

export function renderSearchLoading() {
    const container = document.getElementById('searchSuggestions');
    if (!container) return;
    container.innerHTML = `<div class="search-suggestions-status">
        <span class="sentinel-spinner-ring"></span>
        <span>Searching channels...</span>
    </div>`;
    container.style.display = 'block';
}

export function renderSearchEmpty() {
    const container = document.getElementById('searchSuggestions');
    if (!container) return;
    container.innerHTML = `<div class="search-suggestions-empty">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <span>No channels found</span>
        <span class="search-empty-hint">Try a different search or press Enter to visit directly</span>
    </div>`;
    container.style.display = 'block';
}

export function handleSuggestionKeydown(event) {
    const container = document.getElementById('searchSuggestions');
    if (!container || container.style.display === 'none') return false;

    const items = container.querySelectorAll('.search-suggestion-item');
    if (items.length === 0) return false;

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        suggestionSelectedIndex = Math.min(suggestionSelectedIndex + 1, items.length - 1);
        updateSuggestionHighlight(items);
        return true;
    }
    if (event.key === 'ArrowUp') {
        event.preventDefault();
        suggestionSelectedIndex = Math.max(suggestionSelectedIndex - 1, -1);
        updateSuggestionHighlight(items);
        return true;
    }
    if (event.key === 'Enter' && suggestionSelectedIndex >= 0 && suggestionSelectedIndex < items.length) {
        event.preventDefault();
        const slug = items[suggestionSelectedIndex].dataset.slug;
        if (slug && suggestionOnSelect) suggestionOnSelect(slug);
        return true;
    }
    return false;
}

function updateSuggestionHighlight(items) {
    items.forEach((item, idx) => {
        const selected = idx === suggestionSelectedIndex;
        item.classList.toggle('highlighted', selected);
        item.setAttribute('aria-selected', String(selected));
    });
    // Update activedescendant on the input so screen readers track selection
    const input = document.getElementById('channelSlugInput');
    if (input) {
        if (suggestionSelectedIndex >= 0 && items[suggestionSelectedIndex]) {
            input.setAttribute('aria-activedescendant', items[suggestionSelectedIndex].id);
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }
    if (suggestionSelectedIndex >= 0 && items[suggestionSelectedIndex]) {
        items[suggestionSelectedIndex].scrollIntoView({ block: 'nearest' });
    }
}

// ── Button Delegation ─────────────────────────────────────────────────────

let delegationInitialized = false;

export function initButtonDelegation() {
    if (delegationInitialized) return;
    delegationInitialized = true;

    // Keyboard activation for focusable cards that AREN'T native controls.
    // Stream cards and list items use an overlay <a> now — the browser handles
    // Enter natively. VOD/Clip cards use an overlay <button>. Only History
    // items (which navigate via JS) need synthetic activation.
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const card = event.target.closest('.history-item');
        if (!card) return;
        if (event.target.closest('.card-action-btn, a, button, .history-remove-btn')) return;
        event.preventDefault();
        const slug = card.dataset.slug;
        if (slug && card.classList.contains('history-item')) {
            navigate(`/channel/${slug}`);
            return;
        }
    });

    document.addEventListener('click', async (event) => {
        // Copy button
        const copyBtn = event.target.closest('.copy-button');
        if (copyBtn) {
            const text = copyBtn.dataset.url;
            copyToClipboard(copyBtn, text);
            return;
        }

        // Cast button (non-card)
        const castBtn = event.target.closest('.cast-button');
        if (castBtn) {
            event.preventDefault();
            castStream(castBtn.dataset.streamUrl, castBtn.dataset.streamTitle);
            return;
        }

        // Card action: favorite
        const favBtn = event.target.closest('[data-action="favorite"]');
        if (favBtn) {
            event.stopPropagation();
            const slug = favBtn.dataset.slug;
            const username = favBtn.dataset.username;
            const pic = favBtn.dataset.pic;
            const added = toggleFavorite(slug, username, pic);
            // Update UI
            const svg = favBtn.querySelector('svg');
            if (svg) {
                svg.setAttribute('fill', added ? 'currentColor' : 'none');
            }
            favBtn.classList.toggle('favorited', added);
            updateFavoritesBadge();
            return;
        }

        // Profile favorite button
        const profileFavBtn = event.target.closest('.favorite-profile-btn');
        if (profileFavBtn) {
            const slug = profileFavBtn.dataset.slug;
            const username = profileFavBtn.dataset.username;
            const pic = profileFavBtn.dataset.pic;
            const added = toggleFavorite(slug, username, pic);
            const svg = profileFavBtn.querySelector('svg');
            if (svg) {
                svg.setAttribute('fill', added ? 'var(--live-color)' : 'none');
                svg.setAttribute('stroke', added ? 'var(--live-color)' : 'currentColor');
            }
            profileFavBtn.classList.toggle('favorited', added);
            updateFavoritesBadge();
            return;
        }

        // Stream cards and list items: the overlay <a class="stream-card-link">
        // handles navigation natively, so no JS click delegation needed here.
        // Action buttons (favorite, cast) above are handled by their own
        // delegated handlers earlier in this function.
    });
}

// ── Seamless Grid Patching ────────────────────────────────────────────────

/**
 * Patch the grid in-place instead of replacing innerHTML.
 * Existing cards are updated (thumbnail crossfade, viewer count, title, category).
 * New cards are appended; removed cards are deleted.
 */
export function patchStreamGrid(container, streams, viewMode, options = {}) {
    if (viewMode === 'list') {
        container.innerHTML = renderStreamGrid(streams, viewMode, options);
        return;
    }
    const gridEl = container.querySelector('.stream-grid');
    if (!gridEl || streams.length === 0) {
        container.innerHTML = renderStreamGrid(streams, viewMode, options);
        return;
    }

    const animateMoves = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cards = [...gridEl.querySelectorAll('.stream-card[data-slug]')];

    // FLIP "First": snapshot current card positions before we reorder, so moved
    // cards can glide from their old spot to the new one instead of teleporting.
    const firstRects = animateMoves ? new Map() : null;
    if (animateMoves) {
        cards.forEach(card => {
            firstRects.set(card.dataset.slug, card.getBoundingClientRect());
        });
    }

    // Map existing cards by slug
    const existing = new Map();
    cards.forEach(card => {
        existing.set(card.dataset.slug, card);
    });

    const newSlugs = new Set(streams.map(s => s.channel?.slug || s.slug || ''));

    // Remove cards no longer present
    let orderedCards = cards.filter(card => {
        const slug = card.dataset.slug;
        if (newSlugs.has(slug)) return true;
        card.remove();
        existing.delete(slug);
        return false;
    });

    // Update or insert in order. Keep a local order array instead of repeatedly
    // querying the DOM while nodes are moving.
    streams.forEach((stream, i) => {
        const slug = stream.channel?.slug || stream.slug || '';
        let card = existing.get(slug);
        if (card) {
            updateCardInPlace(card, stream);
        } else {
            const tmp = document.createElement('div');
            tmp.innerHTML = renderStreamCard(stream);
            card = tmp.firstElementChild;
        }

        const currentIndex = orderedCards.indexOf(card);
        if (currentIndex === i) return;
        if (currentIndex !== -1) orderedCards.splice(currentIndex, 1);

        const before = orderedCards[i] || null;
        gridEl.insertBefore(card, before);
        orderedCards.splice(i, 0, card);
    });

    updateStreamWindowSpacer(gridEl, streams.length, options, orderedCards);

    // FLIP "Last/Invert/Play": slide reordered cards to their new positions.
    if (animateMoves) flipReorder(gridEl, firstRects);
}

function updateStreamWindowSpacer(gridEl, streamCount, options = {}, orderedCards = null) {
    const height = Math.max(0, Math.round(Number(options.windowSpacerHeight) || 0));
    let spacer = gridEl.querySelector('.stream-window-spacer');
    if (height <= 0) {
        spacer?.remove();
        return;
    }
    if (!spacer) {
        spacer = document.createElement('div');
        spacer.className = 'stream-window-spacer';
        spacer.setAttribute('aria-hidden', 'true');
    }
    spacer.style.height = `${height}px`;
    const after = Math.max(0, Math.min(Number(options.windowSpacerAfter) || 0, streamCount));
    const before = orderedCards?.[after] || gridEl.querySelectorAll('.stream-card[data-slug]')[after] || null;
    gridEl.insertBefore(spacer, before);
}

// flipReorder animates every card whose position changed: it's pinned back to
// its previous spot with a transform, then transitioned to identity so it
// glides into place. Freshly-inserted cards (no prior rect) keep their own
// entrance animation. Reorders that don't move a card cost nothing.
function flipReorder(gridEl, firstRects) {
    const movers = [];
    gridEl.querySelectorAll('.stream-card[data-slug]').forEach(card => {
        const prev = firstRects.get(card.dataset.slug);
        if (!prev) return; // newly inserted
        const now = card.getBoundingClientRect();
        const dx = prev.left - now.left;
        const dy = prev.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        movers.push({ card, dx, dy });
    });
    if (movers.length === 0) return;

    // Invert: jump each mover back to where it was, with no transition.
    movers.forEach(({ card, dx, dy }) => {
        card.style.transition = 'none';
        card.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    // Play: next frame, transition the transform away → cards slide to place.
    requestAnimationFrame(() => {
        movers.forEach(({ card }) => {
            card.style.transition = 'transform 0.36s cubic-bezier(0.4, 0, 0.2, 1)';
            card.style.transform = '';
            const cleanup = () => { card.style.transition = ''; card.style.transform = ''; };
            card.addEventListener('transitionend', cleanup, { once: true });
            setTimeout(cleanup, 440); // fallback if transitionend doesn't fire
        });
    });
}

function updateCardInPlace(cardEl, stream) {
    // Thumbnail crossfade
    const thumbImg = cardEl.querySelector('.card-thumbnail > img');
    const newSrc = stream.thumbnail?.src || '';
    if (thumbImg && newSrc && thumbImg.getAttribute('src') !== newSrc) {
        crossfadeThumbnail(thumbImg, newSrc);
    }

    // Uptime badge — recalculate from start_time
    const startTime = stream.start_time || cardEl.dataset.startTime || '';
    if (startTime) {
        cardEl.dataset.startTime = startTime;
        const uptimeBadge = cardEl.querySelector('.card-uptime-badge');
        if (uptimeBadge) syncCardUptimeBadge(uptimeBadge, startTime);
    }

    // Viewer count — animate numerically
    const viewerEl = cardEl.querySelector('.card-viewers');
    if (viewerEl && stream.viewer_count != null) {
        const oldCount = parseInt(viewerEl.dataset.count || '0', 10);
        const newCount = stream.viewer_count;
        if (oldCount !== newCount) {
            viewerEl.dataset.count = newCount;
            animateViewerCount(viewerEl, oldCount, newCount);
        }
    }

    // Title
    const titleEl = cardEl.querySelector('.card-title');
    if (titleEl) {
        const t = stream.session_title || stream.channel?.user?.username || 'Live Stream';
        if (titleEl.textContent !== t) titleEl.textContent = t;
    }

    // Category
    const catEl = cardEl.querySelector('.card-category');
    const newCat = stream.categories?.[0]?.name || '';
    if (catEl && newCat) {
        if (catEl.textContent !== newCat) catEl.textContent = newCat;
    } else if (!catEl && newCat) {
        const details = cardEl.querySelector('.card-details');
        if (details) {
            const span = document.createElement('span');
            span.className = 'card-category';
            span.textContent = newCat;
            details.appendChild(span);
        }
    } else if (catEl && !newCat) {
        catEl.remove();
    }
}

function animateViewerCount(viewerEl, from, to) {
    const numEl = viewerEl.querySelector('.viewer-num');
    if (!numEl) {
        // Fallback: no .viewer-num wrapper (e.g. old card), just update directly
        const svgHTML = viewerEl.querySelector('svg')?.outerHTML || '';
        viewerEl.innerHTML = svgHTML + `<span class="viewer-num">${formatViewerCount(to)}</span>`;
        return;
    }

    const shouldAnimate = !document.documentElement.classList.contains('safari')
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!shouldAnimate) {
        if (numEl._animFrame) cancelAnimationFrame(numEl._animFrame);
        numEl._animFrame = null;
        numEl.textContent = formatViewerCount(to);
        return;
    }

    // Cancel any running animation on this element
    if (numEl._animFrame) cancelAnimationFrame(numEl._animFrame);

    const duration = 600; // ms
    const start = performance.now();
    const diff = to - from;

    function tick(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        // Ease-out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(from + diff * eased);
        numEl.textContent = formatViewerCount(current);
        if (progress < 1) {
            numEl._animFrame = requestAnimationFrame(tick);
        } else {
            numEl._animFrame = null;
        }
    }

    numEl._animFrame = requestAnimationFrame(tick);
}

function crossfadeThumbnail(currentImg, newSrc) {
    if (document.documentElement.classList.contains('safari')
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        currentImg.src = newSrc;
        return;
    }

    const container = currentImg.parentElement;
    // Avoid stacking multiple crossfades
    const pending = container.querySelector('.crossfade-next');
    if (pending) pending.remove();

    const next = new Image();
    next.className = 'crossfade-next';
    next.alt = '';
    next.decoding = 'async';
    next.onload = () => {
        container.appendChild(next);
        requestAnimationFrame(() => {
            next.style.opacity = '1';
        });
        next.addEventListener('transitionend', () => {
            currentImg.src = newSrc;
            next.remove();
        }, { once: true });
        // Fallback removal
        setTimeout(() => { currentImg.src = newSrc; if (next.parentNode) next.remove(); }, 500);
    };
    next.src = newSrc;
}

// ── Favorites Badge ───────────────────────────────────────────────────────

export function updateFavoritesBadge() {
    const badge = document.getElementById('favorites-badge');
    if (!badge) return;
    const { getFavoriteCount } = window.__favModule || {};
    if (!getFavoriteCount) return;
    const count = getFavoriteCount();
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
    // Pulse animation on change — double-RAF avoids forced synchronous reflow
    badge.classList.remove('pulse');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => badge.classList.add('pulse'));
    });
}
