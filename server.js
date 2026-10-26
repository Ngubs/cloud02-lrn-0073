"use strict";

const http = require("node:http");
const { DefaultAzureCredential } = require("@azure/identity");
const { BlobServiceClient } = require("@azure/storage-blob");

const port = Number(process.env.PORT || 3000);

// Local sample mode is for practising before connecting Azure Storage.
// On App Service, storage mode is required unless explicitly configured.
const mode =
  process.env.DATA_MODE || (process.env.WEBSITE_SITE_NAME ? "azure" : "sample");

const sampleData = require("./enrolments.json");

let container;

function getContainer() {
  if (container) return container;

  const account = process.env.STORAGE_ACCOUNT_NAME;
  const containerName = process.env.STORAGE_CONTAINER_NAME;

  if (!account || !/^[a-z0-9]{3,24}$/.test(account)) {
    throw new Error("STORAGE_ACCOUNT_NAME is missing or invalid.");
  }

  if (!containerName) {
    throw new Error("STORAGE_CONTAINER_NAME is missing.");
  }

  const service = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    new DefaultAzureCredential(),
  );

  container = service.getContainerClient(containerName);
  return container;
}

function validateData(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
    throw new Error("The enrolment file must contain 1 to 100 records.");
  }

  return rows.map((row) => {
    if (
      !row ||
      typeof row.course !== "string" ||
      !row.course.trim() ||
      row.course.length > 100 ||
      typeof row.campus !== "string" ||
      !row.campus.trim() ||
      row.campus.length > 100 ||
      !Number.isSafeInteger(row.enrolled) ||
      !Number.isSafeInteger(row.capacity) ||
      row.enrolled < 0 ||
      row.capacity < 1 ||
      row.capacity > 100000 ||
      row.enrolled > row.capacity
    ) {
      throw new Error("An enrolment record contains invalid values.");
    }

    return {
      course: row.course.trim(),
      campus: row.campus.trim(),
      enrolled: row.enrolled,
      capacity: row.capacity,
    };
  });
}

async function loadData() {
  if (mode === "sample") return validateData(sampleData);

  if (mode !== "azure") {
    throw new Error("DATA_MODE must be sample or azure.");
  }

  const blobName = process.env.STORAGE_BLOB_NAME || "enrolments.json";
  const blob = getContainer().getBlockBlobClient(blobName);

  // Limit downloads and request duration for this small training dataset.
  const buffer = await blob.downloadToBuffer(0, undefined, {
    maxRetryRequestsPerBlock: 0,
    abortSignal: AbortSignal.timeout(15000),
    blockSize: 65536,
    concurrency: 1,
    onProgress: (progress) => {
      if (progress.loadedBytes > 65536) {
        throw new Error("The training dataset is too large.");
      }
    },
  });

  if (buffer.length > 65536) {
    throw new Error("The training dataset is too large.");
  }

  return validateData(JSON.parse(buffer.toString("utf8")));
}

function send(response, status, type, body) {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; " +
      "script-src 'unsafe-inline'; connect-src 'self'; " +
      "base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  });

  response.end(body);
}

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ubuntu Skills Centre | Enrolment insights</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f3f6fa;color:#15263c;
font-family:Segoe UI,Arial,sans-serif}
header{background:#061f42;color:white;padding:32px 24px;
border-bottom:4px solid #b9934b}
main,header>div{max-width:1000px;margin:auto}
main{padding:24px}
h1{margin:8px 0;font-size:32px}
.eyebrow{color:#e6c980;font-weight:700}
.card{background:white;border:1px solid #d8e1eb;
border-radius:12px;padding:24px;margin-bottom:20px}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.metric strong{display:block;font-size:32px;color:#061f42}
.metric span{color:#52657b}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:14px 10px;border-bottom:1px solid #d8e1eb}
th{background:#edf2f8}
.table-wrap{overflow:auto}
button{background:#061f42;color:white;border:0;border-radius:6px;
padding:12px 18px;font:inherit;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
a{color:#174f89}
.notice{background:#fff7e6;padding:16px;border-left:4px solid #b9934b}
p{line-height:1.6}
@media(max-width:650px){.metrics{grid-template-columns:1fr}h1{font-size:26px}}
</style>
</head>
<body>
<header><div>
<div class="eyebrow">UBUNTU SKILLS CENTRE · TRAINING DEMONSTRATION</div>
<h1>FMTALI-LRN-0073 - Enrolment insights</h1>
<p>Help the centre understand demand and plan its next intake.</p>
</div></header>
<main>
<div class="notice">
Explore the centre's enrolment figures and check how the two campuses are preparing for the next intake.
</div>
<p id="status" role="status" aria-live="polite">Loading enrolment data…</p>
<section class="metrics" aria-label="Enrolment summary">
<div class="card metric"><strong id="enrolled">—</strong><span>Enrolled learners</span></div>
<div class="card metric"><strong id="available">—</strong><span>Available places</span></div>
<div class="card metric"><strong id="occupancy">—</strong><span>Overall occupancy</span></div>
</section>
<section class="card">
<h2>Current intake</h2>
<div class="table-wrap">
<table>
<thead><tr><th>Course</th><th>Campus</th><th>Enrolled</th><th>Capacity</th></tr></thead>
<tbody id="rows"></tbody>
</table>
</div>
<p><button id="refresh" type="button">Refresh data</button></p>
<a href="/api/enrolments">View the application’s JSON data</a>
</section>
<section class="card">
<h2>A useful distinction</h2>
<p>The page and the data are separate checks. If this page opens but
the figures do not appear, the web server is running; the application
may still need help reaching or reading its data.</p>
<p id="source"></p>
</section>
</main>
<script>
"use strict";
const button = document.getElementById("refresh");
const status = document.getElementById("status");

async function refresh() {
  button.disabled = true;
  document.getElementById("rows").replaceChildren();
  ["enrolled", "available", "occupancy"].forEach(function (id) {
    document.getElementById(id).textContent = "—";
  });
  document.getElementById("source").textContent = "";
  status.textContent = "Checking the enrolment data…";

  try {
    const response = await fetch("/api/enrolments", {
      cache: "no-store",
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Data is unavailable.");

    let enrolled = 0;
    let capacity = 0;

    data.records.forEach(function (record) {
      enrolled += record.enrolled;
      capacity += record.capacity;
      const row = document.createElement("tr");

      [record.course, record.campus, record.enrolled, record.capacity]
        .forEach(function (value) {
          const cell = document.createElement("td");
          cell.textContent = String(value);
          row.appendChild(cell);
        });

      document.getElementById("rows").appendChild(row);
    });

    document.getElementById("enrolled").textContent = enrolled;
    document.getElementById("available").textContent = capacity - enrolled;
    document.getElementById("occupancy").textContent =
      (100 * enrolled / capacity).toFixed(1) + "%";
    document.getElementById("source").textContent =
      "Data source: " + data.source;
    status.textContent = "Data loaded. The figures are ready to check.";
  } catch (error) {
    status.textContent =
      "The page is running, but the data could not be loaded. " +
      "Check the application logs and storage configuration, then refresh.";
  } finally {
    button.disabled = false;
  }
}

button.addEventListener("click", refresh);
refresh();
</script>
</body>
</html>`;

const server = http.createServer(async (request, response) => {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return send(response, 405, "text/plain; charset=utf-8", "Use GET.");
  }

  const path = (request.url || "/").split("?")[0];

  if (path === "/") {
    return send(response, 200, "text/html; charset=utf-8", page);
  }

  // Liveness only: this does not test the storage connection.
  if (path === "/health") {
    return send(
      response,
      200,
      "application/json",
      JSON.stringify({
        status: "running",
      }),
    );
  }

  if (path === "/api/enrolments") {
    try {
      const records = await loadData();

      return send(
        response,
        200,
        "application/json",
        JSON.stringify({
          source:
            mode === "sample"
              ? "Local sample data — Azure Storage is not connected"
              : "Azure Blob Storage",
          records,
        }),
      );
    } catch (error) {
      // Keep detailed SDK messages out of public responses.
      console.error("Enrolment data load failed", {
        name: error.name,
        code: error.code || "",
        statusCode: error.statusCode || "",
        configurationError:
          error.message.startsWith("STORAGE_") ||
          error.message.startsWith("DATA_MODE")
            ? error.message
            : undefined,
      });

      return send(
        response,
        503,
        "application/json",
        JSON.stringify({
          message:
            "Enrolment data is unavailable. Check application configuration, " +
            "storage access and the dataset.",
        }),
      );
    }
  }

  return send(response, 404, "text/plain; charset=utf-8", "Page not found.");
});

server.listen(port, "0.0.0.0", () => {
  console.log("Ubuntu Skills Centre application started.");
  console.log("Data mode: " + mode);
  console.log("Open http://localhost:" + port);
});
