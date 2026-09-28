document.addEventListener("DOMContentLoaded", () => {
  const filePagePropsData = document.getElementById("filePagePropsData");
  const numPagePropsDelay = document.getElementById("numPagePropsDelay");
  const btnRunPageProps = document.getElementById("btnRunPageProps");

  function parseCSVText(csvText) {
    const lines = csvText.split(/\r?\n/).filter(line => line.trim() !== "");
    if (lines.length === 0) return [];

    const parseLine = (line) => {
      const result = [];
      let current = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"' && (i === 0 || line[i - 1] !== '\\')) {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          result.push(current.trim().replace(/^"|"$/g, ''));
          current = "";
        } else {
          current += char;
        }
      }
      result.push(current.trim().replace(/^"|"$/g, ''));
      return result;
    };

    const headers = parseLine(lines[0]);
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const values = parseLine(lines[i]);
      if (values.length === 0 || !values[0]) continue;
      const rowObj = {};
      headers.forEach((h, idx) => {
        rowObj[h] = values[idx] || "";
      });
      rows.push(rowObj);
    }
    return rows;
  }

  btnRunPageProps.addEventListener("click", async () => {
    const profile = window.AEMApp.getSelectedProfile();
    if (!profile) return alert("Select a valid profile first.");

    const file = filePagePropsData.files[0];
    if (!file) return alert("Upload a CSV file containing page paths and properties.");

    btnRunPageProps.disabled = true;
    const authHeader = await window.AEMApp.getAuthHeader(profile);
    if (!authHeader) {
      btnRunPageProps.disabled = false;
      return;
    }

    const connected = await window.AEMApp.verifyConnectivity(profile, authHeader);
    if (!connected) {
      btnRunPageProps.disabled = false;
      return;
    }

    const delay = parseFloat(numPagePropsDelay.value) || 0;

    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target.result;
      const rows = parseCSVText(text);

      const items = rows.map(r => {
        let pagePath = "";
        const properties = {};

        Object.keys(r).forEach(k => {
          if (k.toLowerCase() === "path") {
            pagePath = String(r[k]).trim();
          } else {
            let val = r[k];
            // Split multi-value fields if " ||| " is detected
            if (typeof val === "string" && val.includes(" ||| ")) {
              val = val.split(" ||| ").map(s => s.trim());
            }
            properties[k] = val;
          }
        });

        return { path: pagePath, properties };
      }).filter(item => item.path);

      if (items.length === 0) {
        alert("No valid rows found. Ensure Column A header is named 'path'.");
        btnRunPageProps.disabled = false;
        return;
      }

      window.AEMApp.log(`--- INITIATING BULK PAGE PROPERTIES UPDATE ---`);
      window.AEMApp.log(`Total Pages to Process: ${items.length}`);

      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        window.AEMApp.setProgress(((i + 1) / items.length) * 100);

        window.AEMApp.log(`[${i + 1}/${items.length}] Updating Page: ${item.path}`);

        const res = await new Promise(r => chrome.runtime.sendMessage({
          action: "UPDATE_PAGE_PROPERTIES",
          payload: {
            domain: profile.domain,
            path: item.path,
            properties: item.properties,
            authHeader
          }
        }, r));

        if (res && res.ok) {
          successCount++;
          window.AEMApp.log(`  ✓ SUCCESS: Page properties saved.`);
        } else {
          failCount++;
          window.AEMApp.log(`  ❌ FAILED: ${res?.error || 'Update Error'}`);
        }

        if (delay > 0 && i < items.length - 1) {
          await new Promise(r => setTimeout(r, delay * 1000));
        }
      }

      window.AEMApp.log(`\nPage Properties Update Complete: ${successCount} Succeeded, ${failCount} Failed.`);
      window.AEMApp.sendLogToGoogleSheet("Page Properties Manager", window.AEMApp.getConsoleLogs());
      btnRunPageProps.disabled = false;
    };

    reader.readAsText(file, "utf-8");
  });
});