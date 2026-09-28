// Background Service Worker Engine: Proxying, Headers, Fast Parallel CF Upserts & Extraction (Triple-Pipe Delimiter), Page Properties Manager, Asset Mover, Package Builder, Publisher, and Dual-Identity Logging

const GOOGLE_LOG_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwqMjSnx1st_9ooYEEloCdsE-M4Qk-7vbqN3ccoMAqYodaHBtcvmtUYjngi2bzfHYJF/exec";

function sanitizeJcrName(rawName) {
  if (!rawName) return "";
  return String(rawName).trim().toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9\-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function normalizeAssetApiPath(rawPath) {
  if (!rawPath) return "";
  let clean = rawPath.trim().replace(/^\/?content\/dam(\/|$)/i, "/");
  if (!clean.startsWith("/")) clean = "/" + clean;
  return clean.replace(/\/+$/, "");
}

function getFileExtension(filePath) {
  if (!filePath) return "";
  const lastSlash = filePath.lastIndexOf("/");
  const fileName = lastSlash >= 0 ? filePath.substring(lastSlash + 1) : filePath;
  const extIdx = fileName.lastIndexOf(".");
  return extIdx > 0 ? fileName.substring(extIdx).toLowerCase() : "";
}

// ON-DEMAND IMS TOKEN INTERCEPTION ENGINE
let tempCapturedToken = null;

function captureTokenForDomain(targetDomain) {
  return new Promise((resolve) => {
    tempCapturedToken = null;

    const listener = (details) => {
      if (!details.requestHeaders) return;
      for (const header of details.requestHeaders) {
        if (header.name.toLowerCase() === 'authorization' && header.value.startsWith('Bearer ')) {
          tempCapturedToken = header.value.replace('Bearer ', '').trim();
          break;
        }
      }
    };

    const targetUrlPattern = `${targetDomain}/*`;

    chrome.webRequest.onBeforeSendHeaders.addListener(
      listener,
      { urls: [targetUrlPattern] },
      ["requestHeaders"]
    );

    fetch(`${targetDomain}/libs/granite/csrf/token.json`, { method: "GET", cache: "no-cache" })
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        setTimeout(() => {
          chrome.webRequest.onBeforeSendHeaders.removeListener(listener);
          if (tempCapturedToken) {
            chrome.storage.local.set({ 
              activeAutoImsToken: tempCapturedToken, 
              tokenCapturedAt: Date.now() 
            });
          }
          resolve(tempCapturedToken);
        }, 500);
      });
  });
}

async function safeFetch(url, options = {}) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 sec safety timeout
    const res = await fetch(url, { ...options, signal: controller.signal, credentials: "include" });
    clearTimeout(timeoutId);
    
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (res.ok) {
      return { ok: res.ok, status: res.status, statusText: res.statusText, data: json, text, headers: res.headers };
    }
    return await fetchInActiveTab(url, options);
  } catch (err) {
    return await fetchInActiveTab(url, options);
  }
}

async function fetchInActiveTab(url, options = {}) {
  try {
    const urlObj = new URL(url);
    let tabs = await chrome.tabs.query({});
    
    let targetTab = tabs.find(t => t.url && t.url.includes(urlObj.hostname) && !t.url.startsWith("chrome-extension://"));

    if (!targetTab) {
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTab = activeTabs.find(t => t.url && !t.url.startsWith("chrome-extension://"));
    }

    if (!targetTab || !targetTab.id) {
      return { ok: false, status: 0, error: `Please open an active browser tab for ${urlObj.hostname}` };
    }

    const injection = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: async (reqUrl, reqOptions) => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000);
          const res = await fetch(reqUrl, { ...reqOptions, signal: controller.signal, credentials: "include" });
          clearTimeout(timeoutId);
          const text = await res.text();
          let json = null; try { json = JSON.parse(text); } catch (_) {}
          return { ok: res.ok, status: res.status, statusText: res.statusText, data: json, text };
        } catch (err) { return { ok: false, status: 0, error: err.message }; }
      },
      args: [url, options]
    });
    return injection?.[0]?.result || { ok: false, status: 0, error: "Script injection failed" };
  } catch (err) { return { ok: false, status: 0, error: err.message }; }
}

async function fetchCsrfToken(domain, authHeader) {
  try {
    const headers = { "Cache-Control": "no-cache" };
    if (authHeader && authHeader !== "COOKIE_SESSION") headers["Authorization"] = authHeader;
    const res = await safeFetch(`${domain}/libs/granite/csrf/token.json`, { method: "GET", headers });
    return res?.ok && res?.data?.token ? res.data.token : null;
  } catch (_) { return null; }
}

async function setupHeaderRules(domain) {
  try {
    const cleanDomain = (domain || "").trim().replace(/\/+$/, "");
    const ruleId = 1;
    const urlObj = new URL(cleanDomain);
    const targetHost = urlObj.hostname;

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Origin", operation: "set", value: cleanDomain },
              { header: "Referer", operation: "set", value: `${cleanDomain}/` }
            ]
          },
          condition: {
            requestDomains: [targetHost],
            resourceTypes: ["xmlhttprequest"]
          }
        }
      ]
    });
  } catch (err) {
    console.error("setupHeaderRules error:", err);
  }
}

// DUAL-IDENTITY OPERATOR PROBE
async function probeOperatorIdentity(domain, authHeader) {
  let chromeUserEmail = "Unauthenticated Chrome User";
  let aemUser = "Unknown AEM Session";
  let clientIp = "Unknown IP";

  try {
    const userInfo = await new Promise((resolve) => {
      chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, (info) => {
        resolve(info);
      });
    });
    if (userInfo && userInfo.email) {
      chromeUserEmail = userInfo.email;
    }
  } catch (_) {}

  try {
    const headers = { "Cache-Control": "no-cache" };
    if (authHeader && authHeader !== "COOKIE_SESSION") headers["Authorization"] = authHeader;
    const userRes = await safeFetch(`${domain}/libs/granite/security/currentuser.json`, { method: "GET", headers });
    if (userRes && userRes.ok && userRes.data) {
      aemUser = userRes.data.authorizableId || userRes.data.name || userRes.data.home || "AEM Authenticated User";
    }
  } catch (_) {}

  try {
    const ipRes = await fetch("https://api.ipify.org?format=json");
    if (ipRes.ok) {
      const ipData = await ipRes.json();
      if (ipData && ipData.ip) clientIp = ipData.ip;
    }
  } catch (_) {}

  return `Chrome User: ${chromeUserEmail} | AEM Session: ${aemUser} | IP: ${clientIp}`;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "TEST_SERVER_CONNECTION") {
    safeFetch(`${request.payload.domain}/libs/granite/csrf/token.json`, { method: "GET" }).then(res => {
      sendResponse({ connected: res.ok, status: res.status, statusText: res.statusText, error: res.error });
    });
    return true;
  }
  if (request.action === "FETCH_IMS_TOKEN_ON_DEMAND") {
    captureTokenForDomain(request.domain).then((token) => {
      sendResponse({ token: token });
    });
    return true;
  }
  if (request.action === "PROCESS_CF_UPSERT") {
    handleCFUpsert(request.payload).then(sendResponse);
    return true;
  }
  if (request.action === "UPDATE_PAGE_PROPERTIES") {
    handleUpdatePageProperties(request.payload).then(sendResponse);
    return true;
  }
  if (request.action === "MOVE_RENAME_ASSET") {
    handleMoveRenameAsset(request.payload).then(sendResponse);
    return true;
  }
  if (request.action === "RESOLVE_PACKAGE_PATHS_WITH_SIZE") {
    handleResolvePackagePathsWithSize(request.payload).then(sendResponse);
    return true;
  }
  if (request.action === "BUILD_AEM_PACKAGE") {
    handleBuildAemPackage(request.payload).then(sendResponse);
    return true;
  }
  if (request.action === "EXECUTE_REPLICATION") {
    handleReplication(request.payload).then(sendResponse);
    return true;
  }
  if (request.action === "EXTRACT_CF_DATA") {
    handleCFExtraction(request.payload).then(sendResponse);
    return true;
  }
  if (request.action === "LOG_TO_GOOGLE_SHEET") {
    handleGoogleSheetLogging(request.payload).then(sendResponse);
    return true;
  }
});

// REMOTE GOOGLE SHEET AUDIT LOGGING
async function handleGoogleSheetLogging({ moduleName, profileName, domain, authHeader, logText }) {
  if (!GOOGLE_LOG_SCRIPT_URL || GOOGLE_LOG_SCRIPT_URL.includes("YOUR_GOOGLE_APPS_SCRIPT")) {
    return { ok: false, error: "Google Script URL not configured" };
  }
  try {
    const operatorInfo = await probeOperatorIdentity(domain, authHeader);

    await fetch(GOOGLE_LOG_SCRIPT_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moduleName,
        operator: operatorInfo,
        profileName,
        domain,
        logText
      })
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// -----------------------------------------------------------------
// CONTENT FRAGMENT UPSERT
// -----------------------------------------------------------------
async function handleCFUpsert({ domain, rowData, authHeader }) {
  try {
    const cleanDomain = (domain || "").trim().replace(/\/+$/, "");
    await setupHeaderRules(cleanDomain);
    const csrfToken = await fetchCsrfToken(cleanDomain, authHeader);

    const cleanPath = normalizeAssetApiPath(rowData.path);
    const cfName = sanitizeJcrName(rowData.name);
    
    const rawVar = String(rowData.variation || "").trim().toLowerCase();
    const isMaster = !rawVar || rawVar === "master";

    const headers = { "Content-Type": "application/json" };
    if (authHeader && authHeader !== "COOKIE_SESSION") headers["Authorization"] = authHeader;
    if (csrfToken) headers["CSRF-Token"] = csrfToken;

    const baseUrl = `${cleanDomain}/api/assets${cleanPath}/${cfName}.json`;
    
    const basePayload = {
      properties: {
        title: rowData.title || rowData.name,
        "cq:model": rowData.model
      }
    };

    if (isMaster) {
      basePayload.properties.elements = rowData.elements;
    }

    const baseRes = await safeFetch(baseUrl, { 
      method: "PUT", 
      headers, 
      body: JSON.stringify(basePayload) 
    });

    if (!baseRes || !baseRes.ok) {
      return { ok: false, status: baseRes?.status || 500, error: `Base Fragment PUT failed (HTTP ${baseRes?.status || 500})` };
    }

    if (!isMaster) {
      const varUrl = `${cleanDomain}/api/assets${cleanPath}/${cfName}/elements.json`;
      const varPayload = {
        properties: {
          variation: rawVar,
          elements: rowData.elements
        }
      };

      const varRes = await safeFetch(varUrl, {
        method: "PUT",
        headers,
        body: JSON.stringify(varPayload)
      });

      return { ok: varRes.ok, status: varRes.status, error: varRes.error };
    }

    return { ok: baseRes.ok, status: baseRes.status, error: baseRes.error };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

// -----------------------------------------------------------------
// BULK PAGE PROPERTIES UPDATER (TARGETS /jcr:content)
// -----------------------------------------------------------------
async function handleUpdatePageProperties({ domain, path, properties, authHeader }) {
  try {
    const cleanDomain = (domain || "").trim().replace(/\/+$/, "");
    await setupHeaderRules(cleanDomain);
    const csrfToken = await fetchCsrfToken(cleanDomain, authHeader);

    let cleanPath = String(path || "").trim();
    if (!cleanPath.startsWith("/")) cleanPath = "/" + cleanPath;
    
    let jcrPath = cleanPath;
    if (!jcrPath.endsWith("/jcr:content") && !jcrPath.includes("/jcr:content/")) {
      jcrPath = jcrPath.replace(/\/+$/, "") + "/jcr:content";
    }

    const headers = { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" };
    if (authHeader && authHeader !== "COOKIE_SESSION") headers["Authorization"] = authHeader;
    if (csrfToken) {
      headers["CSRF-Token"] = csrfToken;
      headers["X-CSRF-Token"] = csrfToken;
    }

    const formData = new URLSearchParams();
    formData.append("_charset_", "utf-8");

    Object.keys(properties).forEach(propKey => {
      const val = properties[propKey];
      if (Array.isArray(val)) {
        val.forEach(item => formData.append(propKey, item));
      } else if (val !== undefined && val !== null) {
        formData.append(propKey, String(val));
      }
    });

    const postUrl = `${cleanDomain}${jcrPath}`;
    const res = await safeFetch(postUrl, {
      method: "POST",
      headers,
      body: formData.toString()
    });

    if (res && res.ok) {
      return { ok: true, status: res.status };
    } else {
      return { ok: false, status: res?.status || 500, error: `HTTP ${res?.status || 500} - Failed to update JCR page properties.` };
    }
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

// -----------------------------------------------------------------
// NON-BLOCKING FAST PARALLEL EXTRACTION (TRIPLE-PIPE DELIMITER)
// -----------------------------------------------------------------
async function handleCFExtraction({ domain, targetPath, authHeader }) {
  try {
    const cleanDomain = (domain || "").trim().replace(/\/+$/, "");
    await setupHeaderRules(cleanDomain);

    const headers = { "Cache-Control": "no-cache" };
    if (authHeader && authHeader !== "COOKIE_SESSION") headers["Authorization"] = authHeader;

    let cleanDamPath = targetPath.trim();
    if (!cleanDamPath.startsWith("/")) cleanDamPath = "/" + cleanDamPath;
    if (!cleanDamPath.startsWith("/content/dam")) cleanDamPath = "/content/dam" + cleanDamPath;

    const apiPath = `${cleanDomain}/api/assets${cleanDamPath.replace(/^\/content\/dam/, "")}.json?limit=100`;
    const res = await safeFetch(apiPath, { method: "GET", headers });

    if (!res || !res.ok || !res.data) {
      return { ok: false, error: `Failed to fetch from AEM Assets API (HTTP ${res?.status || 'Unknown'})` };
    }

    const itemsToProcess = [];

    // 1. Direct single CF asset
    if (res.data.class && res.data.class.includes("assets/asset")) {
      itemsToProcess.push(res.data);
    } 
    // 2. Folder containing entity assets
    else if (res.data.entities && Array.isArray(res.data.entities)) {
      const fetchPromises = res.data.entities
        .filter(e => e.class && e.class.includes("assets/asset") && e.properties?.path)
        .map(e => {
          const itemUrl = `${cleanDomain}/api/assets${e.properties.path.replace(/^\/content\/dam/, "")}.json`;
          return safeFetch(itemUrl, { method: "GET", headers });
        });

      const results = await Promise.all(fetchPromises);
      results.forEach(r => {
        if (r && r.ok && r.data) itemsToProcess.push(r.data);
      });
    }

    if (itemsToProcess.length === 0) {
      return { ok: false, error: `No Content Fragment assets found at '${targetPath}'.` };
    }

    // Helper: Safely unwrap AEM element values (Preserving Indentation/Formatting)
    const extractCleanValue = (elemObj, targetVariation = "master") => {
      if (!elemObj || typeof elemObj !== "object") return elemObj !== undefined ? String(elemObj) : "";

      let target = elemObj;
      if (targetVariation !== "master" && elemObj.variations && elemObj.variations[targetVariation]) {
        target = elemObj.variations[targetVariation];
      }

      let rawVal = target.value !== undefined ? target.value : (target.values !== undefined ? target.values : null);

      if (rawVal === null) return "";

      // Format multi-value arrays with triple-pipe delimiter
      if (Array.isArray(rawVal)) {
        return rawVal.map(v => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(" ||| ");
      }

      if (typeof rawVal === "object") {
        return JSON.stringify(rawVal);
      }

      return String(rawVal);
    };

    const extractedItems = [];
    let hasCustomVariations = false;

    for (const item of itemsToProcess) {
      const props = item.properties || {};
      const fullPath = props.path || "";
      const pathDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      const cfName = fullPath.substring(fullPath.lastIndexOf("/") + 1);
      const title = props.title || cfName;
      
      let model = props["cq:model"] || props.model || "";
      if (typeof model === "object") model = model.path || model.href || JSON.stringify(model);

      const elements = props.elements || {};

      const masterRow = {
        path: pathDir,
        name: cfName,
        title: title,
        model: model,
        variation: "master",
        elements: {}
      };

      Object.keys(elements).forEach(elemKey => {
        const elemObj = elements[elemKey];
        masterRow.elements[elemKey] = extractCleanValue(elemObj, "master");

        if (elemObj && elemObj.variations && typeof elemObj.variations === "object") {
          const varKeys = Object.keys(elemObj.variations);
          if (varKeys.length > 0) hasCustomVariations = true;
        }
      });

      extractedItems.push(masterRow);

      if (hasCustomVariations) {
        const variationNames = new Set();
        Object.keys(elements).forEach(elemKey => {
          if (elements[elemKey]?.variations) {
            Object.keys(elements[elemKey].variations).forEach(vk => variationNames.add(vk));
          }
        });

        variationNames.forEach(varName => {
          const varRow = {
            path: pathDir,
            name: cfName,
            title: title,
            model: model,
            variation: varName,
            elements: {}
          };

          Object.keys(elements).forEach(elemKey => {
            varRow.elements[elemKey] = extractCleanValue(elements[elemKey], varName);
          });

          extractedItems.push(varRow);
        });
      }
    }

    const flattenedRows = extractedItems.map(item => {
      const row = {
        path: item.path,
        name: item.name,
        title: item.title,
        model: item.model
      };

      if (hasCustomVariations) {
        row.variation = item.variation;
      }

      Object.assign(row, item.elements);
      return row;
    });

    return { ok: true, flattenedRows, hasCustomVariations };

  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleMoveRenameAsset({ domain, sourcePath, targetPath, authHeader }) {
  const sourceExt = getFileExtension(sourcePath), targetExt = getFileExtension(targetPath);
  if (sourceExt !== targetExt) return { ok: false, status: 400, error: `Extension mismatch (${sourceExt} vs ${targetExt})` };

  const csrfToken = await fetchCsrfToken(domain, authHeader);
  const fullSource = sourcePath.startsWith("/content/dam") ? sourcePath : `/content/dam${sourcePath}`;
  const fullTarget = targetPath.startsWith("/content/dam") ? targetPath : `/content/dam${targetPath}`;

  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (authHeader && authHeader !== "COOKIE_SESSION") headers["Authorization"] = authHeader;
  if (csrfToken) headers["CSRF-Token"] = csrfToken;

  const formData = new URLSearchParams();
  formData.append(":operation", "move");
  formData.append(":dest", fullTarget);

  const res = await safeFetch(`${domain}${fullSource}`, { method: "POST", headers, body: formData.toString() });
  return { ok: res.ok, status: res.status, error: res.error };
}

async function handleReplication({ domain, endpointUrl, path, cmd, authHeader, includeChildren }) {
  try {
    const cleanDomain = (domain || "").trim().replace(/\/+$/, "");
    await setupHeaderRules(cleanDomain);
    const csrfToken = await fetchCsrfToken(cleanDomain, authHeader);

    const payloadObj = {
      cmd: cmd,
      path: path,
      _charset_: "utf-8"
    };

    if (csrfToken) payloadObj[":cq_csrf_token"] = csrfToken;

    const payload = new URLSearchParams(payloadObj);
    const reqHeaders = { "Content-Type": "application/x-www-form-urlencoded" };

    if (authHeader && authHeader !== "COOKIE_SESSION") reqHeaders["Authorization"] = authHeader;
    if (csrfToken) {
      reqHeaders["CSRF-Token"] = csrfToken;
      reqHeaders["X-CSRF-Token"] = csrfToken;
    }

    const res = await safeFetch(endpointUrl, {
      method: "POST",
      headers: reqHeaders,
      body: payload.toString()
    });

    return { status: res.status, ok: res.ok, statusText: res.statusText, error: res.error };
  } catch (err) {
    return { status: 0, ok: false, error: err.message || "Replication Error" };
  }
}

async function handleResolvePackagePathsWithSize({ domain, rootPaths, excludeSubstrings, authHeader }) {
  try {
    const cleanDomain = (domain || "").trim().replace(/\/+$/, "");
    await setupHeaderRules(cleanDomain);

    const headers = { "Cache-Control": "no-cache" };
    if (authHeader && authHeader !== "COOKIE_SESSION") headers["Authorization"] = authHeader;

    const items = [];
    const missingPaths = [];
    let totalBytes = 0;

    for (const rootPath of rootPaths) {
      const checkUrl = `${cleanDomain}${rootPath}.json`;
      const checkRes = await safeFetch(checkUrl, { method: "GET", headers });

      if (!checkRes || (!checkRes.ok && checkRes.status === 404)) {
        missingPaths.push(rootPath);
        continue;
      }

      const qUrl = `${cleanDomain}/bin/querybuilder.json?path=${encodeURIComponent(rootPath)}&type=dam:Asset&p.limit=-1&p.hits=full&p.nothits=true`;
      const qRes = await safeFetch(qUrl, { method: "GET", headers });

      if (qRes && qRes.ok && qRes.data && Array.isArray(qRes.data.hits) && qRes.data.hits.length > 0) {
        for (const hit of qRes.data.hits) {
          const path = hit.path || hit["jcr:path"];
          if (path && !excludeSubstrings.some(ex => path.includes(ex))) {
            let size = 0;

            if (hit["jcr:content"]?.["metadata"]?.["dam:size"]) {
              size = parseInt(hit["jcr:content"]["metadata"]["dam:size"], 10) || 0;
            } 
            if (size === 0 && hit["jcr:content"]?.["renditions"]?.["original"]?.["jcr:content"]?.["jcr:data"]) {
              size = parseInt(hit["jcr:content"]["renditions"]["original"]["jcr:content"]["jcr:data"], 10) || 0;
            }

            if (size === 0) {
              try {
                const assetJsonUrl = `${cleanDomain}${path}/_jcr_content/renditions/original.2.json`;
                const assetRes = await safeFetch(assetJsonUrl, { method: "GET", headers });
                if (assetRes && assetRes.ok && assetRes.data) {
                  size = parseInt(assetRes.data["jcr:content"]?.["jcr:data"] || 0, 10) || 0;
                }
              } catch (_) {}
            }

            items.push({ path, sizeBytes: size });
            totalBytes += size;
          }
        }
      } else {
        if (!excludeSubstrings.some(ex => rootPath.includes(ex))) {
          items.push({ path: rootPath, sizeBytes: 250 * 1024 });
          totalBytes += 250 * 1024;
        }
      }
    }

    return { ok: true, items, missingPaths, totalBytes };
  } catch (err) {
    return { ok: false, items: rootPaths.map(p => ({ path: p, sizeBytes: 250 * 1024 })), missingPaths: [], totalBytes: rootPaths.length * 250 * 1024, error: err.message };
  }
}

async function handleBuildAemPackage({ domain, groupName, packageName, paths, shouldDownload, shouldDelete, authHeader }) {
  try {
    const cleanDomain = (domain || "").trim().replace(/\/+$/, "");
    await setupHeaderRules(cleanDomain);
    const csrfToken = await fetchCsrfToken(cleanDomain, authHeader);

    const baseHeaders = { "Cache-Control": "no-cache" };
    if (authHeader && authHeader !== "COOKIE_SESSION") baseHeaders["Authorization"] = authHeader;
    if (csrfToken) {
      baseHeaders["CSRF-Token"] = csrfToken;
      baseHeaders["X-CSRF-Token"] = csrfToken;
    }

    const createHeaders = { 
      ...baseHeaders, 
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" 
    };

    const forceDeleteUrl = `${cleanDomain}/crx/packmgr/service/.json/etc/packages/${encodeURIComponent(groupName)}/${encodeURIComponent(packageName)}.zip?cmd=delete`;
    await safeFetch(forceDeleteUrl, { method: "POST", headers: createHeaders });

    const cleanedPaths = paths.map(p => {
      let trimmed = String(p || "").trim();
      if (trimmed.length > 1 && trimmed.endsWith("/")) {
        trimmed = trimmed.substring(0, trimmed.length - 1);
      }
      return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    }).filter(Boolean);

    const createUrl = `${cleanDomain}/crx/packmgr/service/.json/etc/packages/${encodeURIComponent(groupName)}/${encodeURIComponent(packageName)}?cmd=create`;
    const createFormData = new URLSearchParams();
    createFormData.append("packageName", packageName);
    createFormData.append("groupName", groupName);
    createFormData.append("charset", "utf-8");

    const createRes = await safeFetch(createUrl, { 
      method: "POST", 
      headers: createHeaders, 
      body: createFormData.toString() 
    });

    if (createRes.status === 401 || createRes.status === 403) {
      return { 
        ok: false, 
        status: createRes.status, 
        error: "NO PERMISSION: User lacks Package Manager access on this AEM instance." 
      };
    }

    const filterArray = cleanedPaths.map(p => ({ root: p, rules: [] }));
    const filterJsonString = JSON.stringify(filterArray);

    const multipartBoundary = `----WebKitFormBoundaryAEM${Date.now()}`;
    const multipartHeaders = {
      ...baseHeaders,
      "Content-Type": `multipart/form-data; boundary=${multipartBoundary}`
    };

    let multipartBody = "";
    multipartBody += `--${multipartBoundary}\r\n`;
    multipartBody += `Content-Disposition: form-data; name="path"\r\n\r\n/etc/packages/${groupName}/${packageName}.zip\r\n`;
    multipartBody += `--${multipartBoundary}\r\n`;
    multipartBody += `Content-Disposition: form-data; name="packageName"\r\n\r\n${packageName}\r\n`;
    multipartBody += `--${multipartBoundary}\r\n`;
    multipartBody += `Content-Disposition: form-data; name="groupName"\r\n\r\n${groupName}\r\n`;
    multipartBody += `--${multipartBoundary}\r\n`;
    multipartBody += `Content-Disposition: form-data; name="filter"\r\n\r\n${filterJsonString}\r\n`;
    multipartBody += `--${multipartBoundary}\r\n`;
    multipartBody += `Content-Disposition: form-data; name="_charset_"\r\n\r\nutf-8\r\n`;
    multipartBody += `--${multipartBoundary}--\r\n`;

    const updateUrl = `${cleanDomain}/crx/packmgr/update.jsp`;
    await safeFetch(updateUrl, { 
      method: "POST", 
      headers: multipartHeaders, 
      body: multipartBody 
    });

    const buildUrl = `${cleanDomain}/crx/packmgr/service/.json/etc/packages/${encodeURIComponent(groupName)}/${encodeURIComponent(packageName)}.zip?cmd=build`;
    const buildRes = await safeFetch(buildUrl, { 
      method: "POST", 
      headers: createHeaders 
    });

    if (!buildRes || !buildRes.ok) {
      return { 
        ok: false, 
        status: buildRes?.status || 500, 
        error: `Failed to execute package build command (HTTP ${buildRes?.status || 500}).` 
      };
    }

    const pkgDownloadUrl = `${cleanDomain}/etc/packages/${encodeURIComponent(groupName)}/${encodeURIComponent(packageName)}.zip`;
    let isDownloaded = false;
    let isDeleted = false;

    if (shouldDownload) {
      try {
        await chrome.downloads.download({
          url: pkgDownloadUrl,
          filename: `${packageName}.zip`,
          saveAs: false
        });
        isDownloaded = true;
      } catch (dlErr) {
        console.error("Package download error:", dlErr);
      }
    }

    if (shouldDelete) {
      const deleteUrl = `${cleanDomain}/crx/packmgr/service/.json/etc/packages/${encodeURIComponent(groupName)}/${encodeURIComponent(packageName)}.zip?cmd=delete`;
      const delRes = await safeFetch(deleteUrl, { method: "POST", headers: createHeaders });
      if (delRes && delRes.ok) {
        isDeleted = true;
      }
    }

    return { 
      ok: true, 
      status: 200, 
      downloadUrl: pkgDownloadUrl, 
      downloaded: isDownloaded, 
      deleted: isDeleted 
    };

  } catch (err) {
    return { ok: false, status: 0, error: err.message || "Network Error" };
  }
}