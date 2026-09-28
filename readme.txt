================================================================================
                       AEM BULK TOOLS CHROME EXTENSION                       
            Technical Architecture & API Documentation (Manifest V3)
                                  -musickel
================================================================================

1. SYSTEM OVERVIEW & CORE PRINCIPLES
--------------------------------------------------------------------------------
AEM Bulk Tools is an enterprise Chrome Extension (Manifest V3) designed to
perform high-throughput administrative, content management, and deployment
operations on Adobe Experience Manager (AEM) author and publish instances.

The extension operates as a local control plane inside the browser. It directly
invokes AEM's JCR REST endpoints, CRX Package Manager APIs, QueryBuilder
servlets, and Assets REST APIs.

Core Architectural Principles:
* Zero-Dependency Native Processing: Operates without external JavaScript
  runtime dependencies. CSV parsing, string escaping, stream unwrapping,
  and file blob generation are implemented in native ES6+ utilities.
* Non-Blocking Parallel Processing: Heavy extraction operations utilize
  Promise.all concurrency limits to prevent UI lockups and Service Worker thread
  termination.
* Dual-Context Network Execution: Employs direct background fetch with an
  automated fallback to tab-injected execution (fetchInActiveTab) when
  cross-origin session cookies or CORS restrictions block direct extension
  network requests.
* Granular Data Preservation: Respects multi-line strings, tab indentations,
  HTML formatting, and single-pipe characters in rich text by enforcing strict
  CSV quoting rules and a multi-character delimiter (" ||| ").


2. DIRECTORY STRUCTURE & SCRIPT RESPONSIBILITIES
--------------------------------------------------------------------------------
aem-bulk-tools/
├── manifest.json            # Extension manifests, permissions & rules
├── popup.html               # Multi-tab layout container & console
├── common.css               # Spectrum-inspired design tokens & grid
├── popup.js                 # Global app state, routing, theme & logs
├── cf-manager.js            # Content Fragment import/export module
├── page-properties.js       # Bulk JCR page property update module
├── asset-mover.js           # Asset move, rename, and path validation
├── package-builder.js       # CRX package creation & ZIP splitting
├── publisher.js             # Bulk replication (Activate/Deactivate)
└── background.js            # Service Worker proxy, headers & REST handlers

Script Responsibilities:

* manifest.json:
  Defines Chrome extension permissions (declarativeNetRequest, scripting,
  identity, storage, downloads), registers background.js as a Service Worker,
  and sets up host permissions for cross-domain AEM communication.

* popup.html:
  Serves as the primary DOM interface. Contains UI controls for environment
  profile selection, operation mode switching, tab navigation (nav-tabs), file
  inputs, batch delay settings, and a shared real-time console log interface.

* common.css:
  Contains Adobe Spectrum-aligned styling variables (Terracotta Bronze & Gold
  theme), responsive flexbox/grid containers, input states, theme sliders,
  progress bars, and full-tab mode presentation overrides (.full-tab-mode).

* popup.js:
  Manages the AEMApp global window object. Controls account profile
  persistence in chrome.storage.local, credential decryption, tab switching
  logic, connectivity verification (TEST_SERVER_CONNECTION), remote Google Sheet
  logging invocation, and console log exports.

* cf-manager.js:
  Handles DOM events for the Content Fragment Manager tab. Includes a native
  CSV parser (parseCSVText) and native CSV downloader (downloadCSV). Converts
  uploaded spreadsheet rows into structured JSON payloads for AEM Assets REST
  API processing.

* page-properties.js:
  Handles DOM events for the Page Properties tab. Reads CSV payloads, maps
  Column A (path) as the primary JCR route, transforms remaining columns into
  JCR property key-value maps, and converts " ||| " strings into array payloads.

* asset-mover.js:
  Manages asset migration UI interactions. Parses source and destination
  paths, enforces strict extension matching (e.g., .png to .png), and submits
  transactional move commands to the background engine.

* package-builder.js:
  Manages CRX Package Manager UI workflows. Reads path trees, calculates asset
  file sizes via QueryBuilder API calls, dynamically calculates size-based
  splits (e.g., max 2 MB per ZIP bundle), and builds/downloads filters.

* publisher.js:
  Controls bulk replication workflows. Parses plain-text path lists or CSV
  uploads, evaluates exclusion rules, handles tree activation flags
  (includeChildren), and issues replication POST commands.

* background.js:
  Acts as the Manifest V3 Service Worker. Key features include:
  - Dynamic request header modification via declarativeNetRequest.
  - CSRF token pre-fetching (/libs/granite/csrf/token.json).
  - On-demand Adobe IMS Bearer token interception (chrome.webRequest).
  - High-speed parallel Content Fragment extraction and Option A REST upserts.
  - JCR page property updates targeting /jcr:content.
  - CRX Package creation, building, downloading, and JCR deletion.
  - Dual-Identity audit probes (Chrome account email, AEM user, client IP).


3. NETWORK ARCHITECTURE & SECURITY MECHANISMS
--------------------------------------------------------------------------------
3.1 Network Execution & Tab-Injected Fallback Engine
When background.js issues a REST request to an AEM server, standard extension
fetch calls can fail due to strict CORS rules, missing SameSite cookies, or
Granite CSRF protection.

To resolve this, network requests pass through safeFetch:

+-------------------------------------------------------------------+
|                     safeFetch(url, options)                       |
+-------------------------------------------------------------------+
                                  |
                        Attempts Background fetch()
                                  |
           +----------------------+----------------------+
           |                                             |
     HTTP 2xx (Success)                         Fetch Fails / CORS Error
           |                                             |
    Return Response                              Fallback to fetchInActiveTab()
                                                         |
                                          Executes chrome.scripting.executeScript
                                          in active AEM Browser Tab Context

Abort Controller Circuit Breakers:
All fetch requests wrap an AbortController signal with a 10-second safety
threshold to prevent infinite thread locks.

3.2 Dynamic Header Proxy Engine (declarativeNetRequest)
To bypass AEM Granite CSRF Filter checks that reject requests lacking explicit
Origin or Referer headers from trusted authoring domains, background.js updates
dynamic network rules on demand (injecting clean domain headers).

3.3 On-Demand IMS Token Interception
When using AUTO_IMS auth mode, the extension attaches a temporary
chrome.webRequest.onBeforeSendHeaders listener to monitor traffic toward the
target domain. It triggers a lightweight GET request to
/libs/granite/csrf/token.json, extracts the Bearer token, saves it to local
storage, and detaches the listener.


4. MODULE TECHNICAL SPECIFICATIONS & API ENDPOINTS
--------------------------------------------------------------------------------
4.1 Content Fragment (CF) Manager
Supports Option A schema conventions for creating/updating fragments across
master and custom variations.

Extraction Logic (EXTRACT_CF_DATA):
1. Endpoint Called: GET <domain>/api/assets<path>.json?limit=100
2. Directory & Asset Resolution: Child entities are fetched concurrently using
   Promise.all.
3. Element Value Extraction: Calls extractCleanValue() for master and defined
   variations (e.g., mobile, v1).
4. Multi-Value Concatenation: Converts element arrays into a string formatted
   with the " ||| " delimiter.
5. Dynamic Variation Column: Included if custom variations exist; omitted if
   only master variations are present.

Upsert / Import Logic (PROCESS_CF_UPSERT):
* Master Upsert Endpoint: PUT <domain>/api/assets<path>/<cfName>.json
* Variation Upsert Endpoint: PUT <domain>/api/assets<path>/<cfName>/elements.json

4.2 Bulk Page Properties Manager
Updates JCR properties on AEM pages in bulk by directly modifying the page's
/jcr:content node.

Processing Sequence (UPDATE_PAGE_PROPERTIES):
1. Target Path Normalization: Appends /jcr:content to input path if omitted.
2. Endpoint Called: POST <domain><pagePath>/jcr:content
3. Form Payload Construction: Uses application/x-www-form-urlencoded.
4. Multi-Value Handling: Values with " ||| " split into arrays and append the key
   multiple times to the POST form payload (e.g., cq:tags=val1&cq:tags=val2).

4.3 Asset Mover & Renamer
Executes transactional moves and renames across AEM DAM structures.
* Endpoint Called: POST <domain>/content/dam/<sourcePath>
* Payload: :operation=move and :dest=/content/dam/<targetPath>

4.4 Package Builder
Resolves tree sizes, constructs CRX packages, configures filters, builds
packages, and handles downloads or cleanup.
* Size Resolution: QueryBuilder (/bin/querybuilder.json) calculates asset sizes.
* Package Creation: POST /crx/packmgr/service/.json/etc/packages/<group>/<name>?cmd=create
* Filter Update: Uploads filter arrays to /crx/packmgr/update.jsp
* Build Command: POST /crx/packmgr/service/.json/etc/packages/<group>/<name>.zip?cmd=build

4.5 Bulk Publisher
Triggers bulk tree replication across Author instances.
* Endpoint Called: POST <domain>/bin/replicate.json
* Payload: cmd=Activate or Deactivate, path=<targetJcrPath>, _charset_=utf-8


5. DUAL-IDENTITY OPERATOR PROBE & AUDIT ENGINE
--------------------------------------------------------------------------------
Every bulk action logs details to a central Google Apps Script execution endpoint
using a triple-probe identity lookup:
* Probe 1: Active Chrome Account (chrome.identity.getProfileUserInfo)
* Probe 2: Authenticated AEM Session (GET /libs/granite/security/currentuser.json)
* Probe 3: Client Public IP (GET https://api.ipify.org)

Combined Output Log Format:
"Chrome User: user@company.com | AEM Session: admin | IP: x.x.x.x"


6. DATA PARSING & DELIMITER LOGIC
--------------------------------------------------------------------------------
6.1 Multi-Value Delimiter (" ||| ")
* Exporting: Arrays convert to strings joined by " ||| ":
  ["/content/cq:tags/news", "/content/cq:tags/tech"] => "/content/cq:tags/news ||| /content/cq:tags/tech"
* Importing: Cells containing " ||| " split into arrays without trimming spaces:
  val.split(" ||| ");
* Single Pipes ("|"): Preserved as raw text and not split into arrays.

6.2 Native CSV Formatting
The internal downloadCSV utility escapes special characters per RFC 4180:
  const escapeCSV = (val) => {
    if (val === null || val === undefined) return '""';
    let str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

This ensures multi-line text, tabs, commas, and HTML elements remain intact
inside exported .csv files.
================================================================================
