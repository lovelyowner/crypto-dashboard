import assert from "node:assert/strict";
import test from "node:test";
import { readAuthRequestDiagnostic } from "./request-diagnostic.js";

test("request diagnostics expose only public status, MIME type, and platform request ID", () => {
  const response = new Response("<html>private-state-and-body</html>", {
    status: 500,
    headers: {
      "content-type": "Text/HTML; charset=utf-8",
      "x-vercel-id": "iad1::fixture-123",
      "set-cookie": "private-session-secret",
      location: "https://example.com/?state=private-state",
    },
  });
  assert.deepEqual(readAuthRequestDiagnostic(response), {
    status: 500,
    responseType: "text/html",
    requestId: "iad1::fixture-123",
  });
  assert.equal(response.bodyUsed, false);
  assert.doesNotMatch(
    JSON.stringify(readAuthRequestDiagnostic(response)),
    /private|cookie|location/,
  );
});

test("malformed and oversized response metadata is omitted rather than copied into setup reports", () => {
  for (const requestId of [
    "https://example.com/?state=private",
    "private value",
    "x".repeat(161),
  ]) {
    const response = new Response(null, {
      status: 403,
      headers: { "x-vercel-id": requestId, "content-type": "not-a-mime" },
    });
    assert.deepEqual(readAuthRequestDiagnostic(response), { status: 403, responseType: "unknown" });
  }
});
