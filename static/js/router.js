/**
 * Lightweight hash-based SPA router.
 * Routes: #/browse, #/channel/:slug, #/favorites, #/history, #/settings
 */

const routes = [];
let currentCleanup = null;
let currentRoute = null;
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

    // Safari has partial/experimental View Transitions support that causes
    // visual glitches (blank frames, doubled content).  Only use on Chrome/Chromium.
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const shouldAnimate = Boolean(document.startViewTransition && currentRoute && !isSafari);

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
    if (!matched) {
        if (path === '/browse') return; // guard against redirect loop
        navigate('/browse', { replace: true });
        return;
    }

    currentRoute = { path, params: matched.params, pattern: matched.route.pattern };

    // Update sidebar active state
    updateSidebarActive(path);

    if (contentArea) contentArea.setAttribute('aria-busy', 'true');
    const render = () => matched.route.handler(matched.params, contentArea);
    if (shouldAnimate) {
        document.startViewTransition(async () => {
            currentCleanup = await render();
            restoreScroll(path, contentArea);
        });
    } else {
        currentCleanup = await render();
        restoreScroll(path, contentArea);
    }
    if (contentArea) contentArea.setAttribute('aria-busy', 'false');
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
        el.classList.toggle('active', isActive);
    });
    // Special case: /browse is default and also matches /channel
    const browseNav = document.querySelector('[data-nav-route="/browse"]');
    if (browseNav) {
        browseNav.classList.toggle('active', path === '/browse' || path.startsWith('/channel'));
    }
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
