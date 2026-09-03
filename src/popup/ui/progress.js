import { dom } from '../dom.js';
import { formatBytes, formatDuration } from '../utils/format.js';

export function setProgress(v, total, startTime, bytesDone) {
    const pct = ((v / total) * 100).toFixed(1);
    dom.barEl.style.width = pct + '%';
    dom.percentEl.textContent = pct + '%';
    if (startTime && v > 0) {
        const elapsed = (performance.now() - startTime) / 1000;
        const rate = v / elapsed;
        const remaining = (total - v) / rate;
        const bytesPerSec = bytesDone / elapsed;
        dom.barEtaEl.textContent =
            `↓ ${formatBytes(bytesPerSec)}/s · ${formatDuration(Math.ceil(remaining))}`;
    } else {
        dom.barEtaEl.textContent = '';
    }
}

export function resetUI() {
    dom.startBtn.disabled = false;
    dom.cancelBtn.disabled = true;
}