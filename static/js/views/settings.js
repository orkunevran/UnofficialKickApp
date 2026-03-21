/**
 * Settings view — preferences for language, view mode, etc.
 */

import { preferences, savePreferences } from '../state.js?v=2.3.5';
import { toast } from '../toast.js?v=2.3.5';
import { clearHistory } from '../history.js?v=2.3.5';
import { clearFavorites } from '../favorites.js?v=2.3.5';

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

    contentEl.innerHTML = `
        <div class="section-header">
            <h1 class="section-title">Settings</h1>
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
                <span style="color:var(--text-muted);font-size:13px">2.0.0</span>
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
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">Esc</kbd> Close modal / clear search</div>
                <div><kbd class="search-kbd" style="display:inline-flex;position:static;margin-right:8px">?</kbd> Show shortcuts</div>
            </div>
        </div>`;

    // Language change
    contentEl.querySelector('#settings-language')?.addEventListener('change', (e) => {
        preferences.language = e.target.value;
        savePreferences();
        toast('Default language updated', 'success');
    });

    // View mode
    contentEl.querySelector('#settings-viewmode')?.addEventListener('change', (e) => {
        preferences.viewMode = e.target.value;
        savePreferences();
        toast('Default view updated', 'success');
    });

    // Double-click-to-confirm helper
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
        setTimeout(() => {
            if (btn.dataset.confirming === 'true') {
                btn.dataset.confirming = '';
                btn.textContent = 'Clear';
                btn.classList.remove('btn-danger');
            }
        }, 3000);
    }

    // Clear history
    contentEl.querySelector('#settings-clear-history')?.addEventListener('click', (e) => {
        confirmAction(e.currentTarget, () => {
            clearHistory();
            toast('Watch history cleared', 'success');
        });
    });

    // Clear favorites
    contentEl.querySelector('#settings-clear-favorites')?.addEventListener('click', (e) => {
        confirmAction(e.currentTarget, () => {
            clearFavorites();
            toast('Favorites cleared', 'success');
            const badge = document.getElementById('favorites-badge');
            if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
        });
    });
}
