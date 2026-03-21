/**
 * UI rendering module — card-based grids instead of tables.
 */

import { escapeHtml, formatDuration, formatDate, formatViewerCount, formatUptime, initialsAvatar, copyToClipboard } from './utils.js?v=2.3.7';
import { appState, vodsSortState, featuredSortState } from './state.js?v=2.3.7';
import { castStream } from './chromecast_logic.js?v=2.3.7';
import { isFavorite, toggleFavorite } from './favorites.js?v=2.3.7';
import { navigate } from './router.js?v=2.3.7';

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

// ── Stream Card ───────────────────────────────────────────────────────────

export function renderStreamCard(stream, { showActions = true } = {}) {
    const slug = stream.channel?.slug || stream.slug || '';
    const username = stream.channel?.user?.username || slug;
    const title = stream.session_title || 'Untitled Stream';
    const category = stream.categories?.[0]?.name || '';
    const viewers = stream.viewer_count;
    const thumbSrc = stream.thumbnail?.src || '';
    const profilePic = stream.channel?.user?.profilepic || '';
    const playbackUrl = stream.playback_url || stream.channel?.playback_url || '';
    const isFav = isFavorite(slug);

    const avatarHTML = profilePic
        ? `<img src="${escapeHtml(profilePic)}" alt="${escapeHtml(username)}" class="card-avatar" loading="lazy">`
        : initialsAvatar(username);

    const actionsHTML = showActions ? `
        <div class="card-actions-overlay">
            <button class="card-action-btn" data-action="play" data-slug="${escapeHtml(slug)}" title="Watch" aria-label="Watch ${escapeHtml(username)}">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </button>
            <button class="card-action-btn ${isFav ? 'favorited' : ''}" data-action="favorite" data-slug="${escapeHtml(slug)}" data-username="${escapeHtml(username)}" data-pic="${escapeHtml(profilePic)}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${isFav ? 'Remove' : 'Add'} ${escapeHtml(username)} ${isFav ? 'from' : 'to'} favorites">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
            </button>
            <button type="button" class="card-action-btn cast-button" data-stream-url="${escapeHtml(playbackUrl)}" data-stream-title="${escapeHtml(title)}" title="Cast" aria-label="Cast ${escapeHtml(username)} to Chromecast">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 16.1A5 5 0 015.9 20M2 12.05A9 9 0 019.95 20M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6"/><line x1="2" y1="20" x2="2.01" y2="20"/></svg>
            </button>
        </div>` : '';

    return `
        <div class="stream-card" data-slug="${escapeHtml(slug)}">
            <div class="card-thumbnail">
                ${thumbSrc ? `<img src="${escapeHtml(thumbSrc)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">` : '<div style="width:100%;height:100%;background:rgba(255,255,255,0.03)"></div>'}
                <div class="card-uptime-badge"><span class="card-live-dot"></span>${formatUptime(stream.start_time) || 'LIVE'}</div>
                ${viewers != null ? `<div class="card-viewers"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>${formatViewerCount(viewers)}</div>` : ''}
                ${actionsHTML}
            </div>
            <div class="card-info">
                ${avatarHTML}
                <div class="card-details">
                    <div class="card-channel"><a href="#/channel/${encodeURIComponent(slug)}" class="card-channel-link">${escapeHtml(username)}</a></div>
                    <div class="card-title">${escapeHtml(title)}</div>
                    ${category ? `<span class="card-category">${escapeHtml(category)}</span>` : ''}
                </div>
            </div>
        </div>`;
}

// ── Stream List Item ──────────────────────────────────────────────────────

export function renderStreamListItem(stream) {
    const slug = stream.channel?.slug || stream.slug || '';
    const username = stream.channel?.user?.username || slug;
    const title = stream.session_title || 'Untitled Stream';
    const category = stream.categories?.[0]?.name || '';
    const viewers = stream.viewer_count;
    const thumbSrc = stream.thumbnail?.src || '';

    return `
        <div class="stream-list-item" data-slug="${escapeHtml(slug)}">
            <div class="list-thumb">
                ${thumbSrc ? `<img src="${escapeHtml(thumbSrc)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
                ${viewers != null ? `<div class="card-viewers" style="position:absolute;top:4px;right:4px;font-size:11px;padding:1px 6px"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>${formatViewerCount(viewers)}</div>` : ''}
            </div>
            <div class="list-info">
                <div class="list-title">${escapeHtml(title)}</div>
                <div class="list-meta">
                    <span>${escapeHtml(username)}</span>
                    ${category ? `<span>${escapeHtml(category)}</span>` : ''}
                    ${viewers != null ? `<span>${formatViewerCount(viewers)} viewers</span>` : ''}
                </div>
            </div>
        </div>`;
}

// ── Stream Grid / List ────────────────────────────────────────────────────

export function renderStreamGrid(streams, viewMode = 'grid') {
    if (!streams || streams.length === 0) {
        return `<div class="empty-state">
            <div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div>
            <div class="empty-state-title">No streams found</div>
            <div class="empty-state-text">Try changing the language or category filter.</div>
        </div>`;
    }

    if (viewMode === 'list') {
        return `<div class="stream-list">${streams.map(s => renderStreamListItem(s)).join('')}</div>`;
    }
    return `<div class="stream-grid">${streams.map(s => renderStreamCard(s)).join('')}</div>`;
}

// ── VOD Card ──────────────────────────────────────────────────────────────

export function renderVodCard(vod, channelSlug) {
    const safeSlug = encodeURIComponent(channelSlug);
    const safeVodId = encodeURIComponent(vod.vod_id);
    const url = `/streams/vods/${safeSlug}/${safeVodId}`;

    return `
        <a href="${url}" target="_blank" class="vod-card" data-vod-id="${vod.vod_id}">
            <div class="vod-card-thumb">
                ${vod.thumbnail_url ? `<img src="${escapeHtml(vod.thumbnail_url)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">` : '<div style="width:100%;height:100%;background:rgba(255,255,255,0.03)"></div>'}
                ${vod.duration_seconds ? `<span class="vod-card-duration">${formatDuration(vod.duration_seconds)}</span>` : ''}
            </div>
            <div class="vod-card-info">
                <div class="vod-card-title">${escapeHtml(vod.title || 'Untitled VOD')}</div>
                <div class="vod-card-meta">
                    <span>${formatDate(vod.created_at)}</span>
                    <span>${vod.views?.toLocaleString('en-US') || '0'} views</span>
                </div>
            </div>
        </a>`;
}

// ── Clip Card ─────────────────────────────────────────────────────────────

export function renderClipCard(clip) {
    return `
        <a href="${escapeHtml(clip.clip_url || '#')}" target="_blank" class="vod-card">
            <div class="vod-card-thumb">
                ${clip.thumbnail_url ? `<img src="${escapeHtml(clip.thumbnail_url)}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none'">` : '<div style="width:100%;height:100%;background:rgba(255,255,255,0.03)"></div>'}
                ${clip.duration_seconds ? `<span class="vod-card-duration">${formatDuration(clip.duration_seconds)}</span>` : ''}
            </div>
            <div class="vod-card-info">
                <div class="vod-card-title">${escapeHtml(clip.title || 'Untitled Clip')}</div>
                <div class="vod-card-meta">
                    <span>${formatDate(clip.created_at)}</span>
                    <span>${clip.views?.toLocaleString('en-US') || '0'} views</span>
                    ${clip.category_name ? `<span>${escapeHtml(clip.category_name)}</span>` : ''}
                </div>
            </div>
        </a>`;
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

// ── Channel Profile ───────────────────────────────────────────────────────

export function renderChannelProfile(data, channelSlug, { activeTab = 'stream' } = {}) {
    const d = data;
    const isLive = d?.status === 'live';

    // Banner
    const bannerHTML = d?.banner_image_url
        ? `<div class="profile-banner"><img src="${escapeHtml(d.banner_image_url)}" alt=""><div class="profile-banner-overlay"></div></div>`
        : `<div class="profile-banner"><div class="profile-banner-overlay"></div></div>`;

    // Avatar
    const avatarHTML = d?.profile_picture
        ? `<img src="${escapeHtml(d.profile_picture)}" alt="${escapeHtml(d.username || channelSlug)}">`
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
        .map(p => `<span class="social-pill" title="${escapeHtml(p.label)}">${p.icon}: <strong>${escapeHtml(socials[p.key])}</strong></span>`)
        .join('');

    // Categories
    const categoriesHTML = (d?.recent_categories || [])
        .map(c => `<span class="category-tag">${escapeHtml(c)}</span>`)
        .join('');

    // Favorite button
    const isFav = isFavorite(channelSlug);

    const tabs = ['stream', 'vods', 'clips'];

    return `
        ${bannerHTML}
        <div class="profile-header">
            <div class="profile-avatar-wrap ${isLive ? 'live-ring' : ''}">${avatarHTML}</div>
            <div class="profile-identity">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <h2 class="profile-username">${escapeHtml(d?.username || channelSlug)}</h2>
                    ${d?.verified ? '<span class="verified-badge">&#10003;</span>' : ''}
                    <span class="status-badge ${isLive ? 'live' : 'offline'}">${isLive ? 'LIVE' : 'OFFLINE'}</span>
                    <button class="btn-icon favorite-profile-btn ${isFav ? 'favorited' : ''}" data-slug="${escapeHtml(channelSlug)}" data-username="${escapeHtml(d?.username || channelSlug)}" data-pic="${escapeHtml(d?.profile_picture || '')}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFav ? 'var(--live-color)' : 'none'}" stroke="${isFav ? 'var(--live-color)' : 'currentColor'}" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
                    </button>
                </div>
                ${followersHTML}
            </div>
        </div>

        <div style="padding:0 8px;margin-top:16px">
            ${d?.bio ? `<p class="profile-bio">"${escapeHtml(d.bio)}"</p>` : ''}
            ${socialsHTML ? `<div class="profile-socials">${socialsHTML}</div>` : ''}
            ${categoriesHTML ? `<div class="profile-section-label">Recent categories</div><div class="category-tags">${categoriesHTML}</div>` : ''}
        </div>

        <div class="profile-tabs">
            ${tabs.map(t => `<button class="profile-tab ${t === activeTab ? 'active' : ''}" data-tab="${t}">${t === 'stream' ? 'Stream' : t === 'vods' ? 'VODs' : 'Clips'}</button>`).join('')}
        </div>

        <div id="profile-tab-content"></div>
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
        <div class="video-container">
            <video id="liveVideoPlayer" controls muted playsinline
                poster="${escapeHtml(d.livestream_thumbnail_url || '')}">
            </video>
        </div>

        <div class="stream-details">
            <div>
                <span class="stream-detail-label">Title: </span>
                <span class="stream-detail-value">${escapeHtml(d.livestream_title || 'Untitled')}</span>
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
            <a href="/streams/go/${encodeURIComponent(channelSlug)}" target="_blank" class="btn-secondary">
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
    results.forEach((r, idx) => {
        const item = document.createElement('div');
        item.className = 'search-suggestion-item';
        item.dataset.slug = r.slug;
        item.dataset.index = idx;

        const liveBadge = r.is_live ? '<span class="suggestion-live">LIVE</span>' : '';
        const viewerInfo = r.is_live && r.viewer_count
            ? `${Number(r.viewer_count).toLocaleString('en-US')} viewers` : '';
        const followerInfo = !viewerInfo && r.followers_count
            ? `${Number(r.followers_count).toLocaleString('en-US')} followers` : '';
        const metaParts = [viewerInfo || followerInfo, r.category].filter(Boolean).join(' · ');

        item.innerHTML = `
            ${r.profile_picture
                ? `<img src="${escapeHtml(r.profile_picture)}" alt="" class="suggestion-avatar">`
                : initialsAvatar(r.username || r.slug)}
            <div class="suggestion-info">
                <div class="suggestion-name-row">
                    <span class="suggestion-name">${escapeHtml(r.username || r.slug)}</span>
                    ${liveBadge}
                </div>
                ${r.stream_title ? `<span class="suggestion-title">${escapeHtml(r.stream_title)}</span>` : ''}
                ${metaParts ? `<span class="suggestion-meta">${escapeHtml(metaParts)}</span>` : ''}
            </div>`;
        item.addEventListener('click', () => onSelect(r.slug));
        container.appendChild(item);
    });
    container.style.display = 'block';
}

export function renderSearchLoading() {
    const container = document.getElementById('searchSuggestions');
    if (!container) return;
    container.innerHTML = '<div class="search-suggestions-spinner"><span class="sentinel-spinner-ring"></span> Searching channels...</div>';
    container.style.display = 'block';
}

export function renderSearchEmpty() {
    const container = document.getElementById('searchSuggestions');
    if (!container) return;
    container.innerHTML = '<div class="search-suggestions-empty">No channels found</div>';
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
        item.classList.toggle('highlighted', idx === suggestionSelectedIndex);
    });
    if (suggestionSelectedIndex >= 0 && items[suggestionSelectedIndex]) {
        items[suggestionSelectedIndex].scrollIntoView({ block: 'nearest' });
    }
}

// ── Button Delegation ─────────────────────────────────────────────────────

let delegationInitialized = false;

export function initButtonDelegation() {
    if (delegationInitialized) return;
    delegationInitialized = true;

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

        // Card action: play
        const playBtn = event.target.closest('[data-action="play"]');
        if (playBtn) {
            event.stopPropagation();
            const slug = playBtn.dataset.slug;
            if (slug) navigate(`/channel/${slug}`);
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

        // Stream card click -> navigate to channel
        const card = event.target.closest('.stream-card');
        if (card && !event.target.closest('.card-action-btn') && !event.target.closest('a')) {
            const slug = card.dataset.slug;
            if (slug) navigate(`/channel/${slug}`);
            return;
        }

        // Stream list item click -> navigate to channel
        const listItem = event.target.closest('.stream-list-item');
        if (listItem) {
            const slug = listItem.dataset.slug;
            if (slug) navigate(`/channel/${slug}`);
            return;
        }
    });
}

// ── Seamless Grid Patching ────────────────────────────────────────────────

/**
 * Patch the grid in-place instead of replacing innerHTML.
 * Existing cards are updated (thumbnail crossfade, viewer count, title, category).
 * New cards are appended; removed cards are deleted.
 */
export function patchStreamGrid(container, streams, viewMode) {
    if (viewMode === 'list') {
        container.innerHTML = renderStreamGrid(streams, viewMode);
        return;
    }
    const gridEl = container.querySelector('.stream-grid');
    if (!gridEl || streams.length === 0) {
        container.innerHTML = renderStreamGrid(streams, viewMode);
        return;
    }

    // Map existing cards by slug
    const existing = new Map();
    gridEl.querySelectorAll('.stream-card[data-slug]').forEach(card => {
        existing.set(card.dataset.slug, card);
    });

    const newSlugs = new Set(streams.map(s => s.channel?.slug || s.slug || ''));

    // Remove cards no longer present
    existing.forEach((card, slug) => {
        if (!newSlugs.has(slug)) { card.remove(); existing.delete(slug); }
    });

    // Update or insert in order
    streams.forEach((stream, i) => {
        const slug = stream.channel?.slug || stream.slug || '';
        const card = existing.get(slug);
        if (card) {
            updateCardInPlace(card, stream);
            // Ensure correct position
            if (gridEl.children[i] !== card) gridEl.insertBefore(card, gridEl.children[i]);
        } else {
            const tmp = document.createElement('div');
            tmp.innerHTML = renderStreamCard(stream);
            const newCard = tmp.firstElementChild;
            if (gridEl.children[i]) {
                gridEl.insertBefore(newCard, gridEl.children[i]);
            } else {
                gridEl.appendChild(newCard);
            }
        }
    });
}

function updateCardInPlace(cardEl, stream) {
    // Thumbnail crossfade
    const thumbImg = cardEl.querySelector('.card-thumbnail > img');
    const newSrc = stream.thumbnail?.src || '';
    if (thumbImg && newSrc && thumbImg.getAttribute('src') !== newSrc) {
        crossfadeThumbnail(thumbImg, newSrc);
    }

    // Viewer count
    const viewerEl = cardEl.querySelector('.card-viewers');
    if (viewerEl && stream.viewer_count != null) {
        const svgHTML = viewerEl.querySelector('svg')?.outerHTML || '';
        const newText = svgHTML + formatViewerCount(stream.viewer_count);
        if (viewerEl.innerHTML !== newText) viewerEl.innerHTML = newText;
    }

    // Title
    const titleEl = cardEl.querySelector('.card-title');
    if (titleEl) {
        const t = stream.session_title || 'Untitled Stream';
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

function crossfadeThumbnail(currentImg, newSrc) {
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
    // Pulse animation on change
    badge.classList.remove('pulse');
    void badge.offsetWidth; // reflow to re-trigger
    badge.classList.add('pulse');
}
