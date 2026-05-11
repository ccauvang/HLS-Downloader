chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => { });

const tabUrls = {};
const activePopupTabs = new Set();

function addUrl(tab, url) {
    if (tab < 0) return;
    if (!tabUrls[tab]) tabUrls[tab] = [];
    if (!tabUrls[tab].includes(url)) {
        tabUrls[tab].push(url);
        chrome.action.setBadgeText({ text: String(tabUrls[tab].length), tabId: tab });
        chrome.action.setBadgeBackgroundColor({ color: '#e93434', tabId: tab });
        chrome.runtime.sendMessage({ type: 'HLS_DETECTED', url, tabId: tab }).catch(() => { });
    }
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
        if (activePopupTabs.size > 0 && !activePopupTabs.has(details.tabId)) return;
        if (details.url.includes('.m3u8') || details.url.includes('.mpd')) {
            addUrl(details.tabId, details.url);
        }

    },
    { urls: ['*://*/*'] }
);

chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
        const ct = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
        const tab = details.tabId;
        if (tab < 0) return;
        if (activePopupTabs.size > 0 && !activePopupTabs.has(details.tabId)) return;

        if (ct.includes('mpegurl') || ct.includes('apple.mpegurl')) {
            addUrl(tab, details.url);
            return;
        }


        const size = parseInt(details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-length')?.value || '0');
        if (ct.includes('text/plain') || ct.includes('octet-stream')) {
            if (!looksLikeSegment(details.url) && (size === 0 || size < 500000)) {
                addUrl(tab, details.url);
            }
        }
    },
    { urls: ['*://*/*'] },
    ['responseHeaders']
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'HLS_DETECTED') {
        if (sender?.tab?.id) addUrl(sender.tab.id, msg.url);
        return;
    }
    if (msg.type === 'GET_URLS') {
        sendResponse(tabUrls[msg.tabId] || []);
        return true;
    }
    if (msg.type === 'SET_ACTIVE_TAB') {
        activePopupTabs.add(msg.tabId);
        return;
    }
    if (msg.type === 'UNSET_ACTIVE_TAB') {
        activePopupTabs.delete(msg.tabId);
        return;
    }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', changes });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        delete tabUrls[tabId];
        chrome.action.setBadgeText({ text: '', tabId });
    }
});

chrome.action.onClicked.addListener((tab) => {
    chrome.windows.create({
        url: chrome.runtime.getURL('src/popup/popup.html') + `?tabId=${tab.id}`,
        type: 'popup',
        width: 600,
        height: 850
    });
});

chrome.tabs.onRemoved.addListener(tabId => delete tabUrls[tabId]);