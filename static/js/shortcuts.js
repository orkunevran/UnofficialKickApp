/**
 * Global keyboard shortcuts.
 *
 * Single keys:  /  → focus search
 *               ?  → show shortcuts modal
 *               t  → cycle theme (system → light → dark)
 *             Esc  → close modal / blur input
 *
 * Two-key "go" combos (press g, then within 800ms press a second key):
 *   g b → Browse    g f → Favorites    g h → History    g s → Settings
 */

let _goPrefix = false;
let _goTimer = null;

function _clearGoPrefix() {
    _goPrefix = false;
    clearTimeout(_goTimer);
}

function _showShortcutsModal() {
    const modal = document.getElementById('shortcuts-modal');
    if (!modal) return;
    modal.style.display = 'block';
    requestAnimationFrame(() => modal.classList.add('visible'));

    // Focus the close button so screen readers land inside the modal
    const closeBtn = modal.querySelector('.close-button');
    if (closeBtn) closeBtn.focus();

    // Focus trap — keep Tab cycling within the modal
    const focusableSelector = 'button, [href], input, select, [tabindex]:not([tabindex="-1"])';
    const trapFocus = (e) => {
        if (e.key !== 'Tab') return;
        const focusable = [...modal.querySelectorAll(focusableSelector)].filter(el => el.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
            if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
            if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    };
    modal.addEventListener('keydown', trapFocus);

    // Any key (except Tab) or click dismisses
    const dismiss = (e) => {
        // Let Tab pass through to the focus trap
        if (e.type === 'keydown' && e.key === 'Tab') return;
        modal.classList.remove('visible');
        setTimeout(() => { modal.style.display = 'none'; }, 200);
        document.removeEventListener('keydown', dismiss);
        modal.removeEventListener('click', onBackdropClick);
        modal.removeEventListener('keydown', trapFocus);
    };
    const onBackdropClick = (e) => {
        if (e.target === modal || e.target.closest('.close-button')) dismiss(e);
    };
    // Delay listener registration so the '?' keydown doesn't immediately dismiss
    setTimeout(() => {
        document.addEventListener('keydown', dismiss, { once: false });
        modal.addEventListener('click', onBackdropClick);
    }, 100);
}

function _cycleTheme() {
    const { preferences, savePreferences } = window.__stateModule || {};
    if (!preferences) return;

    const order = ['system', 'light', 'dark'];
    const current = preferences.theme || 'system';
    const next = order[(order.indexOf(current) + 1) % order.length];

    preferences.theme = next;
    savePreferences();
    window.__applyTheme?.(next);

    // Sync settings dropdown if visible
    const sel = document.getElementById('settings-theme');
    if (sel) sel.value = next;
}

export function initShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Don't handle shortcuts when typing in inputs
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
            if (e.key === 'Escape') {
                if (e.target.id === 'chromecast-device-search') {
                    const closeButton = document.querySelector('#chromecast-modal .close-button');
                    if (closeButton) closeButton.click();
                    return;
                }
                e.target.blur();
                const sugg = document.getElementById('searchSuggestions');
                if (sugg) sugg.style.display = 'none';
            }
            return;
        }

        // "Go" prefix combos — g was pressed, now check the second key
        if (_goPrefix) {
            _clearGoPrefix();
            const { navigate } = window.__routerModule || {};
            if (!navigate) return;
            switch (e.key) {
                case 'b': e.preventDefault(); navigate('/browse'); return;
                case 'f': e.preventDefault(); navigate('/favorites'); return;
                case 'h': e.preventDefault(); navigate('/history'); return;
                case 's': e.preventDefault(); navigate('/settings'); return;
            }
            // Unrecognized second key — fall through to normal handling
        }

        switch (e.key) {
            case '/': {
                e.preventDefault();
                const searchInput = document.getElementById('channelSlugInput');
                if (searchInput) searchInput.focus();
                break;
            }
            case '?': {
                e.preventDefault();
                _showShortcutsModal();
                break;
            }
            case 't': {
                _cycleTheme();
                break;
            }
            case 'g': {
                // Start "go" prefix — wait for second key
                _goPrefix = true;
                _goTimer = setTimeout(_clearGoPrefix, 800);
                break;
            }
            case 'Escape': {
                // Close shortcuts modal
                const shortcutsModal = document.getElementById('shortcuts-modal');
                if (shortcutsModal && shortcutsModal.style.display === 'block') {
                    shortcutsModal.classList.remove('visible');
                    setTimeout(() => { shortcutsModal.style.display = 'none'; }, 200);
                    return;
                }
                // Close chromecast modal
                const modal = document.getElementById('chromecast-modal');
                if (modal && modal.style.display === 'block') {
                    const closeButton = modal.querySelector('.close-button');
                    if (closeButton) {
                        closeButton.click();
                    } else {
                        modal.classList.remove('visible');
                        setTimeout(() => { modal.style.display = 'none'; }, 200);
                    }
                }
                // Close search suggestions
                const sugg = document.getElementById('searchSuggestions');
                if (sugg) sugg.style.display = 'none';
                break;
            }
        }
    });
}
