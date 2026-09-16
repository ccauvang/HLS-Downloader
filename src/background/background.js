chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => { });

const tabUrls = {};
const activePopupTabs = new Set();
const keyCache = new Map();
const pendingConfirm = new Map();
const blacklistedHosts = new Set();
const tabHostnames = {};

chrome.storage.sync.get({ blacklist: [] }, (s) => s.blacklist.forEach(h => blacklistedHosts.add(h)));

function hostFromUrl(url) {
    try { return new URL(url).hostname; } catch (e) { return null; }
}

function isHostBlacklisted(host) {
    return host ? blacklistedHosts.has(host) : false;
}

function isTabBlacklisted(tabId) {
    return isHostBlacklisted(tabHostnames[tabId]);
}

function addUrl(tab, url, frameId = 0) {
    if (tab < 0) return;
    if (!tabUrls[tab]) tabUrls[tab] = [];
    if (!tabUrls[tab].find(e => e.url === url)) {
        tabUrls[tab].push({ url, frameId });
        chrome.action.setBadgeText({ text: String(tabUrls[tab].length), tabId: tab });
        chrome.action.setBadgeBackgroundColor({ color: '#e93434', tabId: tab });
        if (activePopupTabs.size > 0) {
            chrome.runtime.sendMessage({ type: 'HLS_DETECTED', url, frameId, tabId: tab }).catch(() => { });
        }
    }
}

const HLS_PATH_HINT = /(?:^|\/)(?:hls|m3u8|manifest|playlist|master)(?:[-_][^/?#]+)?(?:\/|$)/i;
const HLS_DOTTED_HINT = /(?:^|[.-])(?:hls|m3u8)(?:[.-]|$)/i;
const KEY_HINT = /(?:^|[/?&.-])(?:key|license|drm|token)(?:[/?&.-]|$)/i;

function classifyStream(url, ct, size) {
    const u = url.split('?')[0];
    if (ct.includes('javascript') || ct.includes('css') ||
        ct.includes('image/') || ct.includes('font/') ||
        ct.includes('application/json')) return null;
    if (KEY_HINT.test(u)) return null;
    if (looksLikeSegment(u)) return null;   // ← moved up, before path-hint check
    if (u.includes('.m3u8')) return 'hls';
    if (ct.includes('mpegurl') || ct.includes('apple.mpegurl')) return 'hls';
    if (HLS_PATH_HINT.test(u) || HLS_DOTTED_HINT.test(u)) return 'hls-maybe';
    if ((ct.includes('text/plain') || ct.includes('octet-stream')) &&
        (size === 0 || size < 500000)) return 'hls-maybe';
    return null;
}

function looksLikeSegment(url) {
    const u = url.split('?')[0]; // strip query
    return u.endsWith('.ts') ||
        u.endsWith('.aac') ||
        u.endsWith('.mp4') ||
        u.endsWith('.m4s') ||
        u.endsWith('.fmp4') ||
        /seg\d+/i.test(u) ||
        /chunk[-_]\d+/i.test(u) ||
        /\d{4,}\.(ts|aac|mp4)/i.test(u); // numbered segments
}

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        const host = details.initiator ? hostFromUrl(details.initiator) : tabHostnames[details.tabId];
        if (isHostBlacklisted(host)) return;
        if (activePopupTabs.size > 0 && !activePopupTabs.has(details.tabId)) return;
        if (details.url.includes('.m3u8') || details.url.includes('.mpd')) {
            addUrl(details.tabId, details.url, details.frameId);
        }
    },
    { urls: ['*://*/*'] }
);

chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
        const tab = details.tabId;
        if (tab < 0) return;
        const host = details.initiator ? hostFromUrl(details.initiator) : tabHostnames[tab];
        if (isHostBlacklisted(host)) return;
        if (activePopupTabs.size > 0 && !activePopupTabs.has(tab)) return;

        const ct = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
        const size = parseInt(details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-length')?.value || '0');

        const result = classifyStream(details.url, ct, size);

        if (result === 'hls') {
            addUrl(tab, details.url, details.frameId)
        } else if (result === 'hls-maybe') {
            if (!pendingConfirm.has(tab)) pendingConfirm.set(tab, new Set());
            const seen = pendingConfirm.get(tab);
            if (seen.has(details.url)) return;
            seen.add(details.url);
            chrome.tabs.sendMessage(tab, { type: 'CONFIRM_HLS_CANDIDATE', url: details.url }, { frameId: details.frameId }).catch(() => { });
        }
    },
    { urls: ['*://*/*'] },
    ['responseHeaders']
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'HLS_DETECTED') {
        if (sender?.tab?.id) {
            const host = sender.tab.url ? hostFromUrl(sender.tab.url) : tabHostnames[sender.tab.id];
            if (isHostBlacklisted(host)) return;
            addUrl(sender.tab.id, msg.url, sender.frameId);
        }
        return;
    }
    if (msg.type === 'GET_URLS') {
        sendResponse(tabUrls[msg.tabId] || []);
        return true;
    }
    if (msg.type === 'SET_ACTIVE_TAB') {
        activePopupTabs.add(msg.tabId);
        if (!tabHostnames[msg.tabId]) {
            chrome.tabs.get(msg.tabId, (tab) => {
                if (tab?.url) { try { tabHostnames[msg.tabId] = new URL(tab.url).hostname; } catch (e) { } }
            });
        }
        return;
    }
    if (msg.type === 'UNSET_ACTIVE_TAB') {
        activePopupTabs.delete(msg.tabId);
        return;
    }
    if (msg.type === 'HLS_KEY_CACHE_SET') {
        keyCache.set(msg.url, msg.bytes);
        return;
    }
    if (msg.type === 'GET_CACHED_KEY') {
        sendResponse(keyCache.get(msg.url) || null);
        return true;
    }
    if (msg.type === 'GET_BLACKLIST_STATUS') {
        sendResponse({ blacklisted: isTabBlacklisted(msg.tabId) });
        return true;
    }
    if (msg.type === 'TOGGLE_BLACKLIST') {
        chrome.storage.sync.get({ blacklist: [] }, (s) => {
            const list = s.blacklist;
            const idx = list.indexOf(msg.host);
            if (idx === -1) list.push(msg.host); else list.splice(idx, 1);
            chrome.storage.sync.set({ blacklist: list }, () => {
                blacklistedHosts.clear();
                list.forEach(h => blacklistedHosts.add(h));
                sendResponse({ blacklisted: idx === -1 });
            });
        });
        return true;
    }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', changes });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        delete tabUrls[tabId];
        pendingConfirm.delete(tabId);
        chrome.action.setBadgeText({ text: '', tabId });
        keyCache.clear();
    }
    if (changeInfo.url) {
        try { tabHostnames[tabId] = new URL(changeInfo.url).hostname; } catch (e) { }
    }
});

chrome.action.onClicked.addListener((tab) => {
    chrome.windows.create({
        url: chrome.runtime.getURL('src/popup/popup.html') + `?tabId=${tab.id}`,
        type: 'popup',
        width: 600,
        height: 900
    });
});

chrome.tabs.onRemoved.addListener(tabId => delete tabUrls[tabId]);