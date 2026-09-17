import { dom } from '../dom.js';
import { state } from '../state.js';
import { formatBytes, formatDuration } from '../utils/format.js';

export function setProgress(v, total, startTime, bytesDone) {
    const pct = ((v / total) * 100).toFixed(1);
    dom.barEl.style.width = pct + '%';
    dom.percentEl.textContent = pct + '%';
    if (startTime && v > 0) {
        const elapsed = (performance.now() - startTime) / 1000;
        const concurrency = state.CONCURRENCY_SETTING || 1;
        const delayMs = (state.chunkDelayEnabled && state.chunkDelay > 0) ? state.chunkDelay : 0;

        const wavesDone = Math.floor(v / concurrency);
        const delaySoFar = (wavesDone * delayMs) / 1000;
        const pureElapsed = Math.max(elapsed - delaySoFar, elapsed * 0.01, 0.001); // floor guards against edge-case overshoot

        const pureRate = v / pureElapsed;
        const remainingDownload = (total - v) / pureRate;

        const wavesRemaining = Math.ceil((total - v) / concurrency);
        const remainingDelay = (wavesRemaining * delayMs) / 1000;

        const remaining = remainingDownload + remainingDelay;
        const bytesPerSec = bytesDone / elapsed; // real effective throughput — unchanged
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