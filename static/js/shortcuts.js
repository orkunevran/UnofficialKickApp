/**
 * Global keyboard shortcuts.
 */

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

        switch (e.key) {
            case '/': {
                e.preventDefault();
                const searchInput = document.getElementById('channelSlugInput');
                if (searchInput) searchInput.focus();
                break;
            }
            case 'Escape': {
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
