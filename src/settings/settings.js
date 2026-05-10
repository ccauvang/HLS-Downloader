const DEFAULTS = { filename: 'video', concurrency: 5, format: 'mp4' };
let concurrency = DEFAULTS.concurrency;
let format = DEFAULTS.format;

function initSettings() {
    // load
    chrome.storage.sync.get(DEFAULTS, (s) => {
        concurrency = s.concurrency;
        format = s.format;
        document.getElementById('default-filename').value = s.filename;
        document.querySelectorAll('.batch-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.val) === concurrency);
        });
        document.getElementById('fmt-mp4').className = format === 'mp4' ? 'fmt-active' : 'fmt-inactive';
        document.getElementById('fmt-ts').className = format === 'ts' ? 'fmt-active' : 'fmt-inactive';
    });

    // Format choose
    document.getElementById('fmt-mp4').addEventListener('click', () => {
        format = 'mp4';
        document.getElementById('fmt-mp4').className = 'fmt-active';
        document.getElementById('fmt-ts').className = 'fmt-inactive';
    });
    document.getElementById('fmt-ts').addEventListener('click', () => {
        format = 'ts';
        document.getElementById('fmt-ts').className = 'fmt-active';
        document.getElementById('fmt-mp4').className = 'fmt-inactive';
    });

    // Batch btn
    document.querySelectorAll('.batch-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            concurrency = parseInt(btn.dataset.val);
            document.querySelectorAll('.batch-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    // save
    document.getElementById('save-btn').addEventListener('click', () => {
        const filename = document.getElementById('default-filename').value.trim() || 'video';
        chrome.storage.sync.set({ filename, concurrency, format }, () => {
            const msg = document.getElementById('saved-msg');
            msg.classList.add('show');
            setTimeout(() => msg.classList.remove('show'), 2000);
        });
    });
}

window.hlsSettingsInit = initSettings;
initSettings();