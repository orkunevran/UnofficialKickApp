/**
 * Shared utility functions.
 */

export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    const text = String(str);
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
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
        const date = new Date(dateString.replace(' ', 'T') + 'Z');
        return date.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    } catch (e) {
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
        const start = new Date(startTime.replace(' ', 'T') + 'Z');
        const diffMs = Date.now() - start.getTime();
        if (diffMs < 0) return '';
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
    const letter = str[0].toUpperCase();
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
