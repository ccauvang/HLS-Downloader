// keepAlive: MV3 service workers get killed after ~30s idle — this fake alarm
// fires periodically just to keep the SW alive during long downloads
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => { });

const tabUrls = {};              // tabId -> detected m3u8/mpd URLs for that tab
const activePopupTabs = new Set(); // tabs with an open popup — used to scope detection noise
const keyCache = new Map();      // url -> decryption key bytes, captured via hook.js XHR intercept
const pendingConfirm = new Map(); // tabId -> Set of "maybe HLS" urls already sent for content-sniff confirm (dedup)
const blacklistedHosts = new Set(); // hostnames user paused detection on, mirrored from chrome.storage.sync
const tabHostnames = {};         // tabId -> hostname, kept in sync via onUpdated so blacklist checks don't need async lookups

// seed blacklist from storage on SW startup — SW can be killed/restarted anytime, so this can't live in memory only
chrome.storage.sync.get({ blacklist: [] }, (s) => s.blacklist.forEach(h => blacklistedHosts.add(h)));

function hostFromUrl(url) {
    try { return new URL(url).hostname; } catch (e) { return null; } // malformed/non-http urls (data:, blob:, etc)
}

function isHostBlacklisted(host) {
    return host ? blacklistedHosts.has(host) : false;
}

function isTabBlacklisted(tabId) {
    return isHostBlacklisted(tabHostnames[tabId]);
}

function addUrl(tab, url, frameId = 0) {
    if (tab < 0) return; // tabId -1 = request not tied to a real tab (extension/background requests)
    if (!tabUrls[tab]) tabUrls[tab] = [];
    if (!tabUrls[tab].find(e => e.url === url)) {
        tabUrls[tab].push({ url, frameId });
        chrome.action.setBadgeText({ text: String(tabUrls[tab].length), tabId: tab });
        chrome.action.setBadgeBackgroundColor({ color: '#e93434', tabId: tab });
        // only push live updates if a popup is actually open — no listener otherwise, so skip the noop send
        if (activePopupTabs.size > 0) {
            chrome.runtime.sendMessage({ type: 'HLS_DETECTED', url, frameId, tabId: tab }).catch(() => { });
        }
    }
}

// heuristics for the "maybe HLS" tier — sites without .m3u8 in the URL or a clean content-type
const HLS_PATH_HINT = /(?:^|\/)(?:hls|m3u8|manifest|playlist|master)(?:[-_][^/?#]+)?(?:\/|$)/i;
const HLS_DOTTED_HINT = /(?:^|[.-])(?:hls|m3u8)(?:[.-]|$)/i;
const KEY_HINT = /(?:^|[/?&.-])(?:key|license|drm|token)(?:[/?&.-]|$)/i; // exclude AES key/DRM endpoints from candidates

function classifyStream(url, ct, size) {
    const u = url.split('?')[0]; // drop query string before matching — hint regexes shouldn't match on random params
    if (ct.includes('javascript') || ct.includes('css') ||
        ct.includes('image/') || ct.includes('font/') ||
        ct.includes('application/json')) return null;
    if (KEY_HINT.test(u)) return null;
    if (looksLikeSegment(u)) return null;   // ← moved up, before path-hint check
    if (u.includes('.m3u8')) return 'hls';
    if (ct.includes('mpegurl') || ct.includes('apple.mpegurl')) return 'hls';
    if (HLS_PATH_HINT.test(u) || HLS_DOTTED_HINT.test(u)) return 'hls-maybe';
    // small/empty text or octet-stream bodies are a common signature for playlist responses without a clean content-type
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

// tier 1 detection: catch obvious .m3u8/.mpd URLs before the request even fires
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        // initiator is the page that fired the request — more reliable than tabHostnames for
        // requests from iframes/workers where tabId's own hostname might not match the initiator
        const host = details.initiator ? hostFromUrl(details.initiator) : tabHostnames[details.tabId];
        if (isHostBlacklisted(host)) return;
        if (activePopupTabs.size > 0 && !activePopupTabs.has(details.tabId)) return; // scope noise to tabs actually being watched
        if (details.url.includes('.m3u8') || details.url.includes('.mpd')) {
            addUrl(details.tabId, details.url, details.frameId);
        }
    },
    { urls: ['*://*/*'] }
);

// tier 2 detection: inspect response headers for content-type/size signals once headers land
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
            // uncertain candidates get body-sniffed by the content script (#EXTM3U check) instead of
            // trusted outright — pendingConfirm dedups so the same url isn't re-sent every request
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
        // fired by content.js's own body-sniffing (#EXTM3U check on fetch/XHR responses)
        if (sender?.tab?.id) {
            const host = sender.tab.url ? hostFromUrl(sender.tab.url) : tabHostnames[sender.tab.id];
            if (isHostBlacklisted(host)) return;
            addUrl(sender.tab.id, msg.url, sender.frameId);
        }
        return;
    }
    if (msg.type === 'GET_URLS') {
        sendResponse(tabUrls[msg.tabId] || []);
        return true; // keep sendResponse channel open — required for sync-looking sendResponse in MV3
    }
    if (msg.type === 'SET_ACTIVE_TAB') {
        activePopupTabs.add(msg.tabId);
        // backfill hostname if popup opened before onUpdated ever fired for this tab (e.g. tab was already loaded)
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
        // pushed from hook.js (MAIN world XHR/fetch intercept) whenever an hls-key request is seen
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
        // sync.get/set round-trip here (not the in-memory Set directly) — storage.sync is the
        // source of truth across SW restarts, in-memory blacklistedHosts is just a fast-path cache
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

// broadcast any sync-storage change (settings save, blacklist toggle) so open popups can live-update
// without needing to re-poll storage themselves
// blacklist can now change via modal/import too, not just TOGGLE_BLACKLIST msg
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.blacklist) {
        blacklistedHosts.clear();
        (changes.blacklist.newValue || []).forEach(h => blacklistedHosts.add(h));
    }
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', changes });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        // fresh navigation — wipe anything tied to the old page load so stale m3u8s/keys don't leak across navigations
        delete tabUrls[tabId];
        pendingConfirm.delete(tabId);
        chrome.action.setBadgeText({ text: '', tabId });
        keyCache.clear(); // global clear, not per-tab — acceptable tradeoff, keys are short-lived/single-use anyway
    }
    if (changeInfo.url) {
        try { tabHostnames[tabId] = new URL(changeInfo.url).hostname; } catch (e) { }
    }
});

chrome.action.onClicked.addListener((tab) => {
    // separate popup window instead of the default browserAction popup — lets the UI stay open
    // and keep downloading while the user switches tabs/windows
    chrome.windows.create({
        url: chrome.runtime.getURL('src/popup/popup.html') + `?tabId=${tab.id}`,
        type: 'popup',
        width: 600,
        height: 900
    });
});

chrome.tabs.onRemoved.addListener(tabId => delete tabUrls[tabId]);