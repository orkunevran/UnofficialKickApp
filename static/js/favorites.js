/**
 * Favorites system. Stores favorite channels in localStorage.
 * Dispatches 'favorites-changed' custom event for reactive updates.
 */

const STORAGE_KEY = 'kick-api-favorites';

function load() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch {
        return [];
    }
}

function save(favorites) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
    } catch {
        // Storage full or unavailable — non-fatal, event still dispatches
    }
    window.dispatchEvent(new CustomEvent('favorites-changed', { detail: { favorites } }));
}

export function getFavorites() {
    return load();
}

export function getFavoriteCount() {
    return load().length;
}

export function isFavorite(slug) {
    return load().some(f => f.slug === slug);
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
