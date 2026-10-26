"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const path = require("node:path");

async function startApp(t, mode) {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) => {
    socket.close((error) => error ? reject(error) : resolve());
  });

  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_MODE: mode,
      STORAGE_ACCOUNT_NAME: "",
      STORAGE_CONTAINER_NAME: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill();
      await closed;
    }
  });

  let output = "";
  child.stderr.on("data", (data) => {
    output = (output + data).slice(-4000);
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(
      "Application did not start within 10 seconds.\n" + output
    )), 10000);
    function finish(error) {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      error ? reject(error) : resolve();
    }
    function onData(data) {
      output = (output + data).slice(-4000);
      if (output.includes("application started.")) finish();
    }
    function onError(error) { finish(error); }
    function onExit(code) {
      finish(new Error("Application exited: " + code + "\n" + output));
    }
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  return (route, options = {}) => fetch(
    `http://127.0.0.1:${port}${route}`,
    { ...options, signal: AbortSignal.timeout(5000) },
  );
}

test("Sample application behaviour", { timeout: 30000 }, async (t) => {
  const request = await startApp(t, "sample");

  await t.test("Dashboard is served with the intake guidance", async () => {
    const response = await request("/");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /Ubuntu Skills Centre/);
    assert.match(html, /Explore the centre's enrolment figures/);
  });

  await t.test("API returns the expected fictional records", async () => {
    const response = await request("/api/enrolments");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const data = await response.json();
    assert.match(data.source, /^Local sample data/);
    assert.deepEqual(
      data.records,
      JSON.parse(require('node:fs').readFileSync(
        path.join(__dirname, '..', 'enrolments.json'), 'utf8'
      ))
    );
  });

  await t.test("Responses include the agreed browser protections", async () => {
    const response = await request("/api/enrolments");
    await response.text();
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  });

  await t.test("Unknown routes return 404", async () => {
    const response = await request("/does-not-exist");
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Page not found.");
  });

  await t.test("POST requests are rejected", async () => {
    const response = await request("/api/enrolments", { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    await response.text();
  });
});

test("Missing Azure configuration fails safely", { timeout: 30000 }, async (t) => {
  // An empty account name fails validation before any Azure network request.
  const request = await startApp(t, "azure");
  const health = await request("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "running" });

  const response = await request("/api/enrolments");
  assert.equal(response.status, 503);
  const data = await response.json();
  assert.deepEqual(Object.keys(data), ["message"]);
  assert.match(data.message, /Enrolment data is unavailable/);
  assert.doesNotMatch(data.message, /STORAGE_ACCOUNT_NAME|stack|credential/i);
});
