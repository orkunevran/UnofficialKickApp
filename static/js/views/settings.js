/**
 * Settings view — preferences for language, view mode, etc.
 */

import { preferences, savePreferences } from '../state.js?v=2.4.8';
import { toast } from '../toast.js?v=2.4.8';
import { clearHistory } from '../history.js?v=2.4.8';
import { clearFavorites } from '../favorites.js?v=2.4.8';

export async function mount(params, contentEl) {
    // Fetch languages for the selector
    let languages = [{ code: 'en', name: 'English' }];
    let defaultLang = 'en';
    try {
        const res = await fetch('/config/languages');
        if (res.ok) {
            const config = await res.json();
            languages = config.languages || languages;
            defaultLang = config.default_language || 'en';
        }
    } catch { /* use fallback */ }

    const currentLang = preferences.language || defaultLang;
    const currentTheme = preferences.theme || 'system';

    contentEl.innerHTML = `
        <div class="section-header">
            <h1 class="section-title">Settings</h1>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">Appearance</div>
            <div class="settings-row">
                <span class="settings-label">Theme</span>
                <select id="settings-theme" class="filter-select">
                    <option value="system" ${currentTheme === 'system' ? 'selected' : ''}>System</option>
                    <option value="light" ${currentTheme === 'light' ? 'selected' : ''}>Light</option>
                    <option value="dark" ${currentTheme === 'dark' ? 'selected' : ''}>Dark</option>
                </select>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">Preferences</div>
            <div class="settings-row">
                <span class="settings-label">Default Language</span>
                <select id="settings-language" class="filter-select">
                    ${languages.map(l => `<option value="${l.code}" ${l.code === currentLang ? 'selected' : ''}>${l.name}</option>`).join('')}
                </select>
            </div>
            <div class="settings-row">
                <span class="settings-label">Default View</span>
                <select id="settings-viewmode" class="filter-select">
                    <option value="grid" ${preferences.viewMode === 'grid' ? 'selected' : ''}>Grid</option>
                    <option value="list" ${preferences.viewMode === 'list' ? 'selected' : ''}>List</option>
                </select>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">Data</div>
            <div class="settings-row">
                <span class="settings-label">Clear watch history</span>
                <button id="settings-clear-history" class="btn-secondary">Clear</button>
            </div>
            <div class="settings-row">
                <span class="settings-label">Clear favorites</span>
                <button id="settings-clear-favorites" class="btn-secondary">Clear</button>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">About</div>
            <div class="settings-row">
                <span class="settings-label">Version</span>
                <span style="color:var(--text-muted);font-size:13px">3.1.0</span>
            </div>
            <div class="settings-row">
                <span class="settings-label">API Documentation</span>
                <a href="/docs" target="_blank" class="btn-secondary">Open Swagger</a>
            </div>
            <div class="settings-row">
                <span class="settings-label">Generative Art</span>
                <a href="/static/art/signal-propagation.html" target="_blank" class="btn-secondary">Signal Propagation</a>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">Keyboard Shortcuts</div>
            <div style="font-size:13px;color:var(--text-muted);line-height:2">
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">/</kbd> Focus search</div>
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">Esc</kbd> Close modal / clear search</div>
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">?</kbd> Show shortcuts help</div>
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">T</kbd> Cycle theme</div>
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:4px">G</kbd><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">B</kbd> Go to Browse</div>
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:4px">G</kbd><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">F</kbd> Go to Favorites</div>
            </div>
        </div>`;

    // Double-click-to-confirm helper
    const confirmTimers = [];
    function confirmAction(btn, action) {
        if (btn.dataset.confirming === 'true') {
            action();
            btn.dataset.confirming = '';
            btn.textContent = 'Clear';
            btn.classList.remove('btn-danger');
            return;
        }
        btn.dataset.confirming = 'true';
        btn.textContent = 'Are you sure?';
        btn.classList.add('btn-danger');
        const timer = setTimeout(() => {
            if (btn.dataset.confirming === 'true') {
                btn.dataset.confirming = '';
                btn.textContent = 'Clear';
                btn.classList.remove('btn-danger');
            }
        }, 3000);
        confirmTimers.push(timer);
    }

    // Theme change
    const onThemeChange = (e) => {
        const theme = e.target.value;
        preferences.theme = theme;
        savePreferences();
        window.__applyTheme?.(theme);
        const labels = { system: 'System (auto)', light: 'Light', dark: 'Dark' };
        toast(`Theme: ${labels[theme] || theme}`, 'success');
    };

    // Language change
    const onLangChange = (e) => {
        preferences.language = e.target.value;
        savePreferences();
        toast('Default language updated', 'success');
    };

    // View mode
    const onViewChange = (e) => {
        preferences.viewMode = e.target.value;
        savePreferences();
        toast('Default view updated', 'success');
    };

    // Clear history
    const onClearHistory = (e) => {
        confirmAction(e.currentTarget, () => {
            clearHistory();
            toast('Watch history cleared', 'success');
        });
    };

    // Clear favorites
    const onClearFavorites = (e) => {
        confirmAction(e.currentTarget, () => {
            clearFavorites();
            toast('Favorites cleared', 'success');
            const badge = document.getElementById('favorites-badge');
            if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
        });
    };

    const themeEl = contentEl.querySelector('#settings-theme');
    const langEl = contentEl.querySelector('#settings-language');
    const viewEl = contentEl.querySelector('#settings-viewmode');
    const clearHistBtn = contentEl.querySelector('#settings-clear-history');
    const clearFavBtn = contentEl.querySelector('#settings-clear-favorites');

    themeEl?.addEventListener('change', onThemeChange);
    langEl?.addEventListener('change', onLangChange);
    viewEl?.addEventListener('change', onViewChange);
    clearHistBtn?.addEventListener('click', onClearHistory);
    clearFavBtn?.addEventListener('click', onClearFavorites);

    return () => {
        themeEl?.removeEventListener('change', onThemeChange);
        langEl?.removeEventListener('change', onLangChange);
        viewEl?.removeEventListener('change', onViewChange);
        clearHistBtn?.removeEventListener('click', onClearHistory);
        clearFavBtn?.removeEventListener('click', onClearFavorites);
        confirmTimers.forEach(t => clearTimeout(t));
    };
}
