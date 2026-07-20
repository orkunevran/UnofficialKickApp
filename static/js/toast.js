/**
 * Toast notification system. Auto-dismisses; accent-coded info cards.
 *
 * Behaviour:
 *  - Desktop: stacks bottom-right, capped at MAX_VISIBLE so a burst can't push
 *    earlier toasts off-screen.
 *  - Mobile (<=767px): never stacks — a single toast updates in place as new
 *    messages arrive, so a fast sequence (e.g. a Chromecast scan/connect flow)
 *    can't take over the screen.
 *  - Within DEDUPE_WINDOW_MS, an identical (type + message) toast bumps the
 *    existing one's counter instead of restacking/replacing.
 */

const MAX_VISIBLE = 4;            // desktop stack cap
const DEDUPE_WINDOW_MS = 3000;
const TYPE_CLASSES = ['toast-success', 'toast-error', 'toast-info', 'toast-warning'];

const ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="11"/><line x1="12" y1="7.5" x2="12.01" y2="7.5"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

let toastId = 0;
const recentToasts = new Map(); // key -> { el, count, expiresAt }

function dedupeKey(type, message) {
    return `${type}::${message}`;
}

// Below this width toasts never stack — see the mobile path in toast().
function isMobileSingle() {
    return window.matchMedia('(max-width: 767px)').matches;
}

// Fill a toast element with content, wire its buttons, and (re)start its
// auto-dismiss timer + progress bar. Shared by fresh toasts and the mobile
// in-place replace. Only touches the type/timed classes so a live toast keeps
// its entrance state (opacity/position) when updated in place.
function populateToast(el, { id, message, type, action, duration }) {
    el.classList.add('toast');
    el.classList.remove(...TYPE_CLASSES);
    el.classList.add(`toast-${type}`);
    el.dataset.toastId = id;
    // Errors interrupt (assertive); status/info/warning announce politely.
    const assertive = type === 'error';
    el.setAttribute('role', assertive ? 'alert' : 'status');
    el.setAttribute('aria-live', assertive ? 'assertive' : 'polite');

    el.innerHTML = `
        <span class="toast-icon-chip" aria-hidden="true">${ICONS[type] || ICONS.info}</span>
        <div class="toast-body">
            <p class="toast-message">${escapeToast(message)}</p>
            ${action ? `<button class="toast-action" type="button">${escapeToast(action.label)}</button>` : ''}
        </div>
        <span class="toast-counter hidden" aria-label="repeat count"></span>
        <button class="toast-close" type="button" aria-label="Dismiss">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
        </button>
    `;

    el.querySelector('.toast-close').addEventListener('click', () => dismissToast(el));
    if (action?.onClick) {
        el.querySelector('.toast-action')?.addEventListener('click', () => {
            action.onClick();
            dismissToast(el);
        });
    }

    // Auto-dismiss + countdown bar. Toggling toast-timed (with a reflow between)
    // restarts the bar animation when a mobile toast is updated in place.
    if (el._dismissTimer) { clearTimeout(el._dismissTimer); el._dismissTimer = null; }
    el.classList.remove('toast-timed');
    if (duration > 0) {
        el.style.setProperty('--toast-duration', `${duration}ms`);
        void el.offsetWidth; // reflow so the gated ::after animation restarts
        el.classList.add('toast-timed');
        el._dismissTimer = setTimeout(() => dismissToast(el), duration);
    } else {
        el.style.setProperty('--toast-duration', '0s');
    }
}

export function toast(message, type = 'info', options = {}) {
    const { duration = type === 'error' ? 8000 : 4000, action = null } = options;
    const container = document.getElementById('toast-container');
    if (!container) return;

    const key = dedupeKey(type, message);
    const now = Date.now();

    // Dedupe: identical toast within the window → bump counter, don't restack.
    const recent = recentToasts.get(key);
    if (recent && now < recent.expiresAt && document.body.contains(recent.el)) {
        recent.count++;
        const counter = recent.el.querySelector('.toast-counter');
        if (counter) {
            counter.textContent = `×${recent.count}`;
            counter.classList.remove('hidden');
        }
        recent.expiresAt = now + DEDUPE_WINDOW_MS;
        return recent.el.dataset.toastId;
    }

    const id = ++toastId;

    // Mobile: reuse the single live toast, updating it in place (never stack)
    // — UNLESS the live toast carries something the user shouldn't lose.
    if (isMobileSingle()) {
        const existing = container.querySelector('.toast:not(.toast-exit)');
        if (existing) {
            const existingHasAction = !!existing.querySelector('.toast-action');
            const existingIsError = existing.classList.contains('toast-error');
            // Preserve a toast with a live Undo/Retry action, or an error that a
            // lower-priority info/success shouldn't bury: show the new message as
            // a second toast rather than overwriting (which would destroy the
            // action button and restart the timer).
            const mustPreserve = existingHasAction || (existingIsError && type !== 'error');
            if (!mustPreserve) {
                // Re-key the dedupe map onto this element under the new message.
                for (const [k, entry] of recentToasts) {
                    if (entry.el === existing) recentToasts.delete(k);
                }
                populateToast(existing, { id, message, type, action, duration });
                recentToasts.set(key, { el: existing, count: 1, expiresAt: now + DEDUPE_WINDOW_MS });
                // Pulse the icon chip so the in-place swap is noticeable.
                const chip = existing.querySelector('.toast-icon-chip');
                if (chip) { void chip.offsetWidth; chip.classList.add('toast-chip-pulse'); }
                return id;
            }
            // Preserve the existing toast; keep the mobile stack to 2 by dropping
            // the oldest toast that has no live action, then fall through to append.
            const live = [...container.querySelectorAll('.toast:not(.toast-exit)')];
            if (live.length >= 2) {
                dismissToast(live.find(t => !t.querySelector('.toast-action')) || live[0]);
            }
        }
    } else {
        // Desktop: cap the stack, dismissing the oldest when full.
        const live = container.querySelectorAll('.toast:not(.toast-exit)');
        if (live.length >= MAX_VISIBLE) {
            dismissToast(live[0]);
        }
    }

    const el = document.createElement('div');
    populateToast(el, { id, message, type, action, duration });
    recentToasts.set(key, { el, count: 1, expiresAt: now + DEDUPE_WINDOW_MS });
    container.appendChild(el);
    // Trigger enter animation
    requestAnimationFrame(() => el.classList.add('toast-enter'));
    return id;
}

function dismissToast(el) {
    if (!el || el.classList.contains('toast-exit')) return;
    if (el._dismissTimer) { clearTimeout(el._dismissTimer); el._dismissTimer = null; }
    el.classList.add('toast-exit');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    // Fallback removal
    setTimeout(() => { if (el.parentNode) el.remove(); }, 400);
    // Drop dedupe entries that point to this element.
    for (const [key, entry] of recentToasts) {
        if (entry.el === el) recentToasts.delete(key);
    }
}

function escapeToast(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Convenience methods
export const toastSuccess = (msg, opts) => toast(msg, 'success', opts);
export const toastError = (msg, opts) => toast(msg, 'error', opts);
export const toastInfo = (msg, opts) => toast(msg, 'info', opts);
export const toastWarning = (msg, opts) => toast(msg, 'warning', opts);
