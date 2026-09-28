document.addEventListener("DOMContentLoaded", () => {
  const selAction = document.getElementById("selAction");
  const txtPaths = document.getElementById("txtPaths");
  const filePublishData = document.getElementById("filePublishData");
  const chkIncludeChildren = document.getElementById("chkIncludeChildren");
  const chkEnableExclude = document.getElementById("chkEnableExclude");
  const txtExclude = document.getElementById("txtExclude");
  const numPublishDelay = document.getElementById("numPublishDelay");
  const btnRunPublish = document.getElementById("btnRunPublish");

  chkEnableExclude.addEventListener("change", () => {
    txtExclude.disabled = !chkEnableExclude.checked;
    txtExclude.style.opacity = chkEnableExclude.checked ? "1" : "0.4";
  });

  btnRunPublish.addEventListener("click", async () => {
    const profile = window.AEMApp.getSelectedProfile();
    if (!profile) return alert("Select a valid profile first.");

    let targetPaths = txtPaths.value.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
    const exclusions = txtExclude.value.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
    const file = filePublishData.files[0];

    btnRunPublish.disabled = true;
    const authHeader = await window.AEMApp.getAuthHeader(profile);
    if (!authHeader) {
      btnRunPublish.disabled = false;
      return;
    }

    const connected = await window.AEMApp.verifyConnectivity(profile, authHeader);
    if (!connected) {
      btnRunPublish.disabled = false;
      return;
    }

    const selectedAction = selAction.value;
    const delay = parseFloat(numPublishDelay.value) || 0;
    const includeChildren = chkIncludeChildren.checked;
    const isExclusionEnabled = chkEnableExclude.checked;

    const executeReplicationBatch = async (paths) => {
      if (!paths || paths.length === 0) {
        alert("Enter or upload at least one valid path.");
        btnRunPublish.disabled = false;
        return;
      }

      const endpointUrl = includeChildren
        ? `${profile.domain}/etc/replication/treeactivation.html`
        : `${profile.domain}/bin/replicate`;

      const cmdValue = includeChildren ? selectedAction.toLowerCase() : selectedAction;

      window.AEMApp.log(`--- STARTING BATCH REPLICATION [${selectedAction.toUpperCase()}] ---`);
      window.AEMApp.log(`Target: ${profile.domain} | Endpoint: ${includeChildren ? 'Tree Activation' : 'Single Node'}`);
      window.AEMApp.log(`Total Target Paths: ${paths.length}`);

      let successCount = 0;
      let skippedCount = 0;
      let failCount = 0;

      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        window.AEMApp.setProgress(((i + 1) / paths.length) * 100);

        if (isExclusionEnabled && exclusions.length > 0) {
          if (exclusions.some(ex => path.includes(ex))) {
            skippedCount++;
            window.AEMApp.log(`SKIPPED [${i + 1}/${paths.length}]: ${path} (Exclusion Rule Match)`);
            continue;
          }
        }

        window.AEMApp.log(`[${i + 1}/${paths.length}] Replicating: ${path}`);

        const res = await new Promise(r => chrome.runtime.sendMessage({
          action: "EXECUTE_REPLICATION",
          payload: {
            domain: profile.domain,
            endpointUrl: endpointUrl,
            path: path,
            cmd: cmdValue,
            authHeader: authHeader,
            includeChildren: includeChildren
          }
        }, r));

        if (res && res.ok) {
          successCount++;
          window.AEMApp.log(`  ✓ SUCCESS: ${selectedAction} executed [HTTP ${res.status}]`);
        } else {
          failCount++;
          window.AEMApp.log(`  ❌ FAILED: ${path} - ${res?.error || `HTTP ${res?.status || 0}`}`);
        }

        if (delay > 0 && i < paths.length - 1) {
          await new Promise(r => setTimeout(r, delay * 1000));
        }
      }

      window.AEMApp.log(`\nReplication Complete: ${successCount} Succeeded, ${skippedCount} Skipped, ${failCount} Failed.`);
      
      // Dispatch Execution Log directly to Google Sheet
      window.AEMApp.sendLogToGoogleSheet("Publisher", window.AEMApp.getConsoleLogs());
      
      btnRunPublish.disabled = false;
    };

    if (file) {
      const reader = new FileReader();
      const isExcel = file.name.endsWith(".xlsx") || file.name.endsWith(".xls");

      if (isExcel) {
        reader.onload = async (e) => {
          const data = new Uint8Array(e.target.result);
          const wb = XLSX.read(data, { type: "array" });
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
          const parsed = rows.map(r => String(r[0] || "").trim()).filter(p => p.startsWith("/"));
          await executeReplicationBatch(parsed);
        };
        reader.readAsArrayBuffer(file);
      } else {
        reader.onload = async (e) => {
          const lines = e.target.result.split(/\r?\n/);
          const parsed = lines.map(l => l.split(",")[0].replace(/^"|"$/g, "").trim()).filter(p => p.startsWith("/"));
          await executeReplicationBatch(parsed);
        };
        reader.readAsText(file, "utf-8");
      }
    } else {
      await executeReplicationBatch(targetPaths);
    }
  });
});