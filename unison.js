const bun = await import("bun");

const CONFIG = {
    runOnStartup: true,
    logUnisonStdout: true,
    debounceMs: 10000,
    maxWaitMs: 60000,
    profiles: {
        "home-elite": {
            include: [
                "/home/user/Documents",
                "/home/user/Pictures"
            ],
            exclude: [
                ".cache",
                "Downloads"
            ]
        },
    },
};

const state = {};

for (const [profileName, profile] of Object.entries(CONFIG.profiles)) {
    console.log(`[${profileName}] Watching via inotifywait: ${profile.include.join(", ")}`);

    state[profileName] = {
        debounceTimer: null,
        maxTimer: null,
        unisonRunning: false,
        rerunPending: false,
    };

    for (const dir of profile.include) startWatcher(profileName, dir, profile);

    if (CONFIG.runOnStartup) {
        log(profileName, "Initial startup sync triggered.");
        triggerUnison(profileName);
    }
}

function startWatcher(profileName, dir, profile) {
    const args = [
        "-m", "-r",
        "-e", "create,delete,modify,move",
        "--format", "%e %w%f",
        dir
    ];

    const watcher = bun.spawn(["inotifywait", ...args], {
        stdout: "pipe",
        stderr: "ignore",
    });

    readLines(watcher.stdout, (line) => {
        if (!line.trim()) return;
        const [event, ...rest] = line.trim().split(" ");
        const path = rest.join(" ");
        if (isExcluded(profile, path)) return;
        log(profileName, `${event}: ${path}`);
        handleChange(profileName);
    });

    watcher.exited.then(code => {
        log(profileName, `inotifywait exited (code ${code}) — restarting watcher...`);
        setTimeout(() => startWatcher(profileName, dir, profile), 1000);
    });
}

async function readLines(stream, callback) {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) callback(line);
    }
}

function handleChange(profileName) {
    const s = state[profileName];
    const cfg = CONFIG;

    // if currently running, mark that another run is needed
    if (s.unisonRunning) {
        s.rerunPending = true;
        log(profileName, "Change detected while syncing — scheduling rerun.");
        return;
    }

    if (!s.maxTimer) {
        s.maxTimer = setTimeout(() => {
            log(profileName, "Max wait reached — forcing sync.");
            triggerUnison(profileName);
        }, cfg.maxWaitMs);
    }

    if (s.debounceTimer) clearTimeout(s.debounceTimer);
    s.debounceTimer = setTimeout(() => {
        log(profileName, "Debounce ended — syncing.");
        triggerUnison(profileName);
    }, cfg.debounceMs);
}

function triggerUnison(profileName) {
    const s = state[profileName];
    if (s.unisonRunning) {
        log(profileName, "Already syncing — skipping trigger.");
        return;
    }

    clearTimers(profileName);
    s.unisonRunning = true;
    log(profileName, "Starting Unison...");

    const stdio = CONFIG.logUnisonStdout ? "inherit" : "ignore";
    const proc = bun.spawn(["unison", profileName, "-auto", "-batch"], {
        stdout: stdio,
        stderr: stdio,
    });

    proc.exited.then(code => {
        log(profileName, `Unison exited with code ${code}`);
        s.unisonRunning = false;

        // if changes happened while syncing, rerun immediately
        if (s.rerunPending) {
            s.rerunPending = false;
            log(profileName, "Pending changes detected — rerunning sync.");
            triggerUnison(profileName);
        }
    });
}

function clearTimers(profileName) {
    const s = state[profileName];
    if (s.debounceTimer) clearTimeout(s.debounceTimer);
    if (s.maxTimer) clearTimeout(s.maxTimer);
    s.debounceTimer = null;
    s.maxTimer = null;
}

function isExcluded(profile, path) {
    return profile.exclude.some(ex => path.includes(ex));
}

function log(profileName, msg) {
    const now = new Date().toISOString().replace("T", " ").replace(/\..+/, "");
    console.log(`[${now}] [${profileName}] ${msg}`);
}
