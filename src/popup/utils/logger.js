import { dom } from '../dom.js';

export function log(msg, cls = '') {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = msg;
    dom.logEl.appendChild(span);
    dom.logEl.scrollTop = dom.logEl.scrollHeight;
}

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