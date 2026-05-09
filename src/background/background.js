const tabUrls = {};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'HLS_DETECTED') {
        const tab = sender.tab.id;
        if (!tabUrls[tab]) tabUrls[tab] = [];
        if (!tabUrls[tab].includes(msg.url)) {
            tabUrls[tab].push(msg.url);
            chrome.action.setBadgeText({ text: String(tabUrls[tab].length), tabId: tab });
            chrome.action.setBadgeBackgroundColor({ color: '#e93434', tabId: tab });
        }
        return;
    }
    if (msg.type === 'GET_URLS') {
        sendResponse(tabUrls[msg.tabId] || []);
        return true;
    }
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
        width: 520,
        height: 750
    });
});

chrome.tabs.onRemoved.addListener(tabId => delete tabUrls[tabId]);