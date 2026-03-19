import { showMessage } from './ui.js';

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

/**
 * Returns an HTML string for an initials avatar when no profile picture is available.
 * The background colour is derived from a hash of the name so each channel gets a
 * consistent colour across page loads (same approach as Gmail / Slack avatars).
 */
export function initialsAvatar(name, large = false) {
    const str = String(name || '?');
    const letter = str[0].toUpperCase();
    // FNV-1a-inspired hash for a stable hue from the channel name
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 16777619) >>> 0;
    }
    const hue = hash % 360;
    const bg = `hsl(${hue},45%,32%)`;
    if (large) {
        return `<div class="profile-avatar-initials" style="background:${bg}">${letter}</div>`;
    }
    return `<div class="suggestion-avatar suggestion-avatar--initials" style="background:${bg}">${letter}</div>`;
}

export function copyToClipboard(button, text) {
    const originalText = button.textContent;

    const succeed = () => {
        button.textContent = 'Copied!';
        button.classList.add('copied');
        setTimeout(() => {
            button.textContent = originalText;
            button.classList.remove('copied');
        }, 3000);
    };

    const fail = (err) => {
        console.error('Failed to copy text: ', err);
        button.textContent = originalText;
        button.classList.remove('copied');
    };

    // navigator.clipboard requires HTTPS or localhost (secure context).
    // Fall back to execCommand for HTTP (e.g. local Pi IP).
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
