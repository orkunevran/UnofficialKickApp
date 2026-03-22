/**
 * History view — recently viewed channels/VODs.
 * Renders instantly from localStorage with in-place DOM removal.
 */

import { getHistory, clearHistory, removeFromHistory } from '../history.js?v=2.4.8';
import { escapeHtml, formatRelativeTime, initialsAvatar } from '../utils.js?v=2.4.8';
import { navigate } from '../router.js?v=2.4.8';
import { toast } from '../toast.js?v=2.4.8';

function renderHistoryItem(item) {
    const hasProfile = !!item.profilePicture;
    const imgSrc = item.profilePicture || item.thumbnailUrl || '';
    const avatarHTML = imgSrc
        ? `<img src="${escapeHtml(imgSrc)}" alt="" style="width:100%;height:100%;object-fit:cover">`
        : '';
    const thumbClass = hasProfile ? 'history-thumb history-thumb--avatar' : 'history-thumb';

    return `
        <div class="history-item" data-slug="${escapeHtml(item.slug)}" data-type="${escapeHtml(item.type || 'stream')}">
            <div class="${thumbClass}">${avatarHTML}</div>
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

function renderEmptyState() {
    return `<div class="empty-state">
        <div class="empty-state-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>
        <div class="empty-state-title">No history yet</div>
        <div class="empty-state-text">Channels you visit will appear here.</div>
        <a href="#/browse" class="btn-primary" style="margin-top:16px;display:inline-flex">Browse Streams</a>
    </div>`;
}

export async function mount(params, contentEl) {
    const history = getHistory();

    contentEl.innerHTML = `
        <div class="section-header" style="justify-content:space-between">
            <h1 class="section-title">Watch History <span id="history-count" class="section-count">${history.length > 0 ? `(${history.length})` : ''}</span></h1>
            ${history.length > 0 ? '<button id="clear-history-btn" class="btn-secondary">Clear History</button>' : ''}
        </div>
        <div id="history-list">
            ${history.length === 0 ? renderEmptyState() : history.map(renderHistoryItem).join('')}
        </div>`;

    const listEl = contentEl.querySelector('#history-list');
    const countEl = contentEl.querySelector('#history-count');

    function updateCount() {
        const n = listEl.querySelectorAll('.history-item').length;
        if (countEl) countEl.textContent = n > 0 ? `(${n})` : '';
    }

    function showEmptyIfNeeded() {
        if (listEl.querySelectorAll('.history-item').length === 0) {
            listEl.innerHTML = renderEmptyState();
            const clearBtn = contentEl.querySelector('#clear-history-btn');
            if (clearBtn) clearBtn.remove();
        }
    }

    const handleClick = (e) => {
        // Remove single item — in-place DOM removal, no full re-render
        const removeBtn = e.target.closest('.history-remove-btn');
        if (removeBtn) {
            e.stopPropagation();
            const slug = removeBtn.dataset.slug;
            const type = removeBtn.dataset.type;
            removeFromHistory(slug, type);
            const item = removeBtn.closest('.history-item');
            if (item) item.remove();
            updateCount();
            showEmptyIfNeeded();
            toast('Removed from history', 'success');
            return;
        }

        // Clear all — only replace the list content
        if (e.target.closest('#clear-history-btn')) {
            clearHistory();
            listEl.innerHTML = renderEmptyState();
            if (countEl) countEl.textContent = '';
            const clearBtn = contentEl.querySelector('#clear-history-btn');
            if (clearBtn) clearBtn.remove();
            toast('History cleared', 'success');
            return;
        }

        // Navigate to channel
        const item = e.target.closest('.history-item');
        if (item) navigate(`/channel/${item.dataset.slug}`);
    };

    contentEl.addEventListener('click', handleClick);

    return () => {
        contentEl.removeEventListener('click', handleClick);
    };
}
