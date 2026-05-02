/**
 * Channel view — profile + tabs (Stream / VODs / Clips).
 *
 * Uses the unified shared-player API: the same <video> element is moved
 * between the channel slot, the mini-player, and a hidden parking layer
 * so playback survives route changes without a reload.
 */

import { fetchChannelData, fetchLiveStatus, fetchViewerCount } from '../api.js';
import { renderChannelProfile, renderStreamTabContent, renderProfileSkeleton, renderVodGrid, renderClipGrid, renderVodPlayerContent, renderClipPlayerContent } from '../ui.js';
import { appState, preferences } from '../state.js';
import { addToHistory } from '../history.js';
import { toast } from '../toast.js';
import { escapeHtml, debounce } from '../utils.js';
import { navigate } from '../router.js';
import {
    getCurrentStream, getCachedChannelData, getHlsInstance,
    loadStream, setMode, cacheChannelData, stopStream,
} from '../player.js';

let viewerRefreshTimer = null;

function initVideoPlayer(playbackUrl, channelSlug, liveData) {
    const slot = document.getElementById('video-slot');
    if (!slot || !playbackUrl) return;

    const miniStream = getCurrentStream();

    if (miniStream?.slug === channelSlug) {
        // Same channel — just project the already-playing video to full size.
        // HLS stays attached.  Zero interruption.
        setMode('full', slot, { animate: true });
        _renderQualityPicker(getHlsInstance());
        _initPipButton();
        return;
    }

    // Different channel or no active stream — stop any existing stream
    if (miniStream) stopStream();

    // Fresh load: start HLS on the shared video and project to full
    const streamInfo = {
        slug: channelSlug,
        title: liveData?.data?.livestream_title || channelSlug,
        channel: liveData?.data?.username || channelSlug,
        playbackUrl,
        thumbnailUrl: liveData?.data?.livestream_thumbnail_url || '',
    };
    loadStream(playbackUrl, streamInfo, liveData);
    setMode('full', slot);
    _renderQualityPicker(getHlsInstance());
    _initPipButton();
}

function _initPipButton() {
    const video = document.getElementById('sharedVideo');
    const pipBtn = document.getElementById('pip-button');
    if (pipBtn && video && document.pictureInPictureEnabled) {
        pipBtn.classList.remove('hidden');
        pipBtn.onclick = async () => {
            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                } else {
                    await video.requestPictureInPicture();
                }
            } catch (e) { console.warn('PiP failed:', e); }
        };
    }
}

function _renderQualityPicker(hls) {
    const container = document.getElementById('quality-picker');
    if (!container || !hls?.levels?.length) return;

    const levels = hls.levels.map((l, i) => ({
        index: i,
        label: l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)}k`,
        height: l.height || 0,
    }));
    levels.sort((a, b) => b.height - a.height);

    container.innerHTML = `
        <select id="quality-select" class="filter-select quality-select" title="Stream quality">
            <option value="-1" selected>Auto</option>
            ${levels.map(l => `<option value="${l.index}">${l.label}</option>`).join('')}
        </select>`;
    container.classList.remove('hidden');

    container.querySelector('#quality-select')?.addEventListener('change', (e) => {
        hls.currentLevel = parseInt(e.target.value, 10);
    });
}

function startViewerRefresh(livestreamId) {
    stopViewerRefresh();
    if (!livestreamId) return;

    let failCount = 0;
    const MAX_FAILURES = 3;

    const refresh = async () => {
        if (document.visibilityState !== 'visible') return;
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
            const shouldAnimate = !document.documentElement.classList.contains('safari')
                && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (shouldAnimate && el.textContent !== prev) {
                el.classList.remove('viewer-updated');
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => el.classList.add('viewer-updated'));
                });
            }
        } else if (num === 0) {
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

    const shouldAnimate = !document.documentElement.classList.contains('safari')
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (shouldAnimate) {
        tabContent.classList.remove('tab-fade-in');
        requestAnimationFrame(() => tabContent.classList.add('tab-fade-in'));
    }

    if (tab === 'stream') {
        tabContent.innerHTML = renderStreamTabContent(liveData?.data, channelSlug);
        if (liveData?.data?.status === 'live') {
            // On mobile, move video to top-of-page anchor for video-first UX
            if (window.innerWidth < 768) {
                const anchor = document.getElementById('mobile-video-anchor');
                const videoEl = document.getElementById('video-slot');
                if (anchor && videoEl) anchor.appendChild(videoEl);
            }
            initVideoPlayer(liveData.data.playback_url, channelSlug, liveData);
        }
    } else if (tab === 'vods') {
        if (!vodsData) {
            tabContent.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;padding:40px;color:var(--text-muted)"><span class="inline-spinner is-active" style="margin-right:8px"></span>Loading VODs…</div>';
            return;
        }
        const vods = vodsData?.data?.vods || [];
        appState.vods = vods;

        if (tabContent._vodClickHandler) {
            tabContent.removeEventListener('click', tabContent._vodClickHandler);
        }

        const _renderVodList = () => {
            const searchHTML = `
                <div style="max-width:400px;margin:0 auto 20px">
                    <input type="text" id="vodSearchInput" placeholder="Search VOD titles..." class="search-input" style="padding-left:12px" maxlength="200">
                </div>`;
            tabContent.innerHTML = searchHTML + renderVodGrid(vods, channelSlug);

            const vodSearch = document.getElementById('vodSearchInput');
            if (vodSearch) {
                vodSearch.addEventListener('input', debounce((e) => {
                    const term = e.target.value.toLowerCase();
                    tabContent.querySelectorAll('.vod-card').forEach(card => {
                        const title = card.dataset.title || '';
                        card.style.display = (!term || title.includes(term)) ? '' : 'none';
                    });
                }, 200));
            }

            // Click delegation for inline VOD playback
            tabContent._vodClickHandler = async (e) => {
                // Ignore clicks on cast/external-link buttons
                if (e.target.closest('.cast-button') || e.target.closest('a[target="_blank"]')) return;
                const card = e.target.closest('[data-play-vod]');
                if (!card) return;
                e.preventDefault();

                // Stop any existing stream
                if (getCurrentStream()) stopStream();

                // Show player UI
                tabContent.innerHTML = renderVodPlayerContent(card);

                // Cast and playback should use the absolute manifest URL.
                // The proxy redirect route is still kept for "open in new tab".
                const playbackUrl = card.dataset.playbackUrl || card.dataset.sourceUrl || '';

                const slot = document.getElementById('video-slot');
                if (!slot) return;

                const streamInfo = {
                    slug: channelSlug,
                    title: card.dataset.vodTitle || 'VOD',
                    channel: channelSlug,
                    playbackUrl,
                    thumbnailUrl: card.dataset.vodThumb || '',
                    type: 'vod',
                };
                loadStream(playbackUrl, streamInfo, null);
                setMode('full', slot);

                // "Back to list" button
                tabContent.querySelector('.vod-back-btn')?.addEventListener('click', () => {
                    stopStream();
                    _renderVodList();
                });
            };
            tabContent.addEventListener('click', tabContent._vodClickHandler);
        };
        _renderVodList();

    } else if (tab === 'clips') {
        if (!clipsData) {
            tabContent.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;padding:40px;color:var(--text-muted)"><span class="inline-spinner is-active" style="margin-right:8px"></span>Loading clips…</div>';
            return;
        }
        const clips = clipsData?.data?.clips || [];
        appState.clips = clips;

        if (tabContent._clipClickHandler) {
            tabContent.removeEventListener('click', tabContent._clipClickHandler);
        }

        const _renderClipList = () => {
            const searchHTML = `
                <div style="max-width:400px;margin:0 auto 20px">
                    <input type="text" id="clipSearchInput" placeholder="Search clip titles..." class="search-input" style="padding-left:12px" maxlength="200">
                </div>`;
            tabContent.innerHTML = searchHTML + renderClipGrid(clips);

            const clipSearch = document.getElementById('clipSearchInput');
            if (clipSearch) {
                clipSearch.addEventListener('input', debounce((e) => {
                    const term = e.target.value.toLowerCase();
                    tabContent.querySelectorAll('.vod-card').forEach(card => {
                        const title = card.dataset.title || '';
                        card.style.display = (!term || title.includes(term)) ? '' : 'none';
                    });
                }, 200));
            }

            // Click delegation for inline clip playback
            tabContent._clipClickHandler = async (e) => {
                if (e.target.closest('.cast-button') || e.target.closest('a[target="_blank"]')) return;
                const card = e.target.closest('[data-play-clip]');
                if (!card) return;
                e.preventDefault();

                if (getCurrentStream()) stopStream();

                tabContent.innerHTML = renderClipPlayerContent(card);

                const clipUrl = card.dataset.clipUrl;
                const slot = document.getElementById('video-slot');
                if (!slot) return;

                const streamInfo = {
                    slug: channelSlug,
                    title: card.dataset.clipTitle || 'Clip',
                    channel: channelSlug,
                    playbackUrl: clipUrl,
                    thumbnailUrl: card.dataset.clipThumb || '',
                    type: 'clip',
                };
                loadStream(clipUrl, streamInfo, null);
                setMode('full', slot);

                tabContent.querySelector('.vod-back-btn')?.addEventListener('click', () => {
                    stopStream();
                    _renderClipList();
                });
            };
            tabContent.addEventListener('click', tabContent._clipClickHandler);
        };
        _renderClipList();
    }
}

export async function mount(params, contentEl) {
    const channelSlug = params.slug;
    if (!channelSlug) {
        navigate('/browse', { replace: true });
        return;
    }

    const searchInput = document.getElementById('channelSlugInput');
    if (searchInput) searchInput.value = channelSlug;

    let liveData, vodsData = null, clipsData = null;
    let activeTab = 'stream';

    // ── Instant render path: if mini-player has this channel, use cached data ──
    const miniStream = getCurrentStream();
    const cachedData = (miniStream?.slug === channelSlug) ? getCachedChannelData() : null;

    if (cachedData) {
        liveData = cachedData;
        const d = liveData?.data;

        if (preferences.historyEnabled !== false) {
            addToHistory({
                slug: channelSlug,
                username: d?.username || channelSlug,
                title: d?.livestream_title || '',
                type: 'stream',
                thumbnailUrl: d?.livestream_thumbnail_url || d?.banner_image_url || '',
                profilePicture: d?.profile_picture || '',
            });
        }

        contentEl.innerHTML = renderChannelProfile(
            liveData?.status === 'success' ? liveData.data : null,
            channelSlug,
            { activeTab }
        );
        renderTabContent(activeTab, liveData, vodsData, clipsData, channelSlug);

        if (d?.status === 'live') {
            startViewerRefresh(d.livestream_id);
        }

        // Background refresh for freshness
        fetchLiveStatus(channelSlug).then(fresh => {
            if (fresh?.status === 'success') liveData = fresh;
        }).catch(() => {});
    } else {
        // ── Normal path: skeleton → fetch → render ──
        contentEl.innerHTML = renderProfileSkeleton();

        try {
            liveData = await fetchLiveStatus(channelSlug);
            if (!liveData || liveData.status !== 'success') {
                throw new Error(liveData?.message || 'Channel not found');
            }
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

        const d = liveData?.data;

        if (preferences.historyEnabled !== false) {
            addToHistory({
                slug: channelSlug,
                username: d?.username || channelSlug,
                title: d?.livestream_title || '',
                type: 'stream',
                thumbnailUrl: d?.livestream_thumbnail_url || d?.banner_image_url || '',
                profilePicture: d?.profile_picture || '',
            });
        }

        contentEl.innerHTML = renderChannelProfile(
            liveData?.status === 'success' ? liveData.data : null,
            channelSlug,
            { activeTab }
        );
        renderTabContent(activeTab, liveData, vodsData, clipsData, channelSlug);

        if (liveData?.data?.status === 'live') {
            startViewerRefresh(liveData.data.livestream_id);
        }
    }

    const d = liveData?.data;

    // Phase 2: Fetch vods + clips in background
    fetchChannelData(channelSlug).then(result => {
        vodsData = result.vodsData;
        clipsData = result.clipsData;
        if (activeTab === 'vods' || activeTab === 'clips') {
            renderTabContent(activeTab, liveData, vodsData, clipsData, channelSlug);
        }
    }).catch(() => {});

    // Tab switching
    const onTabClick = (e) => {
        const tab = e.target.closest('.profile-tab');
        if (!tab) return;
        const tabName = tab.dataset.tab;
        if (tabName === activeTab) return;

        // When leaving stream tab, switch video to hidden (but keep stream alive
        // in case user switches back) — or to mini if navigating away entirely
        if (activeTab === 'stream' && d?.status === 'live') {
            // Just hide the video layer while staying on the channel page
            // (don't stop the stream — user might switch back to stream tab)
            setMode('hidden');
        }

        activeTab = tabName;
        contentEl.querySelectorAll('.profile-tab').forEach(t => {
            const isActive = t.dataset.tab === tabName;
            t.classList.toggle('active', isActive);
            t.setAttribute('aria-selected', String(isActive));
        });
        const tabPanel = document.getElementById('profile-tab-content');
        if (tabPanel) tabPanel.setAttribute('aria-labelledby', `tab-${tabName}`);

        renderTabContent(tabName, liveData, vodsData, clipsData, channelSlug);
    };
    const tabsEl = contentEl.querySelector('.profile-tabs');
    tabsEl?.addEventListener('click', onTabClick);

    // Cleanup — switch to mini mode (stream keeps playing)
    return () => {
        stopViewerRefresh();
        tabsEl?.removeEventListener('click', onTabClick);

        if (d?.status === 'live' && getCurrentStream()) {
            // Cache the channel data for instant re-render on return
            cacheChannelData(liveData);
            // Hand off to the collapsed mini-player — zero interruption.
            setMode('mini', null, { animate: true, collapsePanel: true });
        }
        // If not live or no stream, nothing to do — stream stays stopped
    };
}
