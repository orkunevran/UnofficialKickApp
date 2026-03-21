/**
 * History view — recently viewed channels/VODs.
 */

import { getHistory, clearHistory, removeFromHistory } from '../history.js?v=2.3.5';
import { escapeHtml, formatRelativeTime, initialsAvatar } from '../utils.js?v=2.3.5';
import { navigate } from '../router.js?v=2.3.5';
import { toast } from '../toast.js?v=2.3.5';

function renderHistoryItem(item) {
    const avatarHTML = item.profilePicture
        ? `<img src="${escapeHtml(item.profilePicture)}" alt="" style="width:100%;height:100%;object-fit:cover">`
        : (item.thumbnailUrl
            ? `<img src="${escapeHtml(item.thumbnailUrl)}" alt="" style="width:100%;height:100%;object-fit:cover">`
            : '');

    return `
        <div class="history-item" data-slug="${escapeHtml(item.slug)}" data-type="${escapeHtml(item.type || 'stream')}">
            <div class="history-thumb">${avatarHTML}</div>
            <div class="history-info">
                <div class="history-title">${escapeHtml(item.username || item.slug)}</div>
                <div class="history-meta">
                    ${item.title ? `<span>${escapeHtml(item.title)}</span>` : ''}
                    <span>${formatRelativeTime(item.timestamp)}</span>
                </div>
            </div>
            <button class="history-remove-btn" data-slug="${escapeHtml(item.slug)}" data-type="${escapeHtml(item.type || 'stream')}" title="Remove" aria-label="Remove from history">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>`;
}

export async function mount(params, contentEl) {
    const history = getHistory();

    contentEl.innerHTML = `
        <div class="section-header" style="justify-content:space-between">
            <h1 class="section-title">Watch History <span class="section-count">${history.length > 0 ? `(${history.length})` : ''}</span></h1>
            ${history.length > 0 ? '<button id="clear-history-btn" class="btn-secondary">Clear History</button>' : ''}
        </div>
        <div id="history-list">
            ${history.length === 0
                ? `<div class="empty-state">
                    <div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
                    <div class="empty-state-title">No history yet</div>
                    <div class="empty-state-text">Channels you visit will appear here.</div>
                    <a href="#/browse" class="btn-primary" style="margin-top:16px;display:inline-flex">Browse Streams</a>
                </div>`
                : history.map(renderHistoryItem).join('')}
        </div>`;

    // Click to navigate or remove
    contentEl.querySelector('#history-list')?.addEventListener('click', (e) => {
        // Remove button
        const removeBtn = e.target.closest('.history-remove-btn');
        if (removeBtn) {
            e.stopPropagation();
            removeFromHistory(removeBtn.dataset.slug, removeBtn.dataset.type);
            toast('Removed from history', 'success');
            mount(params, contentEl);
            return;
        }
        const item = e.target.closest('.history-item');
        if (item) navigate(`/channel/${item.dataset.slug}`);
    });

    // Clear history
    contentEl.querySelector('#clear-history-btn')?.addEventListener('click', () => {
        clearHistory();
        toast('History cleared', 'success');
        mount(params, contentEl);
    });
}
