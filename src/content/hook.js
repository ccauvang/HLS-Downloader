(function () {
    const _origFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (url.includes('hls-key')) {
            const res = await _origFetch(...args);
            res.clone().arrayBuffer().then(buf => {
                const bytes = Array.from(new Uint8Array(buf));
                window.postMessage({ type: 'HLS_KEY_CAPTURED', url, bytes }, '*');
            }).catch(() => { });
            return res;
        }
        return _origFetch(...args);
    };

    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._hookUrl = url;
        return _origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        if (this._hookUrl?.includes('hls-key')) {
            this.addEventListener('load', function () {
                let bytes = null;
                try {
                    if (this.responseType === 'arraybuffer') {
                        bytes = Array.from(new Uint8Array(this.response));
                    } else {
                        // text fallback — convert string chars to byte array
                        bytes = Array.from(this.responseText).map(c => c.charCodeAt(0));
                    }
                } catch (e) { bytes = null; }
                window.postMessage({ type: 'HLS_KEY_CAPTURED', url: this._hookUrl, bytes }, '*');
            });
        }
        return _origSend.call(this, ...args);
    };
})();