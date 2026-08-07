/**
 * Read-only KICK live chat.
 *
 * KICK blocks its popout page from cross-origin iframes, so the app subscribes
 * to the same public Pusher channel and renders messages natively. Posting
 * remains on kick.com because it requires the viewer's authenticated session.
 */

const PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';
const MAX_MESSAGES = 160;
const RECONNECT_DELAYS = [1000, 2500, 5000, 10000];
const EMOTE_RE = /\[emote:(\d+):([^\]]+)\]/g;

// One chat-history response covers about this much time, so replay advances in
// these steps (matching what Kick's own VOD player polls at).
const CHAT_WINDOW_MS = 5000;

function parseJSON(value) {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function normaliseMessage(packet) {
    const payload = parseJSON(packet?.data);
    if (!payload || typeof payload !== 'object') return null;

    const sender = payload.sender || payload.user || {};
    const legacyMessage = payload.message && typeof payload.message === 'object'
        ? payload.message
        : null;
    const content = payload.content ?? legacyMessage?.message;
    if (typeof content !== 'string' || !content.trim()) return null;

    return {
        id: String(payload.id || legacyMessage?.id || ''),
        content,
        createdAt: payload.created_at || legacyMessage?.created_at || '',
        username: String(sender.username || sender.slug || 'KICK'),
        color: String(sender.identity?.color || ''),
        badges: Array.isArray(sender.identity?.badges) ? sender.identity.badges : [],
    };
}

function appendContent(container, content) {
    EMOTE_RE.lastIndex = 0;
    let cursor = 0;
    let match;

    while ((match = EMOTE_RE.exec(content)) !== null) {
        if (match.index > cursor) {
            container.append(document.createTextNode(content.slice(cursor, match.index)));
        }

        const img = document.createElement('img');
        img.className = 'channel-chat-emote';
        img.src = `https://files.kick.com/emotes/${match[1]}/fullsize`;
        img.alt = `:${match[2]}:`;
        img.title = match[2];
        img.loading = 'lazy';
        img.draggable = false;
        img.addEventListener('error', () => {
            img.replaceWith(document.createTextNode(img.alt));
        }, { once: true });
        container.append(img);
        cursor = match.index + match[0].length;
    }

    if (cursor < content.length) {
        container.append(document.createTextNode(content.slice(cursor)));
    }
}

function renderMessage(message) {
    const row = document.createElement('div');
    row.className = 'channel-chat-message';
    if (message.id) row.dataset.messageId = message.id;
    if (message.createdAt) {
        const date = new Date(message.createdAt);
        if (!Number.isNaN(date.getTime())) {
            row.title = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
    }

    const badges = document.createElement('span');
    badges.className = 'channel-chat-badges';
    message.badges.slice(0, 2).forEach(badge => {
        const label = String(badge?.text || badge?.type || '').trim();
        if (!label) return;
        const el = document.createElement('span');
        el.className = `channel-chat-badge badge-${String(badge?.type || '').toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
        el.textContent = label === 'Subscriber' && badge?.count
            ? `${badge.count}m`
            : label.slice(0, 3).toUpperCase();
        el.title = label;
        badges.append(el);
    });
    if (badges.childElementCount) row.append(badges);

    const username = document.createElement('strong');
    username.className = 'channel-chat-username';
    username.textContent = message.username;
    if (/^#[0-9a-f]{6}$/i.test(message.color)) username.style.color = message.color;
    row.append(username, document.createTextNode(': '));

    const body = document.createElement('span');
    body.className = 'channel-chat-message-body';
    appendContent(body, message.content);
    row.append(body);
    return row;
}

export function mountLiveChat({ chatroomId, channelSlug }) {
    const dock = document.getElementById('channel-chat-dock');
    const messages = document.getElementById('channel-chat-messages');
    const status = document.getElementById('channel-chat-status');
    const empty = document.getElementById('channel-chat-empty');
    const newMessages = document.getElementById('channel-chat-new');
    const id = Number(chatroomId);

    const inert = { setReplayPosition() {}, dispose() {} };
    if (!dock || !messages || !status || !Number.isFinite(id) || id <= 0) {
        return inert;
    }

    let socket = null;
    let disposed = false;
    let reconnectTimer = null;
    let reconnectAttempt = 0;

    const setStatus = (text, state) => {
        status.textContent = text;
        status.dataset.state = state;
    };
    const scrollToLatest = () => {
        messages.scrollTop = messages.scrollHeight;
        newMessages?.classList.add('hidden');
    };
    newMessages?.addEventListener('click', scrollToLatest);

    const scheduleReconnect = () => {
        // Nothing to reconnect to while replaying a past moment: the socket only
        // carries what is being said now.
        if (disposed || reconnectTimer || replayActive) return;
        setStatus('Reconnecting', 'connecting');
        if (empty && messages.childElementCount === 0) {
            empty.textContent = 'Chat connection paused. Reconnecting…';
        }
        const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
    };

    const appendMessage = message => {
        // Replay windows are snapped to a grid upstream, and a message can sit in the
        // overlap between two of them; the live socket can also redeliver on
        // reconnect. Either way the same message must not appear twice.
        if (message.id && messages.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
        const shouldStick = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 56;
        empty?.remove();
        messages.append(renderMessage(message));
        while (messages.childElementCount > MAX_MESSAGES) {
            messages.firstElementChild?.remove();
        }
        if (shouldStick) {
            scrollToLatest();
        } else {
            newMessages?.classList.remove('hidden');
        }
    };

    const deleteMessage = messageId => {
        if (!messageId) return;
        [...messages.children].find(el => el.dataset.messageId === String(messageId))?.remove();
    };

    function connect() {
        if (disposed) return;
        setStatus('Connecting', 'connecting');
        socket = new WebSocket(PUSHER_URL);

        socket.addEventListener('message', event => {
            const packet = parseJSON(event.data);
            if (!packet) return;

            if (packet.event === 'pusher:connection_established') {
                socket?.send(JSON.stringify({
                    event: 'pusher:subscribe',
                    data: { auth: '', channel: `chatrooms.${id}.v2` },
                }));
                return;
            }
            if (packet.event === 'pusher_internal:subscription_succeeded') {
                reconnectAttempt = 0;
                setStatus('Live', 'live');
                if (empty) empty.textContent = 'Waiting for the next message…';
                return;
            }
            if (packet.event === 'pusher:ping') {
                socket?.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
                return;
            }
            if (String(packet.event).includes('ChatMessage')) {
                const message = normaliseMessage(packet);
                if (message) appendMessage(message);
                return;
            }
            if (String(packet.event).includes('MessageDeleted')) {
                const payload = parseJSON(packet.data);
                deleteMessage(payload?.id || payload?.message?.id);
            }
        });

        socket.addEventListener('close', scheduleReconnect);
        socket.addEventListener('error', () => {
            if (socket?.readyState === WebSocket.OPEN) socket.close();
        });
    }

    // ── Replay ────────────────────────────────────────────────────────────
    //
    // Kick's chat history is addressable by wall-clock time, so a rewound player
    // can show the chat that was on screen at that moment instead of messages from
    // now, which belong to a part of the stream the viewer hasn't reached. The
    // window it serves is ~5s wide, so replay walks forward in those steps as
    // playback advances.
    //
    // Retention is shallow: measured on a busy channel, a window is rich near the
    // live edge (≈24 messages), thinner minutes back (≈17), and essentially empty
    // beyond half an hour. That is upstream's limit, so the empty state says so
    // rather than looking broken.
    // The loop follows a *target* — where the viewer is — instead of walking a wall
    // clock of its own. That difference is what makes pausing safe: a stationary
    // target keeps resolving to the same window, so nothing is refetched. Driving it
    // off elapsed real time instead meant a paused viewer's chat marched away from
    // the frame on screen, and the correction wiped the panel every few seconds.
    //
    // Every run is stamped with a generation. A jump bumps it, so the results of a
    // request already in flight are discarded rather than landing in a panel that has
    // since been cleared — and its follow-up timer is never scheduled, so two loops
    // can't end up interleaved.
    let replayTimer = null;
    let replayGeneration = 0;
    let replayActive = false;
    let replayTargetMs = 0;   // the instant the viewer is watching
    let replayWindowMs = 0;   // the window already on screen

    // A move larger than this is a seek; anything smaller is playback drifting
    // forward between position reports.
    const REPLAY_JUMP_MS = CHAT_WINDOW_MS * 3;

    const stopReplay = () => {
        replayGeneration += 1;
        replayActive = false;
        if (replayTimer) { clearTimeout(replayTimer); replayTimer = null; }
        replayTargetMs = 0;
        replayWindowMs = 0;
    };

    const pullReplayWindow = async (atMs) => {
        const at = new Date(atMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
        try {
            const res = await fetch(`/streams/chat/${encodeURIComponent(channelSlug)}/history?at=${encodeURIComponent(at)}`);
            if (!res.ok) return [];
            const body = await res.json();
            return Array.isArray(body?.data?.messages) ? body.data.messages : [];
        } catch {
            return [];
        }
    };

    const renderReplayWindow = async (atMs, generation) => {
        const raw = await pullReplayWindow(atMs);
        if (disposed || generation !== replayGeneration) return;
        raw.forEach(message => appendMessage({
            id: String(message.id || ''),
            content: String(message.content || ''),
            createdAt: message.created_at || '',
            username: String(message.username || 'KICK'),
            color: String(message.color || ''),
            badges: Array.isArray(message.badges) ? message.badges : [],
        }));
        // Upstream retention thins out fast — beyond about half an hour back a window
        // is simply empty — so say so rather than leaving "Connecting to chat…" up.
        // Checked against real messages, not child count: the note itself is a child,
        // and appendMessage detaches it on the first message it renders.
        if (empty && !messages.querySelector('.channel-chat-message')) {
            empty.textContent = 'No chat was recorded for this moment.';
            if (!empty.isConnected) messages.append(empty);
        }
    };

    const runReplay = async (generation) => {
        if (disposed || generation !== replayGeneration) return;
        const window0 = Math.floor(replayTargetMs / CHAT_WINDOW_MS) * CHAT_WINDOW_MS;
        if (window0 !== replayWindowMs) {
            replayWindowMs = window0;
            await renderReplayWindow(window0, generation);
            if (disposed || generation !== replayGeneration) return;
        }
        // Ticked faster than the window is wide so playback crossing a boundary is
        // picked up promptly; the check above makes the extra ticks free.
        replayTimer = setTimeout(() => runReplay(generation), 1000);
    };

    /**
     * Point chat at a moment in the broadcast, or back at the live socket.
     *
     * @param {Date|null} at when the viewer is watching; null means live
     */
    const setReplayPosition = (at) => {
        if (!at) {
            if (!replayActive && socket) return; // already live
            stopReplay();
            messages.replaceChildren();
            if (!socket) connect();
            return;
        }
        const target = at.getTime();
        // Ordinary playback drift: keep the same panel and let the loop pull the next
        // window when the position crosses into it.
        if (replayActive && Math.abs(target - replayTargetMs) <= REPLAY_JUMP_MS) {
            replayTargetMs = target;
            return;
        }
        // A real jump: what is on screen belongs to a moment the viewer has left, and
        // the socket only carries messages from now. Drop both, including any
        // reconnect already queued — left running it would reopen the socket
        // mid-replay and mix live messages into the past.
        if (socket) {
            socket.removeEventListener('close', scheduleReconnect);
            socket.close();
            socket = null;
        }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        stopReplay();
        messages.replaceChildren();
        setStatus('Replay', 'replay');
        replayActive = true;
        replayTargetMs = target;
        void runReplay(replayGeneration);
    };

    dock.dataset.channel = channelSlug || '';
    connect();

    return {
        setReplayPosition,
        dispose: () => {
            disposed = true;
            stopReplay();
            if (reconnectTimer) clearTimeout(reconnectTimer);
            newMessages?.removeEventListener('click', scrollToLatest);
            if (socket) {
                socket.removeEventListener('close', scheduleReconnect);
                socket.close();
                socket = null;
            }
        },
    };
}
