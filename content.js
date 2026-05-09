(function () {
    'use strict';

    const _origFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (url.includes('.m3u8')) {
            chrome.runtime.sendMessage({ type: 'HLS_DETECTED', url });
        }
        return _origFetch(...args);
    };

    const _origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (typeof url === 'string' && url.includes('.m3u8')) {
            chrome.runtime.sendMessage({ type: 'HLS_DETECTED', url });
        }
        return _origOpen.call(this, method, url, ...rest);
    };
    window.addEventListener('message', async (event) => {
        if (event.source !== window || event.data?.type !== 'FETCH_M3U8_REQUEST') return;
        try {
            const res = await _origFetch(event.data.url);
            const text = await res.text();
            window.postMessage({ type: 'FETCH_M3U8_RESPONSE', id: event.data.id, text }, '*');
        } catch (e) {
            window.postMessage({ type: 'FETCH_M3U8_RESPONSE', id: event.data.id, error: e.message }, '*');
        }
    });
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type !== 'PROXY_FETCH') return;
        window.postMessage({ type: 'FETCH_M3U8_REQUEST', url: msg.url, id: msg.id }, '*');
    });
})();