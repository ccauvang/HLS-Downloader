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
})();