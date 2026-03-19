import { formatDuration, formatDate, copyToClipboard, escapeHtml, initialsAvatar } from "./utils.js";
import { sortVodsTable, sortFeaturedStreamsTable } from './sorting.js';
import { appState, vodsSortState, featuredSortState } from './state.js';
import { castStream } from './chromecast_logic.js';
import { fetchChannelData } from './api.js';

// Module-level state for clips search
let currentClips = [];
let currentClipsChannelSlug = '';

// Stop the shimmer animation the instant a thumbnail finishes loading.
// load events on <img> don't bubble, so we use the capture phase.
document.addEventListener('load', (e) => {
    if (e.target.classList?.contains('vod-thumbnail')) {
        e.target.style.animation = 'none';
        e.target.style.backgroundImage = 'none';
    }
}, true);

// Module-level state for VOD search (fixes stale closure)
let currentVods = [];
let currentChannelSlug = '';

// HLS player instance — destroyed on clearPreviousData
let hlsInstance = null;

const FEATURED_ROW_MOVE_DURATION_MS = 260;
const FEATURED_ROW_ENTRY_DURATION_MS = 220;
const FEATURED_ROW_MOVE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

function initVideoPlayer(playbackUrl) {
    const video = document.getElementById('liveVideoPlayer');
    if (!video || !playbackUrl) return;

    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

    // Prefer native HLS (Safari) — avoids CORS restrictions that block HLS.js XHR requests.
    // The Kick CDN only allows kick.com origins, so HLS.js fails on local IP.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = playbackUrl;
        video.play().catch(() => {/* autoplay blocked — user can press play */});
    } else if (window.Hls && window.Hls.isSupported()) {
        hlsInstance = new window.Hls({ lowLatencyMode: true, maxBufferLength: 30 });
        hlsInstance.loadSource(playbackUrl);
        hlsInstance.attachMedia(video);
        hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(() => {});
        });
    }
}

export function destroyVideoPlayer() {
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    const video = document.getElementById('liveVideoPlayer');
    if (video) { video.pause(); video.src = ''; video.load(); }
}

let messageTimer = null;

export function showMessage(message, type, retryCallback = null) {
    const statusMessage = document.getElementById('statusMessage');
    statusMessage.textContent = message;
    statusMessage.className = `message ${type}`;
    statusMessage.style.display = 'block';

    if (retryCallback && type === 'error') {
        const retryBtn = document.createElement('button');
        retryBtn.textContent = 'Retry';
        retryBtn.className = 'retry-button';
        retryBtn.addEventListener('click', () => {
            statusMessage.style.display = 'none';
            retryCallback();
        });
        statusMessage.appendChild(retryBtn);
    }

    if (messageTimer) clearTimeout(messageTimer);
    // Don't auto-dismiss errors with retry buttons
    if (!retryCallback || type !== 'error') {
        messageTimer = setTimeout(() => {
            statusMessage.style.display = 'none';
        }, 5000);
    }
}

export function showLoadingIndicator() {
    document.getElementById('loading-indicator').style.display = 'flex';
}

export function hideLoadingIndicator() {
    document.getElementById('loading-indicator').style.display = 'none';
}

export function clearPreviousData() {
    destroyVideoPlayer();
    ['liveStreamInfo', 'vodsList', 'clipsList'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.style.display = 'none'; el.innerHTML = ''; }
    });
    // Hide search suggestions
    const sugg = document.getElementById('searchSuggestions');
    if (sugg) sugg.style.display = 'none';
}

export function renderLiveStreamInfo(response, channelSlug) {
    const liveStreamInfo = document.getElementById('liveStreamInfo');

    const isSuccess = response.status === 'success';
    const isLive = isSuccess && response.data?.status === 'live';
    const isOffline = isSuccess && response.data?.status === 'offline';
    const d = (isLive || isOffline) ? response.data : null;

    let content = '';

    if (d) {
        // ── Banner ──────────────────────────────────────────────────────────
        const bannerStyle = d.banner_image_url
            ? ` style="background-image:url('${escapeHtml(d.banner_image_url)}')"`
            : '';

        // ── Avatar ──────────────────────────────────────────────────────────
        const avatarHTML = d.profile_picture
            ? `<img class="profile-avatar-img" src="${escapeHtml(d.profile_picture)}" alt="${escapeHtml(d.username || channelSlug)}">`
            : initialsAvatar(d.username || channelSlug, true);

        // ── Followers ───────────────────────────────────────────────────────
        const followersHTML = d.followers_count
            ? `<div class="profile-followers">${Number(d.followers_count).toLocaleString('en-US')} followers</div>`
            : '';

        // ── Social links ────────────────────────────────────────────────────
        const socialPlatforms = [
            { key: 'instagram', label: 'Instagram' },
            { key: 'twitter',   label: 'Twitter / X' },
            { key: 'youtube',   label: 'YouTube' },
            { key: 'discord',   label: 'Discord' },
            { key: 'tiktok',    label: 'TikTok' },
        ];
        const socials = d.social_links || {};
        const socialsHTML = socialPlatforms
            .filter(p => socials[p.key])
            .map(p => `<span class="social-link" title="${escapeHtml(p.label)}: ${escapeHtml(socials[p.key])}">${escapeHtml(p.label)}: <strong>${escapeHtml(socials[p.key])}</strong></span>`)
            .join('');

        // ── Recent categories ────────────────────────────────────────────────
        const categoriesHTML = (d.recent_categories || [])
            .map(c => `<span class="category-tag">${escapeHtml(c)}</span>`)
            .join('');

        // ── Live-only block ──────────────────────────────────────────────────
        const initialViewerCount = Number(d.livestream_viewer_count);
        const hasInitialViewerCount = Number.isFinite(initialViewerCount) && initialViewerCount > 0;
        const initialViewerLabel = Number.isFinite(initialViewerCount)
            ? initialViewerCount.toLocaleString('en-US')
            : 'N/A';
        const initialViewerData = hasInitialViewerCount
            ? ` data-last-known-viewer-count="${initialViewerCount}"`
            : '';

        const liveBlock = isLive ? `
            <div class="live-player-wrapper">
                <video id="liveVideoPlayer" class="live-video-player" controls muted playsinline
                    poster="${escapeHtml(d.livestream_thumbnail_url || '')}">
                </video>
            </div>
            <div class="live-stream-details">
                <div class="live-text-details">
                    <p><strong>Title:</strong> ${escapeHtml(d.livestream_title || 'Untitled')}</p>
                    <p><strong>Viewers:</strong> <span id="liveViewerCount" data-livestream-id="${d.livestream_id || ''}"${initialViewerData}>${initialViewerLabel}</span></p>
                    <p><strong>Category:</strong> ${escapeHtml(d.livestream_category || 'N/A')}</p>
                </div>
            </div>
            <div class="stream-url-container">
                <code class="stream-url" title="${escapeHtml(d.playback_url || '')}">${escapeHtml(d.playback_url || '')}</code>
                <button class="copy-button" data-url="${escapeHtml(d.playback_url || '')}">Copy</button>
                <button class="cast-button" data-stream-url="${escapeHtml(d.playback_url || '')}" data-stream-title="${escapeHtml(d.livestream_title || 'Kick Stream')}">Cast</button>
            </div>
            <p class="note">Copy the URL to play in a media player like VLC.</p>
            ${!document.body.classList.contains('chromecast-active') ? '<p class="chromecast-hint">Tip: Connect a Chromecast device using the icon in the header to cast streams.</p>' : ''}
            <a href="/streams/go/${encodeURIComponent(channelSlug)}" target="_blank" class="redirect-link">Open Live Stream</a>
        ` : `
            <a href="https://kick.com/${encodeURIComponent(channelSlug)}" target="_blank" rel="noopener noreferrer" class="redirect-link">View on Kick.com</a>
        `;

        content = `
            <div class="profile-banner-wrap${d.banner_image_url ? '' : ' no-banner'}"${bannerStyle}>
                <div class="profile-banner-overlay"></div>
            </div>
            <div class="profile-card-header">
                <div class="profile-avatar-wrap">${avatarHTML}</div>
                <div class="profile-identity">
                    <div class="profile-name-row">
                        <h2 class="profile-username">${escapeHtml(d.username || channelSlug)}</h2>
                        ${d.verified ? '<span class="verified-badge" title="Verified">✓</span>' : ''}
                        <span class="status-indicator ${isLive ? 'live' : 'offline'}">${isLive ? 'LIVE' : 'OFFLINE'}</span>
                    </div>
                    ${followersHTML}
                </div>
            </div>
            <div class="profile-content">
                ${d.bio ? `<p class="profile-bio">"${escapeHtml(d.bio)}"</p>` : ''}
                ${socialsHTML ? `<div class="profile-socials">${socialsHTML}</div>` : ''}
                ${categoriesHTML ? `<div class="profile-section-label">Recent categories</div><div class="category-tags">${categoriesHTML}</div>` : ''}
                ${liveBlock}
            </div>
        `;
    } else {
        // Minimal fallback (channel not found or API error)
        content = `
            <div class="channel-info-header">
                <h2>${escapeHtml(channelSlug)}</h2>
                <span class="status-indicator offline">NOT FOUND</span>
            </div>
            <p>${escapeHtml(response.message || 'Could not fetch channel data.')}</p>
        `;
    }

    liveStreamInfo.innerHTML = content;
    liveStreamInfo.style.display = 'block';

    if (isLive) {
        initVideoPlayer(d.playback_url);
    }

    if (window.innerWidth <= 768) {
        liveStreamInfo.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

export function renderVodsInfo(response, channelSlug) {
    const vodsList = document.getElementById('vodsList');
    if (response.status === "success" && response.data.vods && response.data.vods.length > 0) {
        const vods = response.data.vods;
        // Update module-level state for search
        currentVods = vods;
        currentChannelSlug = channelSlug;

        vodsList.style.display = 'block';
        renderVodsTable(vods, channelSlug);

        const searchInputHTML = `
            <div class="vods-search-container">
                <label for="vodSearchInput" class="sr-only">Search VOD titles</label>
                <input type="text" id="vodSearchInput" placeholder="Search VOD titles..." class="input-field" maxlength="200">
            </div>`;
        vodsList.insertAdjacentHTML('afterbegin', `<h3>Recent VODs</h3>${searchInputHTML}`);

        // Single listener per render - uses module-level currentVods (no stale closure)
        let debounceTimer = null;
        document.getElementById('vodSearchInput').addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const searchTerm = e.target.value.toLowerCase();
                const filteredVods = currentVods.filter(vod => vod.title?.toLowerCase().includes(searchTerm));
                renderVodsTable(filteredVods, currentChannelSlug);
            }, 300);
        });
    } else {
        vodsList.innerHTML = `<h3>Recent VODs</h3><p>${escapeHtml(response.message || 'No VODs found for this channel.')}</p>`;
        vodsList.style.display = 'block';
    }
}

export function renderVodsTable(vods, channelSlug) {
    const vodsTableContainer = document.getElementById('vodsList');

    const existingTable = vodsTableContainer.querySelector('.vods-table');
    if (existingTable) {
        existingTable.remove();
    }

    let tableHTML = `
        <table class="vods-table">
            <thead>
                <tr>
                    <th>Thumbnail</th>
                    <th class="sortable" data-sort-column="title" data-sort-type="string"><span>Title</span><span class="sort-indicator"></span></th>
                    <th class="sortable" data-sort-column="created_at" data-sort-type="date"><span>Date</span><span class="sort-indicator"></span></th>
                    <th class="sortable" data-sort-column="duration_seconds" data-sort-type="number"><span>Duration</span><span class="sort-indicator"></span></th>
                    <th class="sortable" data-sort-column="views" data-sort-type="number"><span>Views</span><span class="sort-indicator"></span></th>
                    <th class="cast-header">Cast</th>
                </tr>
            </thead>
            <tbody>
    `;

    vods.forEach((vod) => {
        const safeSlug = encodeURIComponent(channelSlug);
        const safeVodId = encodeURIComponent(vod.vod_id);
        tableHTML += `
            <tr>
                <td data-label="Thumbnail">
                    <a href="/streams/vods/${safeSlug}/${safeVodId}" target="_blank">
                        <img src="${escapeHtml(vod.thumbnail_url || '')}" alt="VOD Thumbnail" class="vod-thumbnail" loading="lazy" decoding="async" width="130" height="73">
                    </a>
                </td>
                <td data-label="Title"><a href="/streams/vods/${safeSlug}/${safeVodId}" target="_blank">${escapeHtml(vod.title || 'Untitled VOD')}</a></td>
                <td data-label="Date">${formatDate(vod.created_at)}</td>
                <td data-label="Duration">${formatDuration(vod.duration_seconds)}</td>
                <td data-label="Views">${vod.views?.toLocaleString('en-US') || 'N/A'}</td>
                <td data-label="Cast" class="cast-header">
                    <button class="cast-button" data-stream-url="${escapeHtml(vod.source_url)}" data-stream-title="${escapeHtml(vod.title || 'Kick VOD')}">Cast</button>
                </td>
            </tr>
        `;
    });

    if (vods.length === 0) {
        tableHTML += `<tr><td colspan="6" class="no-results-message">No VODs match your search.</td></tr>`;
    }

    tableHTML += `</tbody></table>`;
    vodsTableContainer.insertAdjacentHTML('beforeend', tableHTML);

    addSortEventListeners('vodsList');
    updateSortIndicators('vodsList', vodsSortState);
}

function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function getFeaturedStreamKey(stream) {
    return stream?.channel?.slug || stream?.slug || stream?.id || stream?.channel?.user?.username || '';
}

function cancelFeaturedRowAnimations(row) {
    if (typeof row.getAnimations === 'function') {
        row.getAnimations().forEach(animation => animation.cancel());
    }
}

function buildFeaturedRowMarkup(stream) {
    const safeSlug = encodeURIComponent(stream.channel?.slug || '');
    const categoryName = stream.categories?.[0]?.name || 'N/A';

    return `
        <td data-label="Thumbnail">
            <a href="/streams/go/${safeSlug || '#'}" target="_blank">
                <img src="${escapeHtml(stream.thumbnail?.src || '')}" alt="Stream Thumbnail" class="vod-thumbnail" loading="lazy" decoding="async" width="130" height="73">
            </a>
        </td>
        <td data-label="Title"><a href="/streams/go/${safeSlug || '#'}" target="_blank">${escapeHtml(stream.session_title || 'Untitled Stream')}</a></td>
        <td data-label="Channel">${escapeHtml(stream.channel?.user?.username || 'N/A')}</td>
        <td data-label="Viewers">${stream.viewer_count?.toLocaleString('en-US') || 'N/A'}</td>
        <td data-label="Category">${escapeHtml(categoryName)}</td>
        <td data-label="Cast" class="cast-header">
            <button class="cast-button" data-stream-url="${escapeHtml(stream.playback_url || '')}" data-stream-title="${escapeHtml(stream.session_title || 'Kick Stream')}">Cast</button>
        </td>
    `;
}

function createFeaturedStreamRow(stream) {
    const row = document.createElement('tr');
    updateFeaturedStreamRow(row, stream);
    return row;
}

function updateFeaturedStreamRow(row, stream) {
    row.dataset.streamKey = getFeaturedStreamKey(stream);
    
    if (row.children.length === 0) {
        row.innerHTML = buildFeaturedRowMarkup(stream);
        return;
    }

    const safeSlug = encodeURIComponent(stream.channel?.slug || '');
    const categoryName = stream.categories?.[0]?.name || 'N/A';
    const newThumbSrc = stream.thumbnail?.src || '';
    const newHref = `/streams/go/${safeSlug || '#'}`;

    // Update Thumbnail smoothly
    const imgWrapper = row.cells[0]?.querySelector('a');
    if (imgWrapper) {
        if (imgWrapper.getAttribute('href') !== newHref) imgWrapper.setAttribute('href', newHref);
        
        const img = imgWrapper.querySelector('img');
        if (img && img.src !== newThumbSrc && img.dataset.loadingSrc !== newThumbSrc) {
            img.dataset.loadingSrc = newThumbSrc;
            const tempImg = new Image();
            tempImg.onload = () => {
                // Ensure we are applying to the latest requested source for this image
                if (img.dataset.loadingSrc === newThumbSrc) {
                    img.src = newThumbSrc;
                    delete img.dataset.loadingSrc;
                }
            };
            tempImg.onerror = () => {
                if (img.dataset.loadingSrc === newThumbSrc) delete img.dataset.loadingSrc;
            };
            tempImg.src = newThumbSrc;
        }
    }

    // Update Title
    const titleA = row.cells[1]?.querySelector('a');
    if (titleA) {
        if (titleA.getAttribute('href') !== newHref) titleA.setAttribute('href', newHref);
        const newTitle = stream.session_title || 'Untitled Stream';
        if (titleA.textContent !== newTitle) titleA.textContent = newTitle;
    }

    // Update Channel
    const newChannel = stream.channel?.user?.username || 'N/A';
    if (row.cells[2] && row.cells[2].textContent !== newChannel) {
        row.cells[2].textContent = newChannel;
    }

    // Update Viewers
    const newViewers = stream.viewer_count?.toLocaleString('en-US') || 'N/A';
    if (row.cells[3] && row.cells[3].textContent !== newViewers) {
        row.cells[3].textContent = newViewers;
    }

    // Update Category
    if (row.cells[4] && row.cells[4].textContent !== categoryName) {
        row.cells[4].textContent = categoryName;
    }

    // Update Cast Button
    const castBtn = row.cells[5]?.querySelector('.cast-button');
    if (castBtn) {
        const newPlaybackUrl = stream.playback_url || '';
        const newCastTitle = stream.session_title || 'Kick Stream';
        if (castBtn.dataset.streamUrl !== newPlaybackUrl) castBtn.dataset.streamUrl = newPlaybackUrl;
        if (castBtn.dataset.streamTitle !== newCastTitle) castBtn.dataset.streamTitle = newCastTitle;
    }
}

function animateFeaturedRows(nextRows, previousRects, insertedRows, renderMode = 'full') {
    if (prefersReducedMotion()) return;

    const insertedRowsSet = new Set(insertedRows);
    const STAGGER_DELAY_MS = 30;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    // In append mode, existing rows haven't moved — skip FLIP calculations
    const skipFlipForExisting = renderMode === 'append';

    let insertIndex = 0;
    nextRows.forEach(row => {
        if (typeof row.animate !== 'function') return;

        if (insertedRowsSet.has(row)) {
            // Only animate rows near the viewport
            const rect = row.getBoundingClientRect();
            if (rect.top < viewportHeight + 200) {
                row.animate(
                    [
                        { opacity: 0, transform: 'translateY(12px)' },
                        { opacity: 1, transform: 'translateY(0)' },
                    ],
                    {
                        duration: FEATURED_ROW_ENTRY_DURATION_MS,
                        easing: FEATURED_ROW_MOVE_EASING,
                        delay: insertIndex * STAGGER_DELAY_MS,
                        fill: 'backwards',
                    }
                );
            }
            insertIndex++;
            return;
        }

        if (skipFlipForExisting) return;

        const previousRect = previousRects.get(row.dataset.streamKey);
        if (!previousRect) return;

        const currentRect = row.getBoundingClientRect();
        const deltaX = previousRect.left - currentRect.left;
        const deltaY = previousRect.top - currentRect.top;

        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;

        row.animate(
            [
                { transform: `translate(${deltaX}px, ${deltaY}px)` },
                { transform: 'translate(0, 0)' },
            ],
            {
                duration: FEATURED_ROW_MOVE_DURATION_MS,
                easing: FEATURED_ROW_MOVE_EASING,
            }
        );
    });
}

export function renderFeaturedStreamsTable(streams, meta = {}) {
    const featuredStreamsTableBody = document.getElementById('featuredStreamsTableBody');
    const noFeaturedStreamsMessage = document.getElementById('noFeaturedStreamsMessage');

    if (!featuredStreamsTableBody) return;

    const renderMode = meta.renderMode || 'full';
    const skipAnimation = renderMode === 'refresh';

    const existingRows = new Map();
    const previousRects = new Map();

    Array.from(featuredStreamsTableBody.children).forEach(row => {
        if (!skipAnimation) cancelFeaturedRowAnimations(row);
        if (row.dataset.streamKey) {
            existingRows.set(row.dataset.streamKey, row);
            if (!skipAnimation) {
                previousRects.set(row.dataset.streamKey, row.getBoundingClientRect());
            }
        }
    });

    if (streams && Array.isArray(streams) && streams.length > 0) {
        if (noFeaturedStreamsMessage) noFeaturedStreamsMessage.style.display = 'none';

        const nextRows = [];
        const insertedRows = [];

        streams.forEach(stream => {
            const key = getFeaturedStreamKey(stream);
            let row = existingRows.get(key);

            if (row) {
                existingRows.delete(key);
                updateFeaturedStreamRow(row, stream);
            } else {
                row = createFeaturedStreamRow(stream);
                insertedRows.push(row);
            }

            nextRows.push(row);
        });

        existingRows.forEach(row => row.remove());
        nextRows.forEach(row => {
            featuredStreamsTableBody.appendChild(row);
        });

        if (!skipAnimation) {
            void featuredStreamsTableBody.offsetHeight;
            animateFeaturedRows(nextRows, previousRects, insertedRows, renderMode);
        }
    } else {
        existingRows.forEach(row => row.remove());
        if (noFeaturedStreamsMessage) noFeaturedStreamsMessage.style.display = 'block';
    }
    updateSortIndicators('featuredLivestreams', featuredSortState);
}

export function renderClipsInfo(response, channelSlug) {
    const clipsList = document.getElementById('clipsList');
    if (!clipsList) return;

    if (response.status === 'success' && response.data?.clips?.length > 0) {
        const clips = response.data.clips;
        currentClips = clips;
        currentClipsChannelSlug = channelSlug;

        clipsList.style.display = 'block';

        const searchInputHTML = `
            <div class="vods-search-container">
                <label for="clipSearchInput" class="sr-only">Search clip titles</label>
                <input type="text" id="clipSearchInput" placeholder="Search clip titles..." class="input-field" maxlength="200">
            </div>`;
        clipsList.innerHTML = `<h3>Clips</h3>${searchInputHTML}`;
        renderClipsTable(clips);

        let debounceTimer = null;
        document.getElementById('clipSearchInput').addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const term = e.target.value.toLowerCase();
                renderClipsTable(currentClips.filter(c => c.title?.toLowerCase().includes(term)));
            }, 300);
        });
    } else {
        // No clips or error — hide section silently (clips are optional)
        clipsList.style.display = 'none';
    }
}

export function renderClipsTable(clips) {
    const clipsList = document.getElementById('clipsList');
    if (!clipsList) return;

    const existing = clipsList.querySelector('.vods-table');
    if (existing) existing.remove();

    let tableHTML = `
        <table class="vods-table">
            <thead>
                <tr>
                    <th>Thumbnail</th>
                    <th><span>Title</span></th>
                    <th><span>Duration</span></th>
                    <th><span>Views</span></th>
                    <th><span>Date</span></th>
                    <th><span>Category</span></th>
                    <th class="cast-header">Cast</th>
                </tr>
            </thead>
            <tbody>`;

    clips.forEach(clip => {
        const url = escapeHtml(clip.clip_url || '');
        tableHTML += `
            <tr>
                <td data-label="Thumbnail">
                    ${clip.thumbnail_url
                        ? `<img src="${escapeHtml(clip.thumbnail_url)}" alt="Clip Thumbnail" class="vod-thumbnail" loading="lazy" decoding="async" width="130" height="73">`
                        : '<span class="no-thumb">—</span>'}
                </td>
                <td data-label="Title">${escapeHtml(clip.title || 'Untitled Clip')}</td>
                <td data-label="Duration">${clip.duration_seconds ? formatDuration(clip.duration_seconds) : 'N/A'}</td>
                <td data-label="Views">${clip.views?.toLocaleString('en-US') || 'N/A'}</td>
                <td data-label="Date">${formatDate(clip.created_at)}</td>
                <td data-label="Category">${escapeHtml(clip.category_name || 'N/A')}</td>
                <td data-label="Cast" class="cast-header">
                    <button class="cast-button" data-stream-url="${url}" data-stream-title="${escapeHtml(clip.title || 'Kick Clip')}">Cast</button>
                </td>
            </tr>`;
    });

    if (clips.length === 0) {
        tableHTML += `<tr><td colspan="7" class="no-results-message">No clips match your search.</td></tr>`;
    }

    tableHTML += `</tbody></table>`;
    clipsList.insertAdjacentHTML('beforeend', tableHTML);
}

export function renderSearchResults(results, onSelect) {
    const container = document.getElementById('searchSuggestions');
    if (!container) return;

    if (!results || results.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.innerHTML = '';
    results.forEach(r => {
        const item = document.createElement('div');
        item.className = 'search-suggestion-item';
        item.dataset.slug = r.slug;

        const liveBadge = r.is_live ? '<span class="suggestion-live">LIVE</span>' : '';
        // Prefer live viewer count; fall back to followers if no viewer count available
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

export function addSortEventListeners(tableId, callback) {
    const tableContainer = document.getElementById(tableId);
    if (!tableContainer) return;

    tableContainer.querySelectorAll('.vods-table th.sortable').forEach(header => {
        header.addEventListener('click', () => {
            const column = header.dataset.sortColumn;
            const type = header.dataset.sortType;
            const channelSlug = document.getElementById('channelSlugInput').value.trim();

            if (tableId === 'vodsList') {
                const { sortedData, newSortState } = sortVodsTable(appState.vods, vodsSortState, column, type);
                appState.vods = sortedData;
                Object.assign(vodsSortState, newSortState);
                renderVodsTable(appState.vods, channelSlug);
            } else if (tableId === 'featuredLivestreams') {
                const { sortedData, newSortState } = sortFeaturedStreamsTable(appState.featuredStreams, featuredSortState, column, type);
                appState.featuredStreams = sortedData;
                Object.assign(featuredSortState, newSortState);
                if (callback && typeof callback === 'function') {
                    callback();
                } else {
                    renderFeaturedStreamsTable(appState.featuredStreams);
                }
            }
        });
    });
}

function updateSortIndicators(tableId, sortState) {
    const tableContainer = document.getElementById(tableId);
    if (!tableContainer) return;

    tableContainer.querySelectorAll('.vods-table th.sortable').forEach(header => {
        const column = header.dataset.sortColumn;
        const indicatorSpan = header.querySelector('.sort-indicator');
        if (indicatorSpan) {
            if (column === sortState.column) {
                indicatorSpan.textContent = sortState.direction === 'asc' ? ' ▲' : ' ▼';
            } else {
                indicatorSpan.textContent = '';
            }
        }
    });
}

// Event delegation for copy and cast buttons (avoids listener accumulation)
let delegationInitialized = false;

export function initButtonDelegation() {
    if (delegationInitialized) return;
    delegationInitialized = true;

    document.addEventListener('click', async (event) => {
        const copyButton = event.target.closest('.copy-button');
        if (copyButton) {
            const textToCopy = copyButton.dataset.url;
            copyToClipboard(copyButton, textToCopy);
            return;
        }

        const castButton = event.target.closest('.cast-button');
        if (castButton) {
            let streamUrl = castButton.dataset.streamUrl;
            const streamTitle = castButton.dataset.streamTitle;

            if (streamUrl === 'undefined' || streamUrl === 'null' || !streamUrl) {
                const row = castButton.closest('tr');
                if (!row) return;
                const channelSlug = row.querySelector('td:nth-child(3)')?.textContent?.trim();
                if (!channelSlug) return;

                try {
                    if (row.parentElement?.id === 'featuredStreamsTableBody') {
                        const { liveData } = await fetchChannelData(channelSlug);
                        if (liveData.status === 'success' && liveData.data.status === 'live') {
                            streamUrl = liveData.data.playback_url;
                        }
                    } else {
                        const vodLink = row.querySelector('a')?.href;
                        if (vodLink) {
                            const vodId = vodLink.substring(vodLink.lastIndexOf('/') + 1);
                            const response = await fetch(`/streams/vods/${channelSlug}/${vodId}`);
                            if (response.ok) {
                                const data = await response.json();
                                if (data.status === 'success') {
                                    streamUrl = data.data.source_url;
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error fetching stream URL for cast:', error);
                    showMessage('Error fetching stream data for casting.', 'error');
                    return;
                }
            }
            castStream(streamUrl, streamTitle);
        }
    });
}

