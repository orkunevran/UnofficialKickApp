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
    sidebarCollapsed: false,
    chromecast: {
        lastDeviceUUID: null,
        lastDeviceName: null,
    },
};

export function loadPreferences() {
    try {
        const saved = JSON.parse(localStorage.getItem(PREFS_KEY));
        if (saved) Object.assign(preferences, saved);
    } catch { /* ignore */ }
}

export function savePreferences() {
    localStorage.setItem(PREFS_KEY, JSON.stringify(preferences));
}

export function updatePreference(key, value) {
    preferences[key] = value;
    savePreferences();
}
