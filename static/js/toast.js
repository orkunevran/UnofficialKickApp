/**
 * Toast notification system. Stacks bottom-right, auto-dismisses.
 */

let toastId = 0;

export function toast(message, type = 'info', options = {}) {
    const { duration = type === 'error' ? 8000 : 4000, action = null } = options;
    const container = document.getElementById('toast-container');
    if (!container) return;

    const id = ++toastId;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.dataset.toastId = id;
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'assertive');

    const icons = {
        success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>',
        error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
        warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    };

    el.innerHTML = `
        <div class="toast-icon">${icons[type] || icons.info}</div>
        <div class="toast-body">
            <span class="toast-message">${escapeToast(message)}</span>
            ${action ? `<button class="toast-action">${escapeToast(action.label)}</button>` : ''}
        </div>
        <button class="toast-close" aria-label="Dismiss">&times;</button>
    `;

    // Event handlers
    el.querySelector('.toast-close').addEventListener('click', () => dismissToast(el));
    if (action?.onClick) {
        el.querySelector('.toast-action')?.addEventListener('click', () => {
            action.onClick();
            dismissToast(el);
        });
    }

    container.appendChild(el);
    // Set CSS variable for the countdown bar animation duration
    if (duration > 0) {
        el.style.setProperty('--toast-duration', `${duration}ms`);
    } else {
        // No auto-dismiss — hide the progress bar
        el.style.setProperty('--toast-duration', '0s');
    }
    // Trigger enter animation
    requestAnimationFrame(() => el.classList.add('toast-enter'));

    // Auto dismiss
    if (duration > 0) {
        setTimeout(() => dismissToast(el), duration);
    }

    return id;
}

function dismissToast(el) {
    if (!el || el.classList.contains('toast-exit')) return;
    el.classList.add('toast-exit');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    // Fallback removal
    setTimeout(() => { if (el.parentNode) el.remove(); }, 400);
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
