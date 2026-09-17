// central DOM cache — grabbed once at module load, since popup.html's own elements
// never get rebuilt/replaced (unlike the injected history/settings views, see views.js)
export const dom = {
    m3u8SelectEl: document.getElementById('m3u8-select'),
    m3u8Selected: document.getElementById('m3u8-selected'),
    m3u8Options: document.getElementById('m3u8-options'),
    detectedLabel: document.getElementById('detected-label'),
    logEl: document.getElementById('log'),
    barEl: document.getElementById('bar'),
    percentEl: document.getElementById('bar-percent'),
    barEtaEl: document.getElementById('bar-eta'),
    startBtn: document.getElementById('start-btn'),
    cancelBtn: document.getElementById('cancel-btn'),
    btnMp4: document.getElementById('fmt-mp4'),
    btnTs: document.getElementById('fmt-ts'),
    mainBody: document.getElementById('body'),
};