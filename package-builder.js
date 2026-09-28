document.addEventListener("DOMContentLoaded", () => {
  const txtPkgGroupName = document.getElementById("txtPkgGroupName");
  const txtPkgName = document.getElementById("txtPkgName");
  const txtPkgIncludePaths = document.getElementById("txtPkgIncludePaths");
  const txtPkgExcludePaths = document.getElementById("txtPkgExcludePaths");
  
  const chkEnableSplit = document.getElementById("chkEnableSplit");
  const numPkgMaxMbLimit = document.getElementById("numPkgMaxMbLimit");
  const groupMaxMb = document.getElementById("groupMaxMb");
  
  const chkDownloadPkg = document.getElementById("chkDownloadPkg");
  const chkDeletePkgAfterDownload = document.getElementById("chkDeletePkgAfterDownload");
  const btnRunPackage = document.getElementById("btnRunPackage");

  chkEnableSplit.addEventListener("change", () => {
    numPkgMaxMbLimit.disabled = !chkEnableSplit.checked;
    groupMaxMb.style.opacity = chkEnableSplit.checked ? "1" : "0.5";
  });

  btnRunPackage.addEventListener("click", async () => {
    const profile = window.AEMApp.getSelectedProfile();
    if (!profile) return alert("Select a valid profile first.");

    const groupName = txtPkgGroupName.value.trim() || "my-bulk-exports";
    const pkgBaseName = txtPkgName.value.trim() || "aem-assets-package";
    const rawIncludes = txtPkgIncludePaths.value.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
    const rawExcludes = txtPkgExcludePaths.value.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
    const isSplitEnabled = chkEnableSplit.checked;
    const maxMbPerPkg = parseFloat(numPkgMaxMbLimit.value) || 2;

    if (rawIncludes.length === 0) return alert("Enter at least one path to build.");

    btnRunPackage.disabled = true;
    const authHeader = await window.AEMApp.getAuthHeader(profile);
    if (!authHeader) {
      btnRunPackage.disabled = false;
      return;
    }

    const connected = await window.AEMApp.verifyConnectivity(profile, authHeader);
    if (!connected) {
      btnRunPackage.disabled = false;
      return;
    }

    const filteredRoots = rawIncludes.filter(p => !rawExcludes.some(ex => p.includes(ex)));

    if (!isSplitEnabled) {
      window.AEMApp.log(`--- INITIATING SINGLE AEM PACKAGE BUILD (NO SPLIT) ---`);
      window.AEMApp.log(`📦 Verifying JCR paths and building package '${pkgBaseName}'...`);

      // Verify path existence even when splitting is disabled
      const resolvedRes = await new Promise(r => chrome.runtime.sendMessage({
        action: "RESOLVE_PACKAGE_PATHS_WITH_SIZE",
        payload: {
          domain: profile.domain,
          rootPaths: filteredRoots,
          excludeSubstrings: rawExcludes,
          authHeader
        }
      }, r));

      if (resolvedRes && resolvedRes.missingPaths && resolvedRes.missingPaths.length > 0) {
        window.AEMApp.log(`\n⚠️ WARNING: Found ${resolvedRes.missingPaths.length} NON-EXISTENT path(s) in AEM JCR:`);
        resolvedRes.missingPaths.forEach(p => {
          window.AEMApp.log(`  ❌ PATH NOT FOUND (404): ${p}`);
        });
      }

      const validPathsToBuild = filteredRoots.filter(p => !resolvedRes?.missingPaths?.includes(p));

      if (validPathsToBuild.length === 0) {
        window.AEMApp.log(`\n❌ ABORTED: None of the supplied include paths exist in AEM JCR.`);
        window.AEMApp.sendLogToGoogleSheet("Package Builder", window.AEMApp.getConsoleLogs());
        btnRunPackage.disabled = false;
        return;
      }

      const res = await new Promise(r => chrome.runtime.sendMessage({
        action: "BUILD_AEM_PACKAGE",
        payload: {
          domain: profile.domain,
          groupName,
          packageName: pkgBaseName,
          paths: validPathsToBuild,
          shouldDownload: chkDownloadPkg.checked,
          shouldDelete: chkDeletePkgAfterDownload.checked,
          authHeader
        }
      }, r));

      if (res && res.ok) {
        window.AEMApp.log(`  ✓ SUCCESS: Package '${pkgBaseName}' built successfully!`);
        if (res.downloaded) window.AEMApp.log(`  ⬇️ Download Triggered: ${res.downloadUrl}`);
        if (res.deleted) window.AEMApp.log(`  🗑️ Deleted node from AEM JCR storage.`);
      } else {
        window.AEMApp.log(`  ❌ BUILD FAILED: ${res?.error || 'Build Error'}`);
      }

      window.AEMApp.sendLogToGoogleSheet("Package Builder", window.AEMApp.getConsoleLogs());
      btnRunPackage.disabled = false;
      return;
    }

    // SPLIT ENABLED BY SIZE LIMIT
    window.AEMApp.log(`--- INITIATING FILE-SIZE LIMITED AEM PACKAGE BUILD ---`);
    window.AEMApp.log(`Target Limit: ${maxMbPerPkg} MB per package zip`);
    window.AEMApp.log(`🔍 [PHASE 1/2] Crawling and verifying JCR paths & file sizes...`);

    const resolvedRes = await new Promise(r => chrome.runtime.sendMessage({
      action: "RESOLVE_PACKAGE_PATHS_WITH_SIZE",
      payload: {
        domain: profile.domain,
        rootPaths: filteredRoots,
        excludeSubstrings: rawExcludes,
        authHeader
      }
    }, r));

    if (resolvedRes && resolvedRes.missingPaths && resolvedRes.missingPaths.length > 0) {
      window.AEMApp.log(`\n⚠️ WARNING: Found ${resolvedRes.missingPaths.length} NON-EXISTENT path(s) in AEM JCR:`);
      resolvedRes.missingPaths.forEach(p => {
        window.AEMApp.log(`  ❌ PATH NOT FOUND (404): ${p}`);
      });
    }

    let assetItems = [];
    if (resolvedRes && resolvedRes.ok && resolvedRes.items && resolvedRes.items.length > 0) {
      assetItems = resolvedRes.items;
      const totalMb = (resolvedRes.totalBytes / (1024 * 1024)).toFixed(2);
      window.AEMApp.log(`  ✓ Discovered ${assetItems.length} valid asset(s) totaling ~${totalMb} MB.`);
    } else {
      window.AEMApp.log(`  ℹ️ Discovered 0 detailed size nodes.`);
    }

    if (assetItems.length === 0) {
      window.AEMApp.log(`\n❌ ABORTED: No valid existing paths remain to build.`);
      window.AEMApp.sendLogToGoogleSheet("Package Builder", window.AEMApp.getConsoleLogs());
      btnRunPackage.disabled = false;
      return;
    }

    const effectiveMaxBytes = maxMbPerPkg * 1024 * 1024 * 0.75;
    const chunks = [];
    let currentPaths = [];
    let currentBytes = 0;

    for (let i = 0; i < assetItems.length; i++) {
      const item = assetItems[i];
      const itemSize = item.sizeBytes || (250 * 1024);

      if (itemSize > effectiveMaxBytes) {
        if (currentPaths.length > 0) {
          chunks.push([...currentPaths]);
          currentPaths = [];
          currentBytes = 0;
        }
        window.AEMApp.log(`  ⚠️ Note: Asset '${item.path}' (~${(itemSize / (1024 * 1024)).toFixed(2)} MB) individually exceeds or nears limit. Isolating into standalone package.`);
        chunks.push([item.path]);
        continue;
      }

      if (currentPaths.length > 0 && (currentBytes + itemSize > effectiveMaxBytes)) {
        chunks.push([...currentPaths]);
        currentPaths = [item.path];
        currentBytes = itemSize;
      } else {
        currentPaths.push(item.path);
        currentBytes += itemSize;
      }
    }

    if (currentPaths.length > 0) {
      chunks.push([...currentPaths]);
    }

    const totalPackages = chunks.length;
    window.AEMApp.log(`\n📦 [PHASE 2/2] Partitioned into ${totalPackages} zip package(s)...`);

    for (let idx = 0; idx < totalPackages; idx++) {
      const chunkPaths = Array.from(chunks[idx]);
      const pkgName = totalPackages === 1 ? pkgBaseName : `${pkgBaseName}-part${idx + 1}`;
      window.AEMApp.setProgress(((idx + 1) / totalPackages) * 100);

      window.AEMApp.log(`\n📦 [Package ${idx + 1}/${totalPackages}] Building '${pkgName}' (${chunkPaths.length} filter rules)...`);

      const res = await new Promise(r => chrome.runtime.sendMessage({
        action: "BUILD_AEM_PACKAGE",
        payload: {
          domain: profile.domain,
          groupName,
          packageName: pkgName,
          paths: chunkPaths,
          shouldDownload: chkDownloadPkg.checked,
          shouldDelete: chkDeletePkgAfterDownload.checked,
          authHeader
        }
      }, r));

      if (res && res.ok) {
        window.AEMApp.log(`  ✓ SUCCESS: Package '${pkgName}' created and built!`);
        if (res.downloaded) window.AEMApp.log(`  ⬇️ Download Triggered: ${res.downloadUrl}`);
        if (res.deleted) window.AEMApp.log(`  🗑️ Cleaned JCR package node from AEM storage.`);
      } else {
        window.AEMApp.log(`  ❌ BUILD FAILED for '${pkgName}': ${res?.error || 'Build Error'}`);
      }

      if (idx < totalPackages - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    window.AEMApp.log(`\n--- ALL ${totalPackages} PACKAGE BUILDS COMPLETE ---`);
    
    // Dispatch Execution Log directly to Google Sheet
    window.AEMApp.sendLogToGoogleSheet("Package Builder", window.AEMApp.getConsoleLogs());

    btnRunPackage.disabled = false;
  });
});