import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { createGateway, mintCapability } from "./server.mjs";

const secret = "test-secret-that-is-at-least-thirty-two-bytes-long";
const sessionId = "123e4567-e89b-42d3-a456-426614174000";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("secure discovery requests all fields and fills generic text and native selects", async (context) => {
  let discoveryUrl;
  const posted = [];
  const metadata = {
    formId: "synthetic-juror-form",
    pageId: "synthetic-page",
    frameUrl: "https://forms.example.test/juror",
    origin: "https://forms.example.test",
    kind: "details",
    fields: [
      {
        id: "f0",
        purpose: "field",
        label: "Synthetic response",
        inputType: "text",
        required: true,
        selector: "#synthetic-response",
        value: "synthetic-existing-value",
      },
      {
        id: "f1",
        purpose: "field",
        label: "Synthetic choice",
        inputType: "select",
        required: true,
        options: [
          { value: "0", label: "Synthetic no" },
          { value: "1", label: "Synthetic yes" },
        ],
        selector: "#synthetic-choice",
        value: "0",
      },
    ],
  };
  const upstream = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://upstream.test");
    if (
      url.pathname !== `/v1/sessions/${sessionId}/credential-form`
    ) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET") {
      discoveryUrl = url;
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(metadata));
      return;
    }
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      posted.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, submitted: false }));
      return;
    }
    response.writeHead(405).end();
  });
  const upstreamPort = await listen(upstream);
  const { internal, publicServer } = createGateway({
    secret,
    publicOrigin: "https://viewer.example.test",
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    maximumTtlMs: 900_000,
  });
  const [internalPort, publicPort] = await Promise.all([
    listen(internal),
    listen(publicServer),
  ]);
  context.after(async () =>
    Promise.all([close(internal), close(publicServer), close(upstream)]),
  );

  const capability = mintCapability(
    { sessionId, expiresAt: Date.now() + 60_000 },
    secret,
  );
  const discovered = await fetch(
    `http://127.0.0.1:${publicPort}/credentials/${capability}`,
  );
  assert.equal(discovered.status, 200);
  assert.equal(discoveryUrl.searchParams.get("scope"), "all");
  const handoff = await discovered.json();
  assert.deepEqual(handoff.fields, [
    {
      id: "f0",
      purpose: "field",
      label: "Synthetic response",
      inputType: "text",
      required: true,
    },
    {
      id: "f1",
      purpose: "field",
      label: "Synthetic choice",
      inputType: "select",
      required: true,
      options: [
        { value: "0", label: "Synthetic no" },
        { value: "1", label: "Synthetic yes" },
      ],
    },
  ]);
  assert.ok(!JSON.stringify(handoff).includes("synthetic-existing-value"));
  assert.ok(!JSON.stringify(handoff).includes("#synthetic-"));

  const values = { f0: "synthetic juror response", f1: "1" };
  const filled = await fetch(
    `http://127.0.0.1:${publicPort}/credential-fills/${handoff.handoffId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values, submit: true }),
    },
  );
  assert.equal(filled.status, 200);
  assert.deepEqual(await filled.json(), { ok: true, submitted: false });
  const { fields: _fields, ...target } = metadata;
  assert.deepEqual(posted, [{ target, values, submit: false }]);
  assert.ok(internalPort > 0);
});
