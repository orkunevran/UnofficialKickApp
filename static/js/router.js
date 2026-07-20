/**
 * Lightweight hash-based SPA router.
 * Routes: #/browse, #/channel/:slug, #/favorites, #/history, #/settings
 */

import { renderErrorState } from './ui.js';

const routes = [];
let currentCleanup = null;
let currentRoute = null;
// Monotonic token guarding against overlapping async navigations. Each resolve()
// captures its token; after any await it bails if a newer navigation has started,
// so a slow handler (e.g. a channel mount awaiting a fetch) can't clobber the
// newer view's currentCleanup or write stale content into #content-area.
let navToken = 0;
const scrollPositions = new Map();

export function route(pattern, handler) {
    // Convert pattern like '/channel/:slug' to regex
    const paramNames = [];
    const regexStr = pattern.replace(/:([^/]+)/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
    });
    routes.push({
        pattern,
        regex: new RegExp(`^${regexStr}$`),
        paramNames,
        handler,
    });
}

export function navigate(path, { replace = false } = {}) {
    if (replace) {
        history.replaceState(null, '', `#${path}`);
    } else {
        history.pushState(null, '', `#${path}`);
    }
    resolve();
}

export function getCurrentRoute() {
    return currentRoute;
}

function getPath() {
    const hash = window.location.hash.slice(1) || '/browse';
    return hash.startsWith('/') ? hash : `/${hash}`;
}

function matchRoute(path) {
    for (const r of routes) {
        const match = path.match(r.regex);
        if (match) {
            const params = {};
            r.paramNames.forEach((name, i) => {
                params[name] = decodeURIComponent(match[i + 1]);
            });
            return { route: r, params };
        }
    }
    return null;
}

async function resolve() {
    const path = getPath();
    const matched = matchRoute(path);

    if (currentRoute && currentRoute.path === path) {
        return; // Prevent tearing down DOM when clicking the currently active tab
    }

    // Claim this navigation. Anything that started earlier and is still awaiting
    // will see token !== navToken after its await and abort.
    const token = ++navToken;

    // Save scroll position for current route
    const contentArea = document.getElementById('content-area');
    if (currentRoute && contentArea) {
        scrollPositions.set(currentRoute.path, contentArea.scrollTop);
    }

    // Cleanup previous view
    if (currentCleanup) {
        try { await currentCleanup(); } catch (e) { console.error('Route cleanup error:', e); }
        currentCleanup = null;
    }
    // A newer navigation superseded us while we awaited cleanup — let it win.
    if (token !== navToken) return;

    if (!matched) {
        if (path === '/browse') return; // guard against redirect loop
        navigate('/browse', { replace: true });
        return;
    }

    currentRoute = { path, params: matched.params, pattern: matched.route.pattern };

    // Update sidebar active state
    updateSidebarActive(path);
    announceRoute(path);

    if (contentArea) contentArea.setAttribute('aria-busy', 'true');
    try {
        const cleanup = await matched.route.handler(matched.params, contentArea);
        if (token !== navToken) {
            // Superseded while the handler was awaiting (e.g. a slow fetch).
            // Run the orphaned cleanup so its timers/listeners don't leak, and
            // leave currentCleanup/content to the navigation that won.
            if (typeof cleanup === 'function') {
                try { cleanup(); } catch (e) { console.error('Stale route cleanup error:', e); }
            }
            return;
        }
        currentCleanup = cleanup;
        restoreScroll(path, contentArea);
        playRouteEnter(contentArea);
    } catch (err) {
        // Error boundary: a throwing mount must not leave a blank screen.
        if (token !== navToken) return; // superseded — let the winner own the screen
        console.error('Route render error:', err);
        currentCleanup = null;
        if (contentArea) {
            contentArea.innerHTML = renderErrorState('Something went wrong', 'This page failed to load.');
            contentArea.querySelector('[data-error-retry]')?.addEventListener('click', () => {
                currentRoute = null; // bypass the same-path guard so the route re-runs
                resolve();
            });
            playRouteEnter(contentArea);
        }
    } finally {
        if (token === navToken && contentArea) contentArea.setAttribute('aria-busy', 'false');
    }
}

// Custom view-enter animation. Replaces the Chrome-only View Transitions API
// (which left Safari/Firefox with abrupt cuts) with a fade+slide that runs on
// every browser. Honors prefers-reduced-motion.
function playRouteEnter(el) {
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.classList.remove('route-enter');
    void el.offsetWidth; // restart the animation if it's mid-flight
    el.classList.add('route-enter');
}

function restoreScroll(path, contentArea) {
    if (!contentArea) return;
    const saved = scrollPositions.get(path);
    if (saved != null) {
        contentArea.scrollTop = saved;
    } else {
        contentArea.scrollTop = 0;
    }
}

function updateSidebarActive(path) {
    document.querySelectorAll('[data-nav-route]').forEach(el => {
        const navRoute = el.dataset.navRoute;
        const isActive = path === navRoute || (navRoute !== '/browse' && path.startsWith(navRoute));
        _setNavActive(el, isActive);
    });
    // Special case: /browse is default and also matches /channel
    const browseNav = document.querySelectorAll('[data-nav-route="/browse"]');
    browseNav.forEach(el => _setNavActive(el, path === '/browse' || path.startsWith('/channel')));
}

// Reflect active nav both visually (class) and semantically (aria-current) so
// screen-reader users know which section they're in.
function _setNavActive(el, isActive) {
    el.classList.toggle('active', isActive);
    if (isActive) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
}

// Announce the current view into the dedicated live region (see index.html).
function announceRoute(path) {
    const region = document.getElementById('route-announcer');
    if (!region) return;
    let name = 'Browse';
    if (path.startsWith('/favorites')) name = 'Favorites';
    else if (path.startsWith('/history')) name = 'History';
    else if (path.startsWith('/settings')) name = 'Settings';
    else if (path.startsWith('/channel/')) name = `${decodeURIComponent(path.split('/')[2] || '')} channel`;
    region.textContent = `${name} page`;
}

let initialized = false;

export function init() {
    if (initialized) return;
    initialized = true;
    window.addEventListener('hashchange', resolve);
    // Set default route if none
    if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/') {
        history.replaceState(null, '', '#/browse');
    }
    resolve();
}
