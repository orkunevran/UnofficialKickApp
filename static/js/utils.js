/**
 * Shared utility functions.
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escapes the five HTML-significant characters. Unlike a textNode-based escape,
// this also encodes quotes, so the result is safe in BOTH element text AND
// quoted-attribute contexts (data-*, title, alt, src, aria-label, …). Most
// values rendered here are third-party Kick data (stream titles, usernames,
// bios) interpolated into attributes, so quote escaping is required to prevent
// attribute-breakout XSS.
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

// Returns url if it is a same-origin (relative/hash) or http(s) URL, otherwise
// the fallback. Blocks dangerous schemes (javascript:, data:, vbscript:) before
// a third-party URL is placed into an href. Note: escapeHtml does not help here
// — `javascript:alert(1)` contains no HTML-significant characters.
export function safeUrl(url, fallback = '#') {
    if (url === null || url === undefined) return fallback;
    const trimmed = String(url).trim();
    if (!trimmed) return fallback;
    // Same-origin: hash, dot-relative, or absolute-path — but NOT "//host"
    // (protocol-relative), which resolves to an external origin.
    if (/^(?:#|\.|\/(?!\/))/.test(trimmed)) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) return trimmed; // explicit http(s)
    return fallback;                                   // reject everything else
}

export function getNestedProperty(obj, path) {
    if (!path) return obj;
    const pathParts = path.replace(/\[(\w+)\]/g, '.$1').split('.');
    return pathParts.reduce((acc, part) => acc && acc[part], obj);
}

export function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return 'N/A';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatDate(dateString) {
    if (!dateString) return 'N/A';
    try {
        // Kick API returns timestamps like "2026-01-01 00:00:00" (no T, no TZ).
        // Normalize the space to T for Date parsing. Only append Z if the
        // string has no existing timezone indicator (+, -, Z at the end).
        let normalized = dateString.replace(' ', 'T');
        if (!/[Zz+\-]\d{0,4}$/.test(normalized)) normalized += 'Z';
        const date = new Date(normalized);
        if (isNaN(date.getTime())) return dateString;
        return date.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    } catch {
        return dateString;
    }
}

export function formatRelativeTime(dateString) {
    if (!dateString) return '';
    try {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ago`;
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays < 7) return `${diffDays}d ago`;
        return formatDate(dateString);
    } catch {
        return '';
    }
}

export function formatUptime(startTime) {
    if (!startTime) return '';
    try {
        let normalized = startTime.replace(' ', 'T');
        if (!/[Zz+\-]\d{0,4}$/.test(normalized)) normalized += 'Z';
        const start = new Date(normalized);
        const diffMs = Date.now() - start.getTime();
        if (diffMs < 0 || isNaN(diffMs)) return '';
        const mins = Math.floor(diffMs / 60000);
        if (mins < 60) return `${mins}m`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${h}h ${m}m`;
    } catch {
        return '';
    }
}

export function formatViewerCount(n) {
    if (n === null || n === undefined) return 'N/A';
    n = Number(n);
    if (!Number.isFinite(n)) return 'N/A';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString('en-US');
}

export function initialsAvatar(name, large = false) {
    const str = String(name || '?');
    const letter = escapeHtml(str[0].toUpperCase());
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 16777619) >>> 0;
    }
    const hue = hash % 360;
    const bg = `hsl(${hue},45%,32%)`;
    const sizeClass = large ? 'w-20 h-20 text-2xl' : 'w-8 h-8 text-sm';
    return `<div class="initials-avatar ${sizeClass}" style="background:${bg}">${letter}</div>`;
}

export function copyToClipboard(button, text) {
    const originalHTML = button.innerHTML;

    const succeed = () => {
        button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Copied!';
        button.classList.add('copied');
        setTimeout(() => {
            button.innerHTML = originalHTML;
            button.classList.remove('copied');
        }, 1500);
    };

    const fail = (err) => {
        console.error('Failed to copy text: ', err);
    };

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(succeed).catch(fail);
    } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { document.execCommand('copy'); succeed(); } catch (err) { fail(err); }
        document.body.removeChild(ta);
    }
}

export function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

export function throttle(fn, limit = 200) {
    let inThrottle;
    return (...args) => {
        if (!inThrottle) {
            fn(...args);
            inThrottle = true;
            setTimeout(() => { inThrottle = false; }, limit);
        }
    };
}

export function cn(...classes) {
    return classes.filter(Boolean).join(' ');
}
