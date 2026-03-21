/**
 * Watch history. Tracks recently viewed channels/VODs in localStorage.
 * Max 50 entries, deduplicates by slug + type.
 */

const STORAGE_KEY = 'kick-api-history';
const MAX_ENTRIES = 50;

function load() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch {
        return [];
    }
}

function save(history) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
}

export function getHistory(limit = MAX_ENTRIES) {
    return load().slice(0, limit);
}

export function addToHistory({ slug, username, title, type = 'stream', thumbnailUrl = null, profilePicture = null }) {
    const history = load();
    // Remove existing entry with same slug + type
    const filtered = history.filter(h => !(h.slug === slug && h.type === type));
    // Prepend new entry
    filtered.unshift({
        slug,
        username: username || slug,
        title: title || '',
        type,
        thumbnailUrl,
        profilePicture,
        timestamp: new Date().toISOString(),
    });
    // Cap at max
    save(filtered.slice(0, MAX_ENTRIES));
}

export function removeFromHistory(slug, type = 'stream') {
    const history = load().filter(h => !(h.slug === slug && h.type === type));
    save(history);
    window.dispatchEvent(new CustomEvent('history-changed'));
}

export function clearHistory() {
    save([]);
    window.dispatchEvent(new CustomEvent('history-changed'));
}

export function getHistoryCount() {
    return load().length;
}
