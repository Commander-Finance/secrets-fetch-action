import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import core from "@actions/core";

// `@actions/http-client` sets `error.result` only when the server sent a response
// body. A transport-level failure - connection reset, timeout, DNS - therefore
// produces an error with no `.result`, which is the case this pins: reading
// `.result.message` there throws a TypeError that replaces the real cause, and the
// job then fails with a message that says nothing about why the token exchange
// failed.
const MASKED_MESSAGE = "Cannot read properties of undefined";

/**
 * Serves the ID-token URL by destroying the socket, reproducing a transport-level
 * failure with no HTTP response at all.
 */
async function withResettingTokenServer(run) {
  const server = http.createServer((request) => request.socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const previousUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const previousToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `http://127.0.0.1:${server.address().port}/`;
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "test-token";

  try {
    return await run();
  } finally {
    restoreEnvironmentVariable("ACTIONS_ID_TOKEN_REQUEST_URL", previousUrl);
    restoreEnvironmentVariable("ACTIONS_ID_TOKEN_REQUEST_TOKEN", previousToken);
    await new Promise((resolve) => server.close(resolve));
  }
}

function restoreEnvironmentVariable(name, previousValue) {
  if (previousValue === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previousValue;
}

test("getIDToken reports the underlying transport failure, not its own TypeError", async () => {
  const error = await withResettingTokenServer(async () => {
    try {
      await core.getIDToken();
    } catch (thrown) {
      return thrown;
    }
    return null;
  });

  assert.notEqual(error, null, "getIDToken resolved against a reset connection");
  assert.ok(
    !error.message.includes(MASKED_MESSAGE),
    `the real cause was replaced by the error handler's own TypeError: ${error.message}`,
  );
  assert.match(
    error.message,
    /ECONNRESET|socket hang up/,
    `the message does not name the transport failure: ${error.message}`,
  );
});
