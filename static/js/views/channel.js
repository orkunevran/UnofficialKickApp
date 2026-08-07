/**
 * Channel view — profile + tabs (Stream / VODs / Clips).
 *
 * Uses the unified shared-player API: the same <video> element is moved
 * between the channel slot, the mini-player, and a hidden parking layer
 * so playback survives route changes without a reload.
 */

import { fetchVods, fetchClips, fetchLiveStatus, fetchViewerCount } from '../api.js';
import { renderChannelProfile, renderStreamTabContent, renderProfileSkeleton, renderVodGrid, renderClipGrid, renderVodPlayerContent, renderClipPlayerContent, renderVodSkeleton } from '../ui.js';
import { appState, preferences } from '../state.js';
import { addToHistory } from '../history.js';
import { toast } from '../toast.js';
import { escapeHtml, debounce } from '../utils.js';
import { navigate } from '../router.js';
import { mountLiveChat } from '../live-chat.js';
import { mountDvrControls, preferredLiveSource, getTimelineModel, dispose as disposeDvrControls } from '../dvr.js';
import {
    getCurrentStream, getCachedChannelData,
    loadStream, setMode, cacheChannelData, stopStream,
} from '../player.js';

let viewerRefreshTimer = null;

function createPlayerSlot(poster = '', { showChat = false } = {}) {
    const stage = document.getElementById('channel-watch-stage');
    const anchor = document.getElementById('channel-player-anchor');
    if (!stage || !anchor) return null;

    const sharedVideo = document.getElementById('sharedVideo');
    if (sharedVideo && anchor.contains(sharedVideo)) setMode('hidden');
    anchor.replaceChildren();
    const slot = document.createElement('div');
    slot.id = 'channel-player-slot';
    slot.className = 'video-container';
    if (poster) slot.dataset.poster = poster;
    anchor.appendChild(slot);

    stage.classList.add('active');
    stage.classList.toggle('show-chat', showChat);
    requestAnimationFrame(() => stage.scrollIntoView({ block: 'start' }));
    return slot;
}

// hidePlayerStage tears down the watch stage — when leaving the stream tab, or
// when a VOD/clip player closes.
//
// Anything still playing is handed to the mini-player rather than parked in the
// hidden layer. 'hidden' moves the video into an off-screen container without
// pausing it, so a live stream carried on playing with no player, no controls and
// no mini-bar: audible, with nothing on screen able to stop it.
function hidePlayerStage() {
    const stage = document.getElementById('channel-watch-stage');
    const anchor = document.getElementById('channel-player-anchor');
    const sharedVideo = document.getElementById('sharedVideo');
    if (sharedVideo && anchor?.contains(sharedVideo)) {
        // No FLIP animation here: a tab switch that restores a VOD player re-projects
        // to full in the same task, and animating a handoff that is immediately
        // undone only produces a flicker.
        if (getCurrentStream()) setMode('mini', null, { collapsePanel: true });
        else setMode('hidden');
    }
    stage?.classList.remove('active', 'show-chat');
    anchor?.replaceChildren();
}

async function initVideoPlayer(playbackUrl, channelSlug, liveData, slot) {
    if (!slot || !playbackUrl) return;

    const miniStream = getCurrentStream();

    if (miniStream?.slug === channelSlug && !['vod', 'clip'].includes(miniStream.type)) {
        // Same channel — just project the already-playing video to full size.
        // HLS stays attached.  Zero interruption. (A rewound stream stays
        // rewound: 'dvr' is this channel's live stream, seen from the past.)
        setMode('full', slot, { animate: true });
        _initDvrControls(playbackUrl, channelSlug, liveData);
        return;
    }

    // Different channel or no active stream — stop any existing stream
    if (miniStream) stopStream();

    // Prefer the rewindable source, so the timeline covers the whole broadcast
    // rather than starting wherever the viewer happened to arrive.
    const source = await preferredLiveSource({ slug: channelSlug, liveUrl: playbackUrl });
    // Resolving it is asynchronous — the viewer may have navigated on, switched
    // tabs, or started something else meanwhile.
    if (!slot.isConnected) return;

    // Fresh load: start HLS on the shared video and project to full
    const streamInfo = {
        slug: channelSlug,
        title: liveData?.data?.livestream_title || channelSlug,
        channel: liveData?.data?.username || channelSlug,
        playbackUrl: source.url,
        // Always the live edge, whatever is playing: cast targets and the
        // "copy stream URL" action want the stream, not a rewound position.
        liveUrl: playbackUrl,
        thumbnailUrl: liveData?.data?.livestream_thumbnail_url || '',
        ...(source.type ? { type: source.type } : {}),
    };
    loadStream(source.url, streamInfo, liveData);
    setMode('full', slot);
    _initDvrControls(playbackUrl, channelSlug, liveData);
}

// Live rewind: available only when Kick is recording the broadcast, which
// dvr.js checks with the backend before the player offers a broadcast timeline.
function _initDvrControls(playbackUrl, channelSlug, liveData) {
    void mountDvrControls({
        slug: channelSlug,
        liveUrl: playbackUrl,
        liveData,
        title: liveData?.data?.livestream_title,
    });
}

// Inline "no matches" state for the VOD/Clip title filters. Without it, a
// zero-match query hides every card and leaves a blank area that looks broken.
function _toggleSearchEmptyState(container, show, term, kind) {
    let el = container.querySelector('.search-no-results');
    if (show) {
        if (!el) {
            el = document.createElement('div');
            el.className = 'search-no-results empty-state';
            container.appendChild(el);
        }
        el.innerHTML = `
            <div class="empty-state-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>
            <div class="empty-state-title">No ${kind} found</div>
            <div class="empty-state-text"></div>`;
        el.querySelector('.empty-state-text').textContent = `Nothing matches “${term}”.`;
    } else if (el) {
        el.remove();
    }
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

    // Live rewind belongs to the stream tab only — tear it down elsewhere so its
    // ticker and key handlers don't outlive the markup they drive.
    if (tab !== 'stream') disposeDvrControls();

    if (tab === 'stream') {
        if (['vod', 'clip'].includes(getCurrentStream()?.type)) stopStream();
        tabContent.innerHTML = renderStreamTabContent(liveData?.data, channelSlug);
        if (liveData?.data?.status === 'live') {
            const slot = createPlayerSlot(liveData.data.livestream_thumbnail_url || '', {
                showChat: Boolean(liveData.data.chatroom_id),
            });
            void initVideoPlayer(liveData.data.playback_url, channelSlug, liveData, slot);
        } else {
            disposeDvrControls();
            hidePlayerStage();
        }
    } else if (tab === 'vods') {
        const activeMedia = getCurrentStream();
        const restoreVod = activeMedia?.slug === channelSlug && activeMedia.type === 'vod';
        if (!restoreVod && ['vod', 'clip'].includes(activeMedia?.type)) stopStream();
        hidePlayerStage();
        if (!vodsData) {
            tabContent.innerHTML = renderVodSkeleton();
            return;
        }
        const vods = vodsData?.data?.vods || [];
        appState.vods = vods;

        if (tabContent._vodClickHandler) {
            tabContent.removeEventListener('click', tabContent._vodClickHandler);
        }

        const _showVod = (card, { reuseActive = false } = {}) => {
            if (!reuseActive && getCurrentStream()) stopStream();

            tabContent.innerHTML = renderVodPlayerContent(card);

            // Cast and playback should use the absolute manifest URL.
            // The proxy redirect route is still kept for "open in new tab".
            const playbackUrl = card.dataset.playbackUrl || card.dataset.sourceUrl || '';
            const slot = createPlayerSlot(card.dataset.vodThumb || '');
            if (!slot) return;

            if (reuseActive) {
                // Re-project the shared video instead of loading it again, so
                // playback position survives the mini-player round trip.
                setMode('full', slot, { animate: true });
            } else {
                const streamInfo = {
                    slug: channelSlug,
                    title: card.dataset.vodTitle || 'VOD',
                    channel: channelSlug,
                    playbackUrl,
                    sourceUrl: card.dataset.sourceUrl || '',
                    thumbnailUrl: card.dataset.vodThumb || '',
                    mediaId: card.dataset.playVod || '',
                    type: 'vod',
                };
                loadStream(playbackUrl, streamInfo, null);
                setMode('full', slot);
            }

            tabContent.querySelector('.vod-back-btn')?.addEventListener('click', () => {
                stopStream();
                hidePlayerStage();
                _renderVodList();
            });
        };

        const _renderVodList = () => {
            const searchHTML = `
                <div style="max-width:400px;margin:0 auto 20px">
                    <input type="text" id="vodSearchInput" placeholder="Search VOD titles..." class="search-input" style="padding-left:12px" maxlength="200">
                </div>`;
            tabContent.innerHTML = searchHTML + renderVodGrid(vods, channelSlug);

            const vodSearch = document.getElementById('vodSearchInput');
            if (vodSearch) {
                vodSearch.addEventListener('input', debounce((e) => {
                    const term = e.target.value.trim().toLowerCase();
                    let visible = 0;
                    tabContent.querySelectorAll('.vod-card').forEach(card => {
                        const title = card.dataset.title || '';
                        const match = !term || title.includes(term);
                        card.style.display = match ? '' : 'none';
                        if (match) visible++;
                    });
                    _toggleSearchEmptyState(tabContent, !!term && visible === 0, e.target.value.trim(), 'VODs');
                }, 200));
            }

            // Click delegation for inline VOD playback
            if (tabContent._vodClickHandler) {
                tabContent.removeEventListener('click', tabContent._vodClickHandler);
            }
            tabContent._vodClickHandler = async (e) => {
                // Ignore clicks on cast/external-link buttons
                if (e.target.closest('.cast-button') || e.target.closest('a[target="_blank"]')) return;
                const card = e.target.closest('[data-play-vod]');
                if (!card) return;
                e.preventDefault();
                _showVod(card);
            };
            tabContent.addEventListener('click', tabContent._vodClickHandler);

            const current = getCurrentStream();
            if (current?.slug === channelSlug && current.type === 'vod') {
                const cards = [...tabContent.querySelectorAll('[data-play-vod]')];
                const activeCard = cards.find(card =>
                    (current.mediaId && card.dataset.playVod === current.mediaId)
                    || (current.playbackUrl && (
                        card.dataset.playbackUrl === current.playbackUrl
                        || card.dataset.sourceUrl === current.playbackUrl
                    ))
                );
                if (activeCard) _showVod(activeCard, { reuseActive: true });
            }
        };
        _renderVodList();

    } else if (tab === 'clips') {
        const activeMedia = getCurrentStream();
        const restoreClip = activeMedia?.slug === channelSlug && activeMedia.type === 'clip';
        if (!restoreClip && ['vod', 'clip'].includes(activeMedia?.type)) stopStream();
        hidePlayerStage();
        if (!clipsData) {
            tabContent.innerHTML = renderVodSkeleton();
            return;
        }
        const clips = clipsData?.data?.clips || [];
        appState.clips = clips;

        if (tabContent._clipClickHandler) {
            tabContent.removeEventListener('click', tabContent._clipClickHandler);
        }

        const _showClip = (card, { reuseActive = false } = {}) => {
            if (!reuseActive && getCurrentStream()) stopStream();

            tabContent.innerHTML = renderClipPlayerContent(card);

            const clipUrl = card.dataset.clipUrl;
            const slot = createPlayerSlot(card.dataset.clipThumb || '');
            if (!slot) return;

            if (reuseActive) {
                setMode('full', slot, { animate: true });
            } else {
                const streamInfo = {
                    slug: channelSlug,
                    title: card.dataset.clipTitle || 'Clip',
                    channel: channelSlug,
                    playbackUrl: clipUrl,
                    sourceUrl: card.dataset.clipSourceUrl || '',
                    thumbnailUrl: card.dataset.clipThumb || '',
                    type: 'clip',
                };
                loadStream(clipUrl, streamInfo, null);
                setMode('full', slot);
            }

            tabContent.querySelector('.vod-back-btn')?.addEventListener('click', () => {
                stopStream();
                hidePlayerStage();
                _renderClipList();
            });
        };

        const _renderClipList = () => {
            const searchHTML = `
                <div style="max-width:400px;margin:0 auto 20px">
                    <input type="text" id="clipSearchInput" placeholder="Search clip titles..." class="search-input" style="padding-left:12px" maxlength="200">
                </div>`;
            tabContent.innerHTML = searchHTML + renderClipGrid(clips);

            const clipSearch = document.getElementById('clipSearchInput');
            if (clipSearch) {
                clipSearch.addEventListener('input', debounce((e) => {
                    const term = e.target.value.trim().toLowerCase();
                    let visible = 0;
                    tabContent.querySelectorAll('.vod-card').forEach(card => {
                        const title = card.dataset.title || '';
                        const match = !term || title.includes(term);
                        card.style.display = match ? '' : 'none';
                        if (match) visible++;
                    });
                    _toggleSearchEmptyState(tabContent, !!term && visible === 0, e.target.value.trim(), 'clips');
                }, 200));
            }

            // Click delegation for inline clip playback
            if (tabContent._clipClickHandler) {
                tabContent.removeEventListener('click', tabContent._clipClickHandler);
            }
            tabContent._clipClickHandler = async (e) => {
                if (e.target.closest('.cast-button') || e.target.closest('a[target="_blank"]')) return;
                const card = e.target.closest('[data-play-clip]');
                if (!card) return;
                e.preventDefault();
                _showClip(card);
            };
            tabContent.addEventListener('click', tabContent._clipClickHandler);

            const current = getCurrentStream();
            if (current?.slug === channelSlug && current.type === 'clip') {
                const cards = [...tabContent.querySelectorAll('[data-play-clip]')];
                const activeCard = cards.find(card =>
                    current.playbackUrl && (
                        card.dataset.clipUrl === current.playbackUrl
                        || card.dataset.clipSourceUrl === current.playbackUrl
                    )
                );
                if (activeCard) _showClip(activeCard, { reuseActive: true });
            }
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

    // Note: we intentionally do NOT mirror the channel slug into the global
    // search box — it's a search field, not a location indicator, and leaving
    // the slug there made it look like a pending search across every route.

    const miniStream = getCurrentStream();
    let liveData, vodsData = null, clipsData = null;
    let vodsPending = false, clipsPending = false;
    let activeTab = miniStream?.slug === channelSlug && miniStream.type === 'vod'
        ? 'vods'
        : miniStream?.slug === channelSlug && miniStream.type === 'clip'
            ? 'clips'
            : 'stream';

    // ── Instant render path: if mini-player has this channel, use cached data ──
    const cachedData = (miniStream?.slug === channelSlug) ? getCachedChannelData() : null;
    let chat = null;
    let chatSyncTimer = null;

    // Chat follows the player: rewound playback shows the messages from that moment
    // (live-chat.js fetches them by timestamp), live playback shows the socket.
    // Polled rather than pushed because the position moves for many reasons —
    // scrubbing, the rewind keys, Go Live, ordinary playback drift.
    const startChatSync = () => {
        stopChatSync();
        chatSyncTimer = setInterval(() => {
            if (!chat?.setReplayPosition) return;
            const model = getTimelineModel();
            if (!model.available) return;
            chat.setReplayPosition(model.atLive ? null : model.wallClockAt(model.position));
        }, 1000);
    };
    const stopChatSync = () => {
        if (chatSyncTimer) { clearInterval(chatSyncTimer); chatSyncTimer = null; }
    };
    let chatHydrationTimer = null;
    let viewDisposed = false;

    const hydrateLiveChat = candidate => {
        const chatroomId = candidate?.data?.chatroom_id;
        if (viewDisposed || liveData?.data?.chatroom_id || !chatroomId) return;

        liveData = candidate;
        chat?.dispose();
        chat = mountLiveChat({ chatroomId, channelSlug });
        startChatSync();
        if (activeTab === 'stream') {
            document.getElementById('channel-watch-stage')?.classList.add('show-chat');
        }
    };

    const scheduleChatHydration = () => {
        const d = liveData?.data;
        if (d?.status !== 'live' || d?.chatroom_id || !d?._partial || chatHydrationTimer) return;
        chatHydrationTimer = setTimeout(async () => {
            chatHydrationTimer = null;
            hydrateLiveChat(await fetchLiveStatus(channelSlug));
        }, 900);
    };

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
        chat = mountLiveChat({ chatroomId: d?.chatroom_id, channelSlug });
        startChatSync();
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
        chat = mountLiveChat({ chatroomId: d?.chatroom_id, channelSlug });
        startChatSync();
        renderTabContent(activeTab, liveData, vodsData, clipsData, channelSlug);

        if (liveData?.data?.status === 'live') {
            startViewerRefresh(liveData.data.livestream_id);
        }
    }

    const d = liveData?.data;
    scheduleChatHydration();

    // Phase 2: refresh the live status, which is what chat hydration needs when
    // /play answered from a partial cache entry. Recordings and clips are *not*
    // fetched here — they load with their own tabs (see loadTabData), so opening a
    // channel doesn't spend two upstream calls on panels nobody is looking at.
    fetchLiveStatus(channelSlug).then(fresh => {
        if (fresh?.status === 'success') hydrateLiveChat(fresh);
    }).catch(() => {});

    // Lazily load whichever tab's data is missing, then re-render if the viewer is
    // still on it.
    const loadTabData = (tab) => {
        if (tab === 'vods' && !vodsData && !vodsPending) {
            vodsPending = true;
            fetchVods(channelSlug).then(data => {
                vodsData = data;
                if (!viewDisposed && activeTab === 'vods') {
                    renderTabContent('vods', liveData, vodsData, clipsData, channelSlug);
                }
            }).catch(() => { vodsPending = false; });
        }
        if (tab === 'clips' && !clipsData && !clipsPending) {
            clipsPending = true;
            fetchClips(channelSlug).then(data => {
                clipsData = data;
                if (!viewDisposed && activeTab === 'clips') {
                    renderTabContent('clips', liveData, vodsData, clipsData, channelSlug);
                }
            }).catch(() => { clipsPending = false; });
        }
    };
    loadTabData(activeTab);

    // Tab switching
    const switchToTab = (tabName) => {
        if (!tabName || tabName === activeTab) return;

        // Leaving the stream tab is handled by renderTabContent, which routes every
        // branch through hidePlayerStage()/createPlayerSlot(). Hiding the video here
        // as well moved it out of the player anchor first, so hidePlayerStage no
        // longer recognised it as its own and skipped the mini-player handoff —
        // leaving a live stream playing with nothing on screen to stop it.
        activeTab = tabName;
        contentEl.querySelectorAll('.profile-tab').forEach(t => {
            const isActive = t.dataset.tab === tabName;
            t.classList.toggle('active', isActive);
            t.setAttribute('aria-selected', String(isActive));
            // Roving tabindex: only the active tab is in the Tab order.
            t.setAttribute('tabindex', isActive ? '0' : '-1');
        });
        const tabPanel = document.getElementById('profile-tab-content');
        if (tabPanel) tabPanel.setAttribute('aria-labelledby', `tab-${tabName}`);

        // Fetch this tab's data the first time it's opened; renderTabContent shows a
        // skeleton until it lands.
        loadTabData(tabName);
        renderTabContent(tabName, liveData, vodsData, clipsData, channelSlug);
    };
    const onTabClick = (e) => {
        const tab = e.target.closest('.profile-tab');
        if (tab) switchToTab(tab.dataset.tab);
    };
    // APG tabs keyboard pattern: Arrow keys move between tabs, Home/End jump.
    const onTabKeydown = (e) => {
        const tabsList = [...contentEl.querySelectorAll('.profile-tab')];
        if (tabsList.length === 0) return;
        const currentIndex = Math.max(0, tabsList.findIndex(t => t.dataset.tab === activeTab));
        let nextIndex = null;
        if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabsList.length;
        else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabsList.length) % tabsList.length;
        else if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = tabsList.length - 1;
        else return;
        e.preventDefault();
        const nextTab = tabsList[nextIndex];
        if (nextTab) { switchToTab(nextTab.dataset.tab); nextTab.focus(); }
    };
    const tabsEl = contentEl.querySelector('.profile-tabs');
    tabsEl?.addEventListener('click', onTabClick);
    tabsEl?.addEventListener('keydown', onTabKeydown);

    // Cleanup — switch to mini mode (stream keeps playing)
    return () => {
        viewDisposed = true;
        if (chatHydrationTimer) clearTimeout(chatHydrationTimer);
        stopViewerRefresh();
        stopChatSync();
        chat?.dispose();
        disposeDvrControls();
        tabsEl?.removeEventListener('click', onTabClick);
        tabsEl?.removeEventListener('keydown', onTabKeydown);

        const currentStream = getCurrentStream();
        if (currentStream) {
            if (d?.status === 'live' && !['vod', 'clip'].includes(currentStream.type)) {
                // Cache live channel data for instant re-render on return.
                cacheChannelData(liveData);
            }
            // Hand off live streams, VODs, and clips to the mini-player so
            // route replacement never removes the shared video element.
            setMode('mini', null, { animate: true, collapsePanel: true });
        }
        // If no media is active, there is nothing to hand off.
    };
}
