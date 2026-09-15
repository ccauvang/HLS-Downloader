import { dom } from '../dom.js';
import { state } from '../state.js';

export function updateDropdown() {
    dom.detectedLabel.textContent = `Detected streams (${state.detectedM3u8.length})`;
    dom.m3u8Options.innerHTML = '';

    if (!state.detectedM3u8.length) {
        dom.m3u8Selected.textContent = '— no streams detected yet —';
        state.m3u8Value = '';
        return;
    }

    state.detectedM3u8.forEach((entry, i) => {
        const url = typeof entry === 'string' ? entry : entry.url;
        const label = typeof entry === 'string' ? '' : ` — ${entry.label}`;
        const shortUrl = url.length > 35 ? url.slice(0, 35) + '...' : url;
        const opt = document.createElement('div');
        opt.className = 'custom-option';
        opt.textContent = `${i + 1}. ${shortUrl}${label}`;
        opt.title = url;
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            state.m3u8Value = url;
            state.currentFrameId = entry.frameId ?? 0;
            dom.m3u8Selected.textContent = opt.textContent;
            document.getElementById('m3u8-url').value = url;
            dom.m3u8Options.querySelectorAll('.custom-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            dom.m3u8SelectEl.classList.remove('open');
        });
        dom.m3u8Options.appendChild(opt);
    });
}

export function wireDropdown() {
    dom.m3u8SelectEl.addEventListener('click', () => {
        dom.m3u8SelectEl.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
        if (!dom.m3u8SelectEl.contains(e.target)) dom.m3u8SelectEl.classList.remove('open');
    });
}