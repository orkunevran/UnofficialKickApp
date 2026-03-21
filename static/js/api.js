const API_TIMEOUT_MS = 15000;

function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export async function fetchFeaturedStreams(language = 'en', page = 1, filters = {}) {
    try {
        const {
            category = '',
            subcategory = '',
            subcategories = '',
            sort = '',
            strict = false,
        } = filters || {};
        const params = new URLSearchParams({ language, page });
        if (category) params.set('category', category);
        if (subcategory) params.set('subcategory', subcategory);
        if (subcategories) params.set('subcategories', subcategories);
        if (sort) params.set('sort', sort);
        if (strict) params.set('strict', 'true');
        const response = await fetchWithTimeout(`/streams/featured-livestreams?${params}`);
        if (!response.ok) {
            throw new Error('Failed to fetch featured livestreams');
        }
        return await response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Request timed out. Please try again.');
        }
        throw error;
    }
}

export async function fetchChannelData(channelSlug) {
    try {
        const livePromise = fetchWithTimeout(`/streams/play/${channelSlug}`).then(async res => {
            if (res.status >= 500) {
                throw new Error(`Live stream API Error: ${res.status}`);
            }
            return await res.json();
        });
        const vodsPromise = fetchWithTimeout(`/streams/vods/${channelSlug}`).then(async res => {
            if (res.status >= 500) {
                throw new Error(`VODs API Error: ${res.status}`);
            }
            return await res.json();
        });
        const clipsPromise = fetchWithTimeout(`/streams/clips/${channelSlug}`).then(async res => {
            if (!res.ok) return { status: 'error', data: { clips: [] } };
            return await res.json();
        });

        const [liveData, vodsData, clipsData] = await Promise.all([livePromise, vodsPromise, clipsPromise]);
        return { liveData, vodsData, clipsData };
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Request timed out. Please try again.');
        }
        throw error;
    }
}

export function fetchSearchResults(query, featuredStreams = []) {
    // Client-side search over already-loaded featured streams data.
    // Kick.com's search API is behind a stricter Cloudflare tier and cannot be accessed.
    const term = query.toLowerCase().trim();
    const seen = new Set();
    const results = [];

    featuredStreams.forEach(stream => {
        const slug = stream.channel?.slug || stream.slug || '';
        const user = stream.channel?.user || {};
        const username = user.username || slug;
        if (!slug || seen.has(slug)) return;
        if (slug.toLowerCase().includes(term) || username.toLowerCase().includes(term)) {
            seen.add(slug);
            results.push({
                slug,
                username,
                // 'profilepic' is the actual field name in the Kick API response
                profile_picture: user.profilepic || null,
                viewer_count: stream.viewer_count || 0,
                is_live: stream.is_live !== false,
                stream_title: stream.session_title || null,
                category: stream.categories?.[0]?.name || null,
            });
        }
    });

    return { status: 'success', data: results.slice(0, 8) };
}

export async function fetchChannelAvatar(slug) {
    // Fetches a single channel's profile picture via a 7-day cached endpoint.
    // Returns the URL string, or null on any failure.
    try {
        const response = await fetchWithTimeout(`/streams/avatar/${encodeURIComponent(slug)}`, {}, 4000);
        if (!response.ok) return null;
        const d = await response.json();
        return d?.data?.profile_picture || null;
    } catch {
        return null;
    }
}

export async function fetchChannelSearch(query) {
    // Server-side Typesense search — covers all 500k+ Kick channels.
    // The backend handles key rotation; we simply call the proxy endpoint.
    // Returns null on any failure so callers can fall back to the local pool.
    try {
        const response = await fetchWithTimeout(
            `/streams/search?q=${encodeURIComponent(query)}`, {}, 6000
        );
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

export async function fetchViewerCount(livestreamId) {
    try {
        const response = await fetchWithTimeout(`/streams/viewers?id=${livestreamId}`, {}, 5000);
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        return null; // Silent fail — viewer count refresh is non-critical
    }
}

// ── Chromecast API ───────────────────────────────────────────────────────

export async function fetchChromecastDevices(force = false, knownHosts = null) {
    const url = new URL('/api/chromecast/devices', window.location.origin);
    if (force) url.searchParams.set('force', 'true');
    if (knownHosts) url.searchParams.set('known_hosts', knownHosts);
    const response = await fetchWithTimeout(url, {}, 10000);
    if (!response.ok) throw new Error('Failed to discover devices');
    return await response.json();
}

export async function postChromecastSelect(uuid) {
    const response = await fetchWithTimeout('/api/chromecast/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid }),
    }, 10000);
    return { data: await response.json(), status: response.status };
}

export async function postChromecastCast(streamUrl, title) {
    const response = await fetchWithTimeout('/api/chromecast/cast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stream_url: streamUrl, title }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
}

export async function postChromecastStop(uuid) {
    const response = await fetchWithTimeout('/api/chromecast/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid }),
    });
    return await response.json();
}

export async function fetchChromecastStatus() {
    const response = await fetchWithTimeout('/api/chromecast/status', {}, 8000);
    if (!response.ok) return null;
    return await response.json();
}
