/**
 * Settings view — preferences for language, view mode, sorting, refresh, etc.
 */

import { preferences, savePreferences } from '../state.js';
import { toast } from '../toast.js';
import { clearHistory } from '../history.js';
import { clearFavorites } from '../favorites.js';

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
    const sortCol = preferences.defaultSort?.column || '';
    const sortDir = preferences.defaultSort?.direction || 'desc';
    const autoRefresh = preferences.autoRefresh !== false;
    const refreshInterval = preferences.autoRefreshInterval || 120;
    const historyEnabled = preferences.historyEnabled !== false;

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
            <div class="settings-group-title">Browse</div>
            <div class="settings-row">
                <span class="settings-label">Default Sort</span>
                <div style="display:flex;gap:8px">
                    <select id="settings-sort-column" class="filter-select">
                        <option value="" ${sortCol === '' ? 'selected' : ''}>Featured</option>
                        <option value="viewer_count" ${sortCol === 'viewer_count' ? 'selected' : ''}>Viewers</option>
                        <option value="session_title" ${sortCol === 'session_title' ? 'selected' : ''}>Title</option>
                        <option value="channel.user.username" ${sortCol === 'channel.user.username' ? 'selected' : ''}>Channel</option>
                    </select>
                    <select id="settings-sort-direction" class="filter-select" ${sortCol === '' ? 'disabled' : ''}>
                        <option value="desc" ${sortDir === 'desc' ? 'selected' : ''}>&#x25BE; Desc</option>
                        <option value="asc" ${sortDir === 'asc' ? 'selected' : ''}>&#x25B4; Asc</option>
                    </select>
                </div>
            </div>
            <label class="settings-row">
                <span class="settings-label" id="settings-auto-refresh-label">Auto-Refresh</span>
                <span class="toggle-switch">
                    <input type="checkbox" id="settings-auto-refresh" role="switch" aria-labelledby="settings-auto-refresh-label" ${autoRefresh ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </span>
            </label>
            <div class="settings-row ${autoRefresh ? '' : 'settings-row-disabled'}" id="settings-interval-row">
                <span class="settings-label">Refresh Interval</span>
                <select id="settings-refresh-interval" class="filter-select">
                    <option value="30" ${refreshInterval === 30 ? 'selected' : ''}>30 seconds</option>
                    <option value="60" ${refreshInterval === 60 ? 'selected' : ''}>1 minute</option>
                    <option value="120" ${refreshInterval === 120 ? 'selected' : ''}>2 minutes</option>
                    <option value="300" ${refreshInterval === 300 ? 'selected' : ''}>5 minutes</option>
                    <option value="600" ${refreshInterval === 600 ? 'selected' : ''}>10 minutes</option>
                </select>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">Data</div>
            <label class="settings-row">
                <span class="settings-label" id="settings-history-enabled-label">History Tracking</span>
                <span class="toggle-switch">
                    <input type="checkbox" id="settings-history-enabled" role="switch" aria-labelledby="settings-history-enabled-label" ${historyEnabled ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </span>
            </label>
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
        </div>

        <div class="settings-group">
            <div class="settings-group-title">Keyboard Shortcuts</div>
            <div style="font-size:13px;color:var(--text-muted);line-height:2">
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">/</kbd> Focus search</div>
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">Esc</kbd> Close modal / blur search</div>
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">?</kbd> Show shortcuts help</div>
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">T</kbd> Cycle theme</div>
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:4px">G</kbd><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">B</kbd> Go to Browse</div>
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:4px">G</kbd><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">F</kbd> Go to Favorites</div>
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:4px">G</kbd><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">H</kbd> Go to History</div>
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:4px">G</kbd><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">S</kbd> Go to Settings</div>
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

    // --- Event handlers ---

    const onThemeChange = (e) => {
        const theme = e.target.value;
        preferences.theme = theme;
        savePreferences();
        window.__applyTheme?.(theme);
        const labels = { system: 'System (auto)', light: 'Light', dark: 'Dark' };
        toast(`Theme: ${labels[theme] || theme}`, 'success');
    };

    const onLangChange = (e) => {
        preferences.language = e.target.value;
        savePreferences();
        toast('Default language updated', 'success');
    };

    const onViewChange = (e) => {
        preferences.viewMode = e.target.value;
        savePreferences();
        toast('Default view updated', 'success');
    };

    const directionEl = contentEl.querySelector('#settings-sort-direction');
    const intervalRow = contentEl.querySelector('#settings-interval-row');

    const onSortColumnChange = (e) => {
        const col = e.target.value;
        if (!preferences.defaultSort) preferences.defaultSort = {};
        preferences.defaultSort.column = col || null;
        directionEl.disabled = !col;
        savePreferences();
        toast('Default sort updated', 'success');
    };

    const onSortDirectionChange = (e) => {
        if (!preferences.defaultSort) preferences.defaultSort = {};
        preferences.defaultSort.direction = e.target.value;
        savePreferences();
        toast('Default sort updated', 'success');
    };

    const onAutoRefreshToggle = (e) => {
        preferences.autoRefresh = e.target.checked;
        intervalRow.classList.toggle('settings-row-disabled', !e.target.checked);
        savePreferences();
        // Broadcast so a currently-mounted Browse view can clear/restart its
        // timers immediately instead of waiting for the next mount.
        window.dispatchEvent(new CustomEvent('preferences-changed', {
            detail: { key: 'autoRefresh', value: e.target.checked },
        }));
        toast(e.target.checked ? 'Auto-refresh enabled' : 'Auto-refresh disabled', 'success');
    };

    const onRefreshIntervalChange = (e) => {
        preferences.autoRefreshInterval = parseInt(e.target.value, 10);
        savePreferences();
        window.dispatchEvent(new CustomEvent('preferences-changed', {
            detail: { key: 'autoRefreshInterval', value: preferences.autoRefreshInterval },
        }));
        toast('Refresh interval updated', 'success');
    };

    const onHistoryToggle = (e) => {
        preferences.historyEnabled = e.target.checked;
        savePreferences();
        toast(e.target.checked ? 'History tracking enabled' : 'History tracking disabled', 'success');
    };

    const onClearHistory = (e) => {
        confirmAction(e.currentTarget, () => {
            clearHistory();
            toast('Watch history cleared', 'success');
        });
    };

    const onClearFavorites = (e) => {
        confirmAction(e.currentTarget, () => {
            clearFavorites();
            toast('Favorites cleared', 'success');
            const badge = document.getElementById('favorites-badge');
            if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
        });
    };

    // --- Bind listeners ---

    const themeEl = contentEl.querySelector('#settings-theme');
    const langEl = contentEl.querySelector('#settings-language');
    const viewEl = contentEl.querySelector('#settings-viewmode');
    const sortColEl = contentEl.querySelector('#settings-sort-column');
    const autoRefreshEl = contentEl.querySelector('#settings-auto-refresh');
    const refreshIntervalEl = contentEl.querySelector('#settings-refresh-interval');
    const historyEl = contentEl.querySelector('#settings-history-enabled');
    const clearHistBtn = contentEl.querySelector('#settings-clear-history');
    const clearFavBtn = contentEl.querySelector('#settings-clear-favorites');

    themeEl?.addEventListener('change', onThemeChange);
    langEl?.addEventListener('change', onLangChange);
    viewEl?.addEventListener('change', onViewChange);
    sortColEl?.addEventListener('change', onSortColumnChange);
    directionEl?.addEventListener('change', onSortDirectionChange);
    autoRefreshEl?.addEventListener('change', onAutoRefreshToggle);
    refreshIntervalEl?.addEventListener('change', onRefreshIntervalChange);
    historyEl?.addEventListener('change', onHistoryToggle);
    clearHistBtn?.addEventListener('click', onClearHistory);
    clearFavBtn?.addEventListener('click', onClearFavorites);

    return () => {
        themeEl?.removeEventListener('change', onThemeChange);
        langEl?.removeEventListener('change', onLangChange);
        viewEl?.removeEventListener('change', onViewChange);
        sortColEl?.removeEventListener('change', onSortColumnChange);
        directionEl?.removeEventListener('change', onSortDirectionChange);
        autoRefreshEl?.removeEventListener('change', onAutoRefreshToggle);
        refreshIntervalEl?.removeEventListener('change', onRefreshIntervalChange);
        historyEl?.removeEventListener('change', onHistoryToggle);
        clearHistBtn?.removeEventListener('click', onClearHistory);
        clearFavBtn?.removeEventListener('click', onClearFavorites);
        confirmTimers.forEach(t => clearTimeout(t));
    };
}
