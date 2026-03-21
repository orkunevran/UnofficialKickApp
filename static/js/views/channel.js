/**
 * Channel view — profile + tabs (Stream / VODs / Clips).
 */

import { fetchChannelData, fetchViewerCount } from '../api.js?v=2.3.7';
import { renderChannelProfile, renderStreamTabContent, renderProfileSkeleton, renderVodGrid, renderClipGrid } from '../ui.js?v=2.3.7';
import { appState } from '../state.js?v=2.3.7';
import { addToHistory } from '../history.js?v=2.3.7';
import { toast } from '../toast.js?v=2.3.7';
import { escapeHtml, debounce } from '../utils.js?v=2.3.7';
import { navigate } from '../router.js?v=2.3.7';
import { startMiniPlayer } from '../player.js?v=2.3.7';

let viewerRefreshTimer = null;
let hlsInstance = null;

function initVideoPlayer(playbackUrl) {
    const video = document.getElementById('liveVideoPlayer');
    if (!video || !playbackUrl) return;

    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = playbackUrl;
        video.play().catch(() => {});
    } else if (window.Hls && window.Hls.isSupported()) {
        hlsInstance = new window.Hls({ lowLatencyMode: true, maxBufferLength: 30 });
        hlsInstance.loadSource(playbackUrl);
        hlsInstance.attachMedia(video);
        hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(() => {});
        });
    }
}

function destroyVideoPlayer() {
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
    const video = document.getElementById('liveVideoPlayer');
    if (video) { video.pause(); video.src = ''; video.load(); }
}

function startViewerRefresh(livestreamId) {
    stopViewerRefresh();
    if (!livestreamId) return;

    let failCount = 0;
    const MAX_FAILURES = 3;

    const refresh = async () => {
        const result = await fetchViewerCount(livestreamId);
        const el = document.getElementById('liveViewerCount');
        if (!el || String(el.dataset.livestreamId || '') !== String(livestreamId)) return;

        if (result?.status !== 'success') {
            failCount++;
            if (failCount >= MAX_FAILURES) {
                el.textContent = 'Offline';
                stopViewerRefresh();
            }
            return;
        }

        failCount = 0;
        const count = result.data?.viewer_count;
        const num = Number(count);
        if (Number.isFinite(num) && num > 0) {
            const prev = el.textContent;
            el.textContent = num.toLocaleString('en-US');
            el.dataset.lastKnownViewerCount = String(num);
            if (el.textContent !== prev) {
                el.classList.remove('viewer-updated');
                void el.offsetWidth;
                el.classList.add('viewer-updated');
            }
        } else if (num === 0) {
            // Don't overwrite a known-good count with 0 — may be stale data
            const lastKnown = Number(el.dataset.lastKnownViewerCount);
            if (!Number.isFinite(lastKnown) || lastKnown === 0) {
                el.textContent = '0';
            }
        }
    };

    void refresh();
    viewerRefreshTimer = setInterval(refresh, 30000);
}

function stopViewerRefresh() {
    if (viewerRefreshTimer) {
        clearInterval(viewerRefreshTimer);
        viewerRefreshTimer = null;
    }
}

function renderTabContent(tab, liveData, vodsData, clipsData, channelSlug) {
    const tabContent = document.getElementById('profile-tab-content');
    if (!tabContent) return;

    // Re-trigger fade-in animation
    tabContent.style.animation = 'none';
    void tabContent.offsetWidth;
    tabContent.style.animation = '';

    if (tab === 'stream') {
        tabContent.innerHTML = renderStreamTabContent(liveData?.data, channelSlug);
        if (liveData?.data?.status === 'live') {
            initVideoPlayer(liveData.data.playback_url);
        }
    } else if (tab === 'vods') {
        const vods = vodsData?.data?.vods || [];
        appState.vods = vods;

        // Add search bar
        const searchHTML = `
            <div style="max-width:400px;margin:0 auto 20px">
                <input type="text" id="vodSearchInput" placeholder="Search VOD titles..." class="search-input" style="padding-left:12px" maxlength="200">
            </div>`;

        tabContent.innerHTML = searchHTML + renderVodGrid(vods, channelSlug);

        const vodSearch = document.getElementById('vodSearchInput');
        if (vodSearch) {
            vodSearch.addEventListener('input', debounce((e) => {
                const term = e.target.value.toLowerCase();
                const filtered = vods.filter(v => v.title?.toLowerCase().includes(term));
                const grid = tabContent.querySelector('.vod-grid, .empty-state');
                if (grid) {
                    const parent = grid.parentNode;
                    grid.remove();
                    parent.insertAdjacentHTML('beforeend', renderVodGrid(filtered, channelSlug));
                }
            }, 300));
        }
    } else if (tab === 'clips') {
        const clips = clipsData?.data?.clips || [];
        appState.clips = clips;

        const searchHTML = `
            <div style="max-width:400px;margin:0 auto 20px">
                <input type="text" id="clipSearchInput" placeholder="Search clip titles..." class="search-input" style="padding-left:12px" maxlength="200">
            </div>`;

        tabContent.innerHTML = searchHTML + renderClipGrid(clips);

        const clipSearch = document.getElementById('clipSearchInput');
        if (clipSearch) {
            clipSearch.addEventListener('input', debounce((e) => {
                const term = e.target.value.toLowerCase();
                const filtered = clips.filter(c => c.title?.toLowerCase().includes(term));
                const grid = tabContent.querySelector('.vod-grid, .empty-state');
                if (grid) {
                    const parent = grid.parentNode;
                    grid.remove();
                    parent.insertAdjacentHTML('beforeend', renderClipGrid(filtered));
                }
            }, 300));
        }
    }
}

export async function mount(params, contentEl) {
    const channelSlug = params.slug;
    if (!channelSlug) {
        navigate('/browse', { replace: true });
        return;
    }

    // Set search input to channel name
    const searchInput = document.getElementById('channelSlugInput');
    if (searchInput) searchInput.value = channelSlug;

    // Show skeleton
    contentEl.innerHTML = renderProfileSkeleton();

    let liveData, vodsData, clipsData;
    let activeTab = 'stream';

    try {
        const result = await fetchChannelData(channelSlug);
        liveData = result.liveData;
        vodsData = result.vodsData;
        clipsData = result.clipsData;
    } catch (err) {
        console.error('Error fetching channel data:', err);
        contentEl.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
                <div class="empty-state-title">Channel not found</div>
                <div class="empty-state-text">${escapeHtml(err.message)}</div>
            </div>`;
        toast(`Error loading ${channelSlug}`, 'error', {
            action: { label: 'Retry', onClick: () => navigate(`/channel/${channelSlug}`) }
        });
        return;
    }

    // Add to history
    const d = liveData?.data;
    addToHistory({
        slug: channelSlug,
        username: d?.username || channelSlug,
        title: d?.livestream_title || '',
        type: 'stream',
        thumbnailUrl: d?.livestream_thumbnail_url || d?.banner_image_url || '',
        profilePicture: d?.profile_picture || '',
    });

    // Render profile
    contentEl.innerHTML = renderChannelProfile(
        liveData?.status === 'success' ? liveData.data : null,
        channelSlug,
        { activeTab }
    );

    // Render initial tab
    renderTabContent(activeTab, liveData, vodsData, clipsData, channelSlug);

    // Start viewer refresh if live
    if (liveData?.data?.status === 'live') {
        const initial = Number(liveData.data.livestream_viewer_count);
        startViewerRefresh(liveData.data.livestream_id);
    }

    // Tab switching
    const onTabClick = (e) => {
        const tab = e.target.closest('.profile-tab');
        if (!tab) return;
        const tabName = tab.dataset.tab;
        if (tabName === activeTab) return;

        // Destroy video if leaving stream tab
        if (activeTab === 'stream') destroyVideoPlayer();

        activeTab = tabName;
        contentEl.querySelectorAll('.profile-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
        renderTabContent(tabName, liveData, vodsData, clipsData, channelSlug);

        // Restart video if coming back to stream tab
        if (tabName === 'stream' && liveData?.data?.status === 'live') {
            initVideoPlayer(liveData.data.playback_url);
        }
    };
    const tabsEl = contentEl.querySelector('.profile-tabs');
    tabsEl?.addEventListener('click', onTabClick);

    // Cleanup — activate mini player if stream was live
    return () => {
        stopViewerRefresh();
        tabsEl?.removeEventListener('click', onTabClick);
        if (liveData?.data?.status === 'live') {
            startMiniPlayer({
                slug: channelSlug,
                title: d?.livestream_title || 'Untitled Stream',
                channel: d?.username || channelSlug,
                playbackUrl: d?.playback_url || '',
                thumbnailUrl: d?.livestream_thumbnail_url || '',
            });
        }
        destroyVideoPlayer();
    };
}
