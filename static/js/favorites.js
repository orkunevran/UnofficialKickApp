/**
 * Favorites system. Stores favorite channels in localStorage.
 * Dispatches 'favorites-changed' custom event for reactive updates.
 */

const STORAGE_KEY = 'kick-api-favorites';
let cachedFavorites = null;
let cachedFavoriteSet = null;

function syncCache(favorites) {
    cachedFavorites = Array.isArray(favorites) ? favorites : [];
    cachedFavoriteSet = new Set(cachedFavorites.map(f => f?.slug).filter(Boolean));
    return cachedFavorites;
}

function load() {
    if (cachedFavorites) return cachedFavorites;
    try {
        return syncCache(JSON.parse(localStorage.getItem(STORAGE_KEY)) || []);
    } catch {
        return syncCache([]);
    }
}

function save(favorites) {
    syncCache(favorites);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
    } catch {
        // Storage full or unavailable — non-fatal, event still dispatches
    }
    window.dispatchEvent(new CustomEvent('favorites-changed', { detail: { favorites } }));
}

export function getFavorites() {
    return [...load()];
}

export function getFavoriteCount() {
    return load().length;
}

export function isFavorite(slug) {
    return cachedFavoriteSet ? cachedFavoriteSet.has(slug) : load().some(f => f.slug === slug);
}

export function addFavorite(slug, username, profilePicture = null) {
    const favorites = load();
    if (favorites.some(f => f.slug === slug)) return;
    favorites.push({ slug, username, profilePicture, addedAt: new Date().toISOString() });
    save(favorites);
}

export function removeFavorite(slug) {
    const favorites = load().filter(f => f.slug !== slug);
    save(favorites);
}

export function toggleFavorite(slug, username, profilePicture = null) {
    if (isFavorite(slug)) {
        removeFavorite(slug);
        return false;
    } else {
        addFavorite(slug, username, profilePicture);
        return true;
    }
}

export function clearFavorites() {
    save([]);
}

window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    try {
        syncCache(event.newValue ? JSON.parse(event.newValue) : []);
    } catch {
        syncCache([]);
    }
});
