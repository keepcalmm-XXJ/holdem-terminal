import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createGameServer } from "../server/http.mjs";
import { request as httpRequest } from "node:http";

test("HTTP sessions, origin checks, authorization and concurrent state conflicts", async (t) => {
  const server = createGameServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(op, data = {}, token, headers = {}) {
    const response = await fetch(`${base}/api/${op}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  }
  assert.equal(
    (await post("session", {}, null, { Origin: "https://evil.example" }))
      .status,
    403,
  );
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(
      base,
      { headers: { Host: "evil.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await post("get_table_state")).status, 401);
  const a = (await post("session")).body.token;
  const b = (await post("session")).body.token;
  const created = await post(
    "create_room",
    { name: "<img onerror=alert(1)>", requestId: randomUUID() },
    a,
  );
  assert.equal(created.status, 400); // length cap
  const room = (
    await post(
      "create_room",
      { name: "<b>Alice</b>", requestId: randomUUID() },
      a,
    )
  ).body.room;
  assert.equal((await post("get_table_state", { room }, b)).status, 403);
  await post("join_room", { room, name: "Bob", requestId: randomUUID() }, b);
  const state = (await post("get_table_state", {}, a)).body;
  const inputs = [
    { ready: true, revision: state.revision, requestId: randomUUID() },
    { ready: false, revision: state.revision, requestId: randomUUID() },
  ];
  const results = await Promise.all(
    inputs.map((data) => post("set_ready", data, a)),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const page = await fetch(base);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal(await page.text(), "Holdem Terminal Server\n");
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await post("session", { huge: "x".repeat(9000) })).status, 413);
});
