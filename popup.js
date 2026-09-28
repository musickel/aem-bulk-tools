document.addEventListener("DOMContentLoaded", () => {
  // Navigation Tabs Engine
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn, .tab-content").forEach(el => el.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    });
  });

  // UI Theme Switcher Engine (Light vs Dark Adobe Spectrum)
  const chkToggleTheme = document.getElementById("chkToggleTheme");
  chrome.storage.local.get("ui_theme", (data) => {
    const currentTheme = data.ui_theme || "dark";
    document.documentElement.setAttribute("data-theme", currentTheme);
    if (chkToggleTheme) chkToggleTheme.checked = currentTheme === "dark";
  });

  if (chkToggleTheme) {
    chkToggleTheme.addEventListener("change", () => {
      const selectedTheme = chkToggleTheme.checked ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", selectedTheme);
      chrome.storage.local.set({ ui_theme: selectedTheme });
    });
  }

  // Header Button: Open User Guide
  const btnOpenGuide = document.getElementById("btnOpenGuide");
  if (btnOpenGuide) {
    btnOpenGuide.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("guide.html") });
    });
  }

  // Header Button: Open Extension in Full Browser Tab
  const btnOpenFullTab = document.getElementById("btnOpenFullTab");
  if (btnOpenFullTab) {
    btnOpenFullTab.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
    });
  }

  // Controls & Element References
  const selProfile = document.getElementById("selProfile");
  const selDeleteProfile = document.getElementById("selDeleteProfile");
  const consoleLog = document.getElementById("consoleLog");
  const progressFill = document.getElementById("progressFill");
  const autoTokenStatus = document.getElementById("autoTokenStatus");

  // Profile Management Elements
  const accEnvName = document.getElementById("accEnvName");
  const accDomain = document.getElementById("accDomain");
  const accAuthMode = document.getElementById("accAuthMode");
  const basicAuthFields = document.getElementById("basicAuthFields");
  const staticImsFields = document.getElementById("staticImsFields");
  const accUsername = document.getElementById("accUsername");
  const accPassword = document.getElementById("accPassword");
  const accStaticToken = document.getElementById("accStaticToken");
  const btnSaveAccount = document.getElementById("btnSaveAccount");
  const btnDeleteAccount = document.getElementById("btnDeleteAccount");

  // Backup & Restore Elements
  const btnBackup = document.getElementById("btnBackup");
  const btnRestore = document.getElementById("btnRestore");
  const fileRestore = document.getElementById("fileRestore");

  let profiles = {};
  let autoDetectedImsToken = "";

  loadProfiles();
  checkAutoCapturedToken();

  accAuthMode.addEventListener("change", updateAccountFormVisibility);

  function updateAccountFormVisibility() {
    const val = accAuthMode.value;
    basicAuthFields.style.display = (val === "BASIC") ? "block" : "none";
    staticImsFields.style.display = (val === "STATIC_IMS") ? "block" : "none";
  }

  function checkAutoCapturedToken() {
    chrome.storage.local.get(["activeAutoImsToken", "tokenCapturedAt"], (data) => {
      if (data.activeAutoImsToken) {
        autoDetectedImsToken = data.activeAutoImsToken;
        const timeAgo = Math.round((Date.now() - (data.tokenCapturedAt || Date.now())) / 1000);
        autoTokenStatus.textContent = `🟢 IMS Active (${timeAgo}s ago)`;
      } else {
        autoTokenStatus.textContent = "🔵 Session Mode Ready";
      }
    });
  }

  function loadProfiles() {
    chrome.storage.local.get("aem_profiles", (data) => {
      profiles = data.aem_profiles || {};
      selProfile.innerHTML = "";
      selDeleteProfile.innerHTML = "";

      const keys = Object.keys(profiles);
      if (keys.length === 0) {
        selProfile.innerHTML = "<option value=''>No Profiles Saved</option>";
        selDeleteProfile.innerHTML = "<option value=''>No Profiles Available</option>";
        return;
      }

      keys.forEach(env => {
        const opt1 = document.createElement("option");
        opt1.value = env;
        opt1.textContent = `${env} (${profiles[env].domain})`;
        selProfile.appendChild(opt1);

        const opt2 = document.createElement("option");
        opt2.value = env;
        opt2.textContent = `${env} (${profiles[env].domain})`;
        selDeleteProfile.appendChild(opt2);
      });

      fillAccountForm(selProfile.value);
    });
  }

  selProfile.addEventListener("change", () => fillAccountForm(selProfile.value));

  function fillAccountForm(envKey) {
    if (!profiles[envKey]) return;
    const p = profiles[envKey];
    accEnvName.value = envKey;
    accDomain.value = p.domain;
    accAuthMode.value = p.authMode || "COOKIE_SESSION";
    accUsername.value = p.username || "";
    accPassword.value = p.password || "";
    accStaticToken.value = p.staticToken || "";
    updateAccountFormVisibility();
  }

  // Save Account Profile
  btnSaveAccount.addEventListener("click", () => {
    const env = accEnvName.value.trim();
    const domain = accDomain.value.trim().replace(/\/+$/, "");

    if (!env || !domain) return alert("Please enter Environment Name and Domain URL.");

    profiles[env] = {
      domain,
      authMode: accAuthMode.value,
      username: accUsername.value.trim(),
      password: accPassword.value.trim(),
      staticToken: accStaticToken.value.trim()
    };

    chrome.storage.local.set({ aem_profiles: profiles }, () => {
      alert(`Profile '${env}' saved successfully!`);
      loadProfiles();
    });
  });

  // Delete Account Profile
  btnDeleteAccount.addEventListener("click", () => {
    const envToDelete = selDeleteProfile.value;
    if (!envToDelete || !profiles[envToDelete]) return alert("Please select a valid profile to delete.");

    if (confirm(`Delete profile '${envToDelete}'?`)) {
      delete profiles[envToDelete];
      chrome.storage.local.set({ aem_profiles: profiles }, () => {
        alert(`Profile '${envToDelete}' deleted.`);
        loadProfiles();
      });
    }
  });

  // AES-256 GCM Encrypted Backup & Restore Utilities
  async function deriveKey(passphrase, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  btnBackup.addEventListener("click", async () => {
    if (Object.keys(profiles).length === 0) return alert("No account profiles exist to backup.");
    const passphrase = prompt("Enter a Passphrase to encrypt your backup:");
    if (!passphrase) return;

    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(passphrase, salt);
      const plainData = new TextEncoder().encode(JSON.stringify(profiles));
      const encryptedContent = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainData);

      const backupBundle = {
        salt: Array.from(salt),
        iv: Array.from(iv),
        ciphertext: Array.from(new Uint8Array(encryptedContent))
      };

      const blob = new Blob([JSON.stringify(backupBundle)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `aem-profiles-backup-${Date.now()}.aemback`;
      a.click();
    } catch (err) {
      alert(`Encryption failed: ${err.message}`);
    }
  });

  btnRestore.addEventListener("click", () => fileRestore.click());

  fileRestore.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const passphrase = prompt("Enter the Passphrase used to encrypt this backup:");
    if (!passphrase) {
      fileRestore.value = "";
      return;
    }

    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const salt = new Uint8Array(bundle.salt);
      const iv = new Uint8Array(bundle.iv);
      const ciphertext = new Uint8Array(bundle.ciphertext);
      const key = await deriveKey(passphrase, salt);

      const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
      const restoredProfiles = JSON.parse(new TextDecoder().decode(decryptedBuffer));

      profiles = { ...profiles, ...restoredProfiles };
      chrome.storage.local.set({ aem_profiles: profiles }, () => {
        alert("Credentials successfully restored!");
        loadProfiles();
      });
    } catch (err) {
      alert("Failed to decrypt file. Please verify the passphrase and backup file format.");
    } finally {
      fileRestore.value = "";
    }
  });

  // Shared Global Helper API
  window.AEMApp = {
    getSelectedProfile: () => {
      const envKey = selProfile.value;
      return profiles[envKey] ? { envKey, ...profiles[envKey] } : null;
    },
    getAuthHeader: async (profile) => {
      if (profile.authMode === "AUTO_IMS") {
        if (!autoDetectedImsToken) {
          const res = await new Promise(r => chrome.runtime.sendMessage({
            action: "FETCH_IMS_TOKEN_ON_DEMAND",
            domain: profile.domain
          }, r));
          if (res && res.token) autoDetectedImsToken = res.token;
        }
        if (!autoDetectedImsToken) {
          alert("No IMS token captured. Open target AEM tab or use Cookie Auth.");
          return null;
        }
        return `Bearer ${autoDetectedImsToken}`;
      } else if (profile.authMode === "STATIC_IMS") {
        return `Bearer ${profile.staticToken}`;
      } else if (profile.authMode === "BASIC") {
        return `Basic ${btoa(`${profile.username}:${profile.password}`)}`;
      }
      return "COOKIE_SESSION";
    },
    verifyConnectivity: async (profile, authHeader) => {
      const res = await new Promise(r => chrome.runtime.sendMessage({
        action: "TEST_SERVER_CONNECTION",
        payload: { domain: profile.domain, authHeader }
      }, r));
      if (!res || !res.connected) {
        window.AEMApp.log(`🔴 CONNECTION ERROR: ${profile.domain} (${res?.error || 'HTTP ' + res?.status})`);
        return false;
      }
      return true;
    },
    log: (msg) => {
      const timestamp = new Date().toLocaleTimeString();
      consoleLog.textContent += `\n[${timestamp}] ${msg}`;
      consoleLog.scrollTop = consoleLog.scrollHeight;
    },
    getConsoleLogs: () => consoleLog.textContent,
    setProgress: (percent) => {
      progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    },
    sendLogToGoogleSheet: async (moduleName, logText) => {
      const profile = window.AEMApp.getSelectedProfile();
      const authHeader = profile ? await window.AEMApp.getAuthHeader(profile) : "";

      chrome.runtime.sendMessage({
        action: "LOG_TO_GOOGLE_SHEET",
        payload: {
          moduleName,
          profileName: profile ? profile.envKey : "N/A",
          domain: profile ? profile.domain : "N/A",
          authHeader,
          logText
        }
      });
    }
  };

  document.getElementById("btnClearLog").addEventListener("click", () => consoleLog.textContent = "Log cleared.");
  document.getElementById("btnExportLog").addEventListener("click", () => {
    const blob = new Blob([consoleLog.textContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aem-bulk-tools-log-${Date.now()}.txt`;
    a.click();
  });
});