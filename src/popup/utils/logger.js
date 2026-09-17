import { dom } from '../dom.js';

export function log(msg, cls = '') {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = msg;
    dom.logEl.appendChild(span);
    dom.logEl.scrollTop = dom.logEl.scrollHeight; // auto-scroll to keep newest line in view during long downloads
}

// ffmpeg.wasm stderr is extremely verbose (build config, per-frame progress, stream metadata) —
// this filters it down to lines actually worth showing the user, keeping only real errors/warnings
export function shouldLogFfmpeg(msg) {
    const m = msg.trim();
    const suppress = [
        'frame=', 'built with', 'configuration:', 'lib',
        'Stream mapping', 'Stream #', 'Input #', 'Output #',
        'Duration', 'Metadata', 'encoder', 'Error closing file',
        '[mp4', '[mov', '[matroska', 'Non-monotonous',
        '  '
    ];
    return !suppress.some(s => m.startsWith(s));
}