document.addEventListener("DOMContentLoaded", () => {
  const selCFOperation = document.getElementById("selCFOperation");
  const sectionCFImport = document.getElementById("sectionCFImport");
  const sectionCFExport = document.getElementById("sectionCFExport");
  const fileCFData = document.getElementById("fileCFData");
  const txtExtractPath = document.getElementById("txtExtractPath");
  const numCFDelay = document.getElementById("numCFDelay");
  const btnRunCF = document.getElementById("btnRunCF");

  selCFOperation.addEventListener("change", () => {
    if (selCFOperation.value === "IMPORT") {
      sectionCFImport.style.display = "block";
      sectionCFExport.style.display = "none";
    } else {
      sectionCFImport.style.display = "none";
      sectionCFExport.style.display = "block";
    }
  });

  // INTERNAL CSV PARSER
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

    const headers = parseLine(lines[0]).map(h => h.toLowerCase());
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

  // INTERNAL CSV GENERATOR
  function downloadCSV(dataArray, filename) {
    if (!dataArray || dataArray.length === 0) return;

    const headers = [];
    dataArray.forEach(obj => {
      Object.keys(obj).forEach(key => {
        if (!headers.includes(key)) headers.push(key);
      });
    });

    const escapeCSV = (val) => {
      if (val === null || val === undefined) return '""';
      let str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    let csvContent = headers.map(escapeCSV).join(",") + "\r\n";

    dataArray.forEach(row => {
      const line = headers.map(h => escapeCSV(row[h] !== undefined ? row[h] : ""));
      csvContent += line.join(",") + "\r\n";
    });

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  btnRunCF.addEventListener("click", async () => {
    const profile = window.AEMApp.getSelectedProfile();
    if (!profile) return alert("Select a valid profile first.");

    btnRunCF.disabled = true;
    const authHeader = await window.AEMApp.getAuthHeader(profile);
    if (!authHeader) {
      btnRunCF.disabled = false;
      return;
    }

    const connected = await window.AEMApp.verifyConnectivity(profile, authHeader);
    if (!connected) {
      btnRunCF.disabled = false;
      return;
    }

    const delay = parseFloat(numCFDelay.value) || 0;

    // --- IMPORT / UPSERT OPERATION ---
    if (selCFOperation.value === "IMPORT") {
      const file = fileCFData.files[0];
      if (!file) {
        alert("Upload a CSV file.");
        btnRunCF.disabled = false;
        return;
      }

      const reader = new FileReader();
      reader.onload = async (e) => {
        const text = e.target.result;
        const rows = parseCSVText(text);

        const items = rows.map(r => {
          const path = String(r.path || "").trim();
          const name = String(r.name || "").trim();
          const title = String(r.title || "").trim();
          const model = String(r.model || "").trim();
          const variation = String(r.variation || "").trim().toLowerCase();

          const elements = {};
          Object.keys(r).forEach(k => {
            if (!["path", "name", "title", "model", "variation"].includes(k.toLowerCase())) {
              elements[k] = r[k];
            }
          });

          return { path, name, title, model, variation, elements };
        }).filter(item => item.path && item.name);

        if (items.length === 0) {
          alert("No valid rows found in file. Ensure 'path' and 'name' columns exist.");
          btnRunCF.disabled = false;
          return;
        }

        window.AEMApp.log(`--- INITIATING CONTENT FRAGMENT UPSERT BATCH ---`);
        window.AEMApp.log(`Total Fragment Rows to Process: ${items.length}`);

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < items.length; i++) {
          const rowData = items[i];
          window.AEMApp.setProgress(((i + 1) / items.length) * 100);

          const varLabel = rowData.variation ? `'${rowData.variation}'` : 'master (default)';
          window.AEMApp.log(`[${i + 1}/${items.length}] Upserting CF: ${rowData.path}/${rowData.name} [Target Variation: ${varLabel}]`);

          const res = await new Promise(r => chrome.runtime.sendMessage({
            action: "PROCESS_CF_UPSERT",
            payload: {
              domain: profile.domain,
              rowData,
              authHeader
            }
          }, r));

          if (res && res.ok) {
            successCount++;
            window.AEMApp.log(`  ✓ SUCCESS: Content Fragment updated.`);
          } else {
            failCount++;
            window.AEMApp.log(`  ❌ FAILED: ${res?.error || 'Upsert Error'}`);
          }

          if (delay > 0 && i < items.length - 1) {
            await new Promise(r => setTimeout(r, delay * 1000));
          }
        }

        window.AEMApp.log(`\nCF Import Complete: ${successCount} Succeeded, ${failCount} Failed.`);
        window.AEMApp.sendLogToGoogleSheet("CF Manager", window.AEMApp.getConsoleLogs());
        btnRunCF.disabled = false;
      };

      reader.readAsText(file, "utf-8");
    } 
    // --- EXPORT OPERATION ---
    else {
      const targetPath = txtExtractPath.value.trim();
      if (!targetPath) {
        alert("Enter a DAM path to extract.");
        btnRunCF.disabled = false;
        return;
      }

      window.AEMApp.log(`--- EXTRACTING CONTENT FRAGMENTS FROM ${targetPath} ---`);
      window.AEMApp.log(`🔍 Querying AEM Assets REST API...`);

      const res = await new Promise(r => chrome.runtime.sendMessage({
        action: "EXTRACT_CF_DATA",
        payload: {
          domain: profile.domain,
          targetPath,
          authHeader
        }
      }, r));

      if (res && res.ok && Array.isArray(res.flattenedRows) && res.flattenedRows.length > 0) {
        window.AEMApp.log(`  ✓ SUCCESS: Extracted ${res.flattenedRows.length} total fragment row(s).`);
        if (res.hasCustomVariations) {
          window.AEMApp.log(`  ℹ️ Custom variations detected — included 'variation' column.`);
        } else {
          window.AEMApp.log(`  ℹ️ No custom variations detected — omitted 'variation' column.`);
        }
        
        try {
          downloadCSV(res.flattenedRows, `cf-export-${Date.now()}.csv`);
          window.AEMApp.log(`  ⬇️ CSV Download triggered successfully.`);
        } catch (fileErr) {
          window.AEMApp.log(`  ❌ FILE GENERATION ERROR: ${fileErr.message}`);
        }

      } else {
        window.AEMApp.log(`  ❌ EXPORT FAILED: ${res?.error || 'No Content Fragments found at specified path.'}`);
      }

      window.AEMApp.sendLogToGoogleSheet("CF Manager", window.AEMApp.getConsoleLogs());
      btnRunCF.disabled = false;
    }
  });
});