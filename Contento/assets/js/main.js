(function () {
    "use strict";

    // =========================================================
    // CONFIGURATION
    // =========================================================
    const PASTEFY_PASTE_ID = "2unvISpu";
    const PASTEFY_API_KEY = "E27hWbP6W35CxxCOaw5sH4qjBHm3xyBOSboXtkQLABXOmGuS6V0z0zaxIM8X"; //
    const API_BASE = "https://pastefy.app/api/v2/paste/";

    const ITERATIONS = 310000;
    const SAVE_DELAY = 800;
    const FORMAT_TAG = "secure-save-v1";

    // =========================================================
    // STATE
    // =========================================================
    let isUnlocked = false;
    let vaultPassword = null;
    let saveTimer = null;
    let saveQueue = Promise.resolve();
    let loading = false;
    let needsMigration = false;   // legacy content detected

    const lockScreen = document.getElementById("lockScreen");
    const appContent = document.getElementById("appContent");
    const passwordInput = document.getElementById("passwordInput");
    const unlockBtn = document.getElementById("unlockBtn");
    const lockError = document.getElementById("lockError");
    const textarea = document.getElementById("contentArea");
    const copyBtn = document.getElementById("copyBtn");
    const pasteBtn = document.getElementById("pasteBtn");
    const clearBtn = document.getElementById("clearBtn");
    const lockBtn = document.getElementById("lockBtn");
    const statusDiv = document.getElementById("statusMessage");

    // =========================================================
    // HELPERS
    // =========================================================
    function setStatus(message, error = false) {
        statusDiv.textContent = message;
        statusDiv.classList.toggle("empty-badge", error);
    }

    function base64Encode(bytes) {
        let binary = "";
        for (const byte of bytes) {
            binary += String.fromCharCode(byte);
        }
        return btoa(binary);
    }

    function base64Decode(value) {
        const binary = atob(value);
        return Uint8Array.from(binary, c => c.charCodeAt(0));
    }

    // =========================================================
    // PASSWORD-BASED ENCRYPTION (Web Crypto, AES-GCM + PBKDF2)
    // =========================================================
    async function deriveEncryptionKey(password, salt) {
        const material = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(password),
            "PBKDF2",
            false,
            ["deriveKey"]
        );

        return crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: salt,
                iterations: ITERATIONS,
                hash: "SHA-256"
            },
            material,
            {
                name: "AES-GCM",
                length: 256
            },
            false,
            ["encrypt", "decrypt"]
        );
    }

    async function encryptContent(plainText) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));

        const key = await deriveEncryptionKey(vaultPassword, salt);

        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            key,
            new TextEncoder().encode(plainText)
        );

        return {
            format: FORMAT_TAG,
            algorithm: "AES-GCM",
            kdf: "PBKDF2-SHA-256",
            iterations: ITERATIONS,
            salt: base64Encode(salt),
            iv: base64Encode(iv),
            ciphertext: base64Encode(new Uint8Array(encrypted))
        };
    }

    async function decryptContent(record) {
        if (
            !record ||
            record.format !== FORMAT_TAG ||
            record.algorithm !== "AES-GCM" ||
            record.kdf !== "PBKDF2-SHA-256" ||
            record.iterations !== ITERATIONS
        ) {
            throw new Error(
                "Unsupported paste format. This may be an older encrypted paste."
            );
        }

        const salt = base64Decode(record.salt);
        const iv = base64Decode(record.iv);
        const ciphertext = base64Decode(record.ciphertext);

        if (
            salt.length !== 16 ||
            iv.length !== 12 ||
            ciphertext.length < 16
        ) {
            throw new Error("The encrypted paste is invalid or damaged.");
        }

        const key = await deriveEncryptionKey(vaultPassword, salt);

        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            key,
            ciphertext
        );

        return new TextDecoder().decode(decrypted);
    }

    // =========================================================
    // PASTEFY API
    // =========================================================
    function validateConfig() {
        if (
            !PASTEFY_PASTE_ID ||
            PASTEFY_PASTE_ID === "YOUR_PASTE_ID" ||
            !PASTEFY_API_KEY ||
            PASTEFY_API_KEY === "YOUR_NEW_API_KEY"
        ) {
            throw new Error("Configure your Pastefy paste ID and API key.");
        }

        if (!window.isSecureContext || !crypto.subtle) {
            throw new Error("Open this website over HTTPS to use encryption.");
        }
    }

    async function pasteRequest(method, body = null) {
        validateConfig();

        const options = {
            method: method,
            headers: {
                "Authorization": "Bearer " + PASTEFY_API_KEY,
                "Accept": "application/json"
            }
        };

        if (body !== null) {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(body);
        }

        const response = await fetch(
            API_BASE + encodeURIComponent(PASTEFY_PASTE_ID),
            options
        );

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                throw new Error("Pastefy authorization failed. Check your API key and paste permissions.");
            }
            if (response.status === 404) {
                throw new Error("Paste not found. Check your paste ID.");
            }
            throw new Error("Pastefy returned HTTP " + response.status);
        }

        if (response.status === 204) return {};

        const text = await response.text();
        if (!text) return {};

        try {
            return JSON.parse(text);
        } catch (_) {
            throw new Error("Pastefy returned an unexpected response.");
        }
    }

    // =========================================================
    // FETCH — handles BOTH new-format and legacy content
    // =========================================================
    async function fetchAndDecryptPaste() {
        const data = await pasteRequest("GET");
        const raw = data.content;

        // Empty paste → fresh vault
        if (raw === null || raw === undefined || raw === "") {
            needsMigration = false;
            return "";
        }

        // Try to parse as our new encrypted record
        let record = null;
        if (typeof raw === "string") {
            try {
                record = JSON.parse(raw);
            } catch (_) {
                // Not JSON → legacy plain text
            }
        } else if (typeof raw === "object") {
            record = raw;
        }

        // CASE 1: New format → decrypt with password
        if (record && record.format === FORMAT_TAG) {
            needsMigration = false;
            try {
                return await decryptContent(record);
            } catch (error) {
                if (error.name === "OperationError") {
                    throw new Error("Wrong vault password or damaged encrypted content.");
                }
                throw error;
            }
        }

        // CASE 2: Legacy plain text → return as-is, flag for migration
        if (typeof raw === "string") {
            needsMigration = true;
            return raw;
        }

        // CASE 3: Some other JSON object we don't recognize
        needsMigration = true;
        return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
    }

    async function encryptAndPushPaste(plaintext) {
        const record = await encryptContent(plaintext);

        await pasteRequest("PUT", {
            type: "PASTE",
            title: "Secure Save",
            content: JSON.stringify(record),
            visibility: "UNLISTED",
            encrypted: false
        });

        needsMigration = false;
    }

    // =========================================================
    // LOCK SCREEN / UNLOCK
    // =========================================================
    function showLockScreen() {
        isUnlocked = false;
        vaultPassword = null;
        clearTimeout(saveTimer);

        lockScreen.classList.remove("hidden");
        appContent.classList.remove("unlocked");

        passwordInput.value = "";
        lockError.textContent = "";
        textarea.value = "";

        setStatus("🔒 locked");
        passwordInput.focus();
    }

    function showApp() {
        isUnlocked = true;
        lockScreen.classList.add("hidden");
        appContent.classList.add("unlocked");
    }

    async function attemptUnlock() {
        if (loading) return;

        lockError.textContent = "";
        const entered = passwordInput.value;

        if (!entered) {
            lockError.textContent = "Please enter your vault password.";
            return;
        }

        loading = true;
        unlockBtn.disabled = true;
        setStatus("⏳ loading encrypted paste…");

        try {
            validateConfig();

            vaultPassword = entered;

            const content = await fetchAndDecryptPaste();

            textarea.value = content;
            showApp();
            passwordInput.value = "";

            if (needsMigration) {
                setStatus("🔓 unlocked · legacy content (will encrypt on next save)");
                // Auto-migrate immediately so it's protected right away
                await saveContent();
            } else if (content === "") {
                setStatus("🔓 unlocked · empty vault");
            } else {
                setStatus("🔓 unlocked · encrypted content loaded");
            }

            textarea.focus();
        } catch (error) {
            vaultPassword = null;
            lockError.textContent = error.message;
            setStatus("⚠️ could not unlock", true);
        } finally {
            loading = false;
            unlockBtn.disabled = false;
        }
    }

    // =========================================================
    // SAVE — DEBOUNCED AND SEQUENCED
    // =========================================================
    async function saveContent() {
        if (!isUnlocked || !vaultPassword) return;

        saveQueue = saveQueue
            .catch(() => {})
            .then(async () => {
                if (!isUnlocked || !vaultPassword) return;

                const latestContent = textarea.value;

                setStatus("🔐 encrypting and saving…");
                await encryptAndPushPaste(latestContent);

                if (isUnlocked && textarea.value === latestContent) {
                    setStatus(
                        "✓ encrypted and saved · " +
                        new Date().toLocaleTimeString()
                    );
                } else if (isUnlocked) {
                    setStatus("✍️ newer changes waiting to save…");
                    scheduleSave();
                }
            })
            .catch(error => {
                console.error("Secure Save:", error);
                setStatus("⚠️ save failed: " + error.message, true);
            });

        return saveQueue;
    }

    function scheduleSave() {
        if (!isUnlocked) return;

        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveContent(), SAVE_DELAY);
        setStatus("✍️ unsaved changes…");
    }

    // =========================================================
    // CLIPBOARD
    // =========================================================
    async function copyToClipboard() {
        if (!isUnlocked) return;

        try {
            await navigator.clipboard.writeText(textarea.value);
            setStatus("📋 copied to clipboard");
        } catch (_) {
            textarea.select();
            const success = document.execCommand("copy");
            setStatus(
                success ? "📋 copied to clipboard" : "⚠️ copy failed",
                !success
            );
        }
    }

    async function pasteFromClipboard() {
        if (!isUnlocked) return;

        try {
            const text = await navigator.clipboard.readText();
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;

            textarea.setRangeText(text, start, end, "end");
            textarea.focus();
            scheduleSave();
        } catch (_) {
            textarea.focus();
            setStatus("⚠️ Use Ctrl+V / ⌘V to paste.", true);
        }
    }

    // =========================================================
    // CLEAR
    // =========================================================
    async function clearContent() {
        if (!isUnlocked) return;

        if (!confirm("Clear the shared vault for everyone?")) return;

        textarea.value = "";
        clearTimeout(saveTimer);
        await saveContent();
    }

    // =========================================================
    // LOCK — WAIT FOR PENDING SAVE
    // =========================================================
    async function lockApp() {
        if (!isUnlocked) {
            showLockScreen();
            return;
        }

        clearTimeout(saveTimer);

        try {
            await saveQueue;
        } finally {
            showLockScreen();
        }
    }

    // =========================================================
    // EVENT LISTENERS
    // =========================================================
    unlockBtn.addEventListener("click", attemptUnlock);

    passwordInput.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            attemptUnlock();
        }
    });

    textarea.addEventListener("input", scheduleSave);
    textarea.addEventListener("change", scheduleSave);

    copyBtn.addEventListener("click", copyToClipboard);
    pasteBtn.addEventListener("click", pasteFromClipboard);
    clearBtn.addEventListener("click", clearContent);
    lockBtn.addEventListener("click", lockApp);

    window.addEventListener("beforeunload", () => {
        clearTimeout(saveTimer);
    });

    showLockScreen();
})();