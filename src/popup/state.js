export const state = {
    tab: null,
    STATE_KEY: '',
    detectedM3u8: [],
    m3u8Value: '',
    dlFormat: 'mp4',
    CONCURRENCY_SETTING: 5,
    defaultFilename: 'video',
    totalDuration: 0,
    bytesDownloaded: 0,
    cancelled: false,
    ffmpeg: null,
    hadCriticalFfmpegError: false,
    currentFrameId: 0,
    chunkDelay: 300,
    chunkDelayEnabled: true,
};

export function saveState() {
    chrome.storage.session.set({
        [state.STATE_KEY]: {
            links: document.getElementById('links').value,
            filename: document.getElementById('filename').value,
            m3u8Url: document.getElementById('m3u8-url').value,
            logHtml: document.getElementById('log').innerHTML,
            dlFormat: state.dlFormat,
            detectedM3u8: state.detectedM3u8
        }
    });
}