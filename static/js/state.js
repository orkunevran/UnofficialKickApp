/**
 * Central application state store.
 */

const PREFS_KEY = 'kick-api-preferences';

export const appState = {
    vods: [],
    featuredStreams: [],
    clips: [],
    searchPool: [],
    currentChannel: null,
    /** Cached /config/languages response — fetched once at init, never re-fetched. */
    languagesConfig: null,
};

export const vodsSortState = {
    column: 'created_at',
    direction: 'desc',
};

export const featuredSortState = {
    column: null,
    direction: 'desc',
};

export const preferences = {
    language: null,       // null = use server default
    viewMode: 'grid',    // 'grid' or 'list'
    theme: 'system',     // 'system' | 'light' | 'dark'
    sidebarCollapsed: false,
    filtersCollapsed: true,
    chromecast: {
        lastDeviceUUID: null,
        lastDeviceName: null,
    },
    defaultSort: { column: null, direction: 'desc' },
    autoRefresh: true,
    autoRefreshInterval: 120,   // seconds
    historyEnabled: true,
    // Which source a live channel opens with. 'edge' (the default) goes straight
    // to the live stream — the point of opening a live channel — and loads the
    // rewind window in the background, ready for the first time it's asked for.
    // 'timeline' opens on the recording instead, so the whole broadcast is on the
    // scrubber immediately, at the cost of a slower start and ~40s more latency.
    liveStartMode: 'edge',
    // Playback has to start muted for autoplay to be allowed, but only until the
    // viewer says otherwise — after that every stream opens with sound at the level
    // they left it. Written by rememberVolume() in player.js on an explicit change,
    // never from the volume the player sets itself on load.
    playerVolume: 1,
    playerMuted: true,
};

export function loadPreferences() {
    try {
        const saved = JSON.parse(localStorage.getItem(PREFS_KEY));
        if (saved) Object.assign(preferences, saved);
    } catch { /* corrupt or unavailable localStorage — use defaults */ }
}

export function savePreferences() {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(preferences));
    } catch {
        // QuotaExceededError (storage full / Safari private browsing)
        // or SecurityError (restrictive iframe sandbox). Non-fatal —
        // preferences won't persist but the app remains functional.
    }
}

export function updatePreference(key, value) {
    preferences[key] = value;
    savePreferences();
}
