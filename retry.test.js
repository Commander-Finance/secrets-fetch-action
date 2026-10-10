import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { inspect } from "node:util";
import core from "@actions/core";
import { fetch, getOidcToken, oidcAuth, setRetryBaseDelay, withRetry } from "./doppler.js";

const JWKS_ERROR = "Unable to validate OIDC JWT token: could not retrieve JSON Web Key Set";
const SECRETS = { API_KEY: { computed: "fetched-secret-value", computedVisibility: "masked" } };
const EXCHANGED_TOKEN = "exchanged-test-token";
const SERVICE_TOKEN = "service-test-token";
const GITHUB_ID_TOKEN = "github-id-token";

// A truncated body or a dead socket can leave a request promise unsettled, so
// every call gets a deadline.
const DEADLINE_MS = 10_000;
const CASE_TIMEOUT_MS = 2 * DEADLINE_MS;

/**
 * Rejects if `promise` has not settled within DEADLINE_MS, so a hung request
 * fails its own test and still reaches that test's cleanup.
 */
async function settled(promise) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${DEADLINE_MS} ms`)), DEADLINE_MS);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function html(status, body) {
  return (_request, response) => {
    response.writeHead(status, { "content-type": "text/html" });
    response.end(body);
  };
}

function json(status, body) {
  return (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
}

/** Closes the connection before sending any response. */
function reset(request) {
  request.socket.destroy();
}

/** Sends the headers and part of a 200 body, then closes the connection. */
function resetMidBody(_request, response) {
  response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
  response.write('{"secr', () => response.socket.destroy());
}

/**
 * Starts a local HTTP server that answers the first request with `first` and
 * every later one with `rest`.
 */
async function startServer(first, rest) {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    const respond = requests === 1 ? first : rest;
    respond(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    domain: `127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/token`,
    requests: () => requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

function toHttp(url) {
  return url.replace(/^https:/, "http:");
}

function setEnvironment(values) {
  const previous = {};
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  return () => setEnvironment(previous);
}

let warnings;
let defaultBaseDelay;

before(() => {
  // The tests count requests and warnings, not time, so they skip the backoff.
  defaultBaseDelay = setRetryBaseDelay(0);
  // doppler.js only speaks HTTPS. Sending its requests to a plain-HTTP local
  // server keeps real sockets, so resets and truncated bodies behave as they do
  // against the real API.
  mock.method(https, "get", (url, options, callback) => http.get(toHttp(url), options, callback));
  mock.method(https, "request", (url, options, callback) => http.request(toHttp(url), options, callback));
});

let quieted;

beforeEach(() => {
  warnings = mock.method(core, "warning", () => {});
  // Keeps core's ::debug:: and ::add-mask:: workflow commands out of the test output.
  quieted = [mock.method(core, "debug", () => {}), mock.method(core, "setSecret", () => {})];
});

afterEach(() => {
  warnings.mock.restore();
  for (const stub of quieted) {
    stub.mock.restore();
  }
});

after(() => {
  setRetryBaseDelay(defaultBaseDelay);
  mock.restoreAll();
});

const DOPPLER_CALLS = [
  {
    name: "fetch",
    call: (domain) => fetch(SERVICE_TOKEN, null, null, domain),
    success: json(200, { secrets: SECRETS }),
    expected: SECRETS,
  },
  {
    name: "oidcAuth",
    call: (domain) => oidcAuth("identity-id", GITHUB_ID_TOKEN, domain),
    success: json(200, { token: EXCHANGED_TOKEN }),
    expected: EXCHANGED_TOKEN,
  },
];

const TRANSIENT_FAILURES = [
  ["a 400 when Doppler cannot fetch GitHub's JWKS", json(400, { messages: [JWKS_ERROR], success: false })],
  ["a 503 with a JSON body", json(503, { messages: ["Request took longer than 29 seconds"], success: false })],
  ["a 502 with an HTML body", html(502, "<html>Bad Gateway</html>")],
  ["a 429", json(429, { messages: ["Rate limit exceeded"], success: false })],
  ["a connection reset", reset],
  ["a reset after part of the body", resetMidBody],
  ["a 200 whose body is not JSON", html(200, "<html>Service Unavailable</html>")],
];

const PERMANENT_FAILURES = [
  ["a 401", json(401, { messages: ["Invalid Auth token"], success: false })],
  ["any other 400", json(400, { messages: ["Invalid identity"], success: false })],
];

for (const { name, call, success, expected } of DOPPLER_CALLS) {
  describe(`${name}()`, () => {
    for (const [failure, respond] of TRANSIENT_FAILURES) {
      test(`retries ${failure}`, { timeout: CASE_TIMEOUT_MS }, async () => {
        const server = await startServer(respond, success);
        try {
          assert.deepEqual(await settled(call(server.domain)), expected);
          assert.equal(server.requests(), 2);
          assert.equal(warnings.mock.callCount(), 1, "each retry should be announced");
          const [warning] = warnings.mock.calls[0].arguments;
          assert.match(warning, /attempt 1 of 5/);
          for (const secret of [SERVICE_TOKEN, GITHUB_ID_TOKEN]) {
            assert.ok(!warning.includes(secret), `the retry warning leaked ${secret}`);
          }
        } finally {
          await server.close();
        }
      });
    }

    for (const [failure, respond] of PERMANENT_FAILURES) {
      test(`does not retry ${failure}`, { timeout: CASE_TIMEOUT_MS }, async () => {
        const server = await startServer(respond, success);
        try {
          await assert.rejects(settled(call(server.domain)), /Doppler API Error/);
          assert.equal(server.requests(), 1);
        } finally {
          await server.close();
        }
      });
    }
  });
}

describe("a 200 whose body is not JSON", () => {
  // A 200 from Doppler carries secrets or a token, so its body must not reach the logs.
  const BODY_MARKER = "LEAKME";
  const ATTEMPTS_BEFORE_GIVING_UP = 5;
  const CONTENT_TYPES = [
    ["a proxy's error page", { "content-type": "text/html" }, /text\/html/],
    ["a response without one", {}, /no content type/],
  ];

  for (const { name, call } of DOPPLER_CALLS) {
    for (const [label, headers, expectedContentType] of CONTENT_TYPES) {
      test(`${name}() names the status and content type of ${label}, not the body`, { timeout: CASE_TIMEOUT_MS }, async () => {
        const notJson = (_request, response) => {
          response.writeHead(200, headers);
          response.end(`${BODY_MARKER}-secret-value is not json`);
        };
        const server = await startServer(notJson, notJson);
        try {
          const error = await settled(call(server.domain)).then(
            () => assert.fail(`${name} resolved`),
            (rejection) => rejection,
          );
          assert.equal(server.requests(), ATTEMPTS_BEFORE_GIVING_UP);
          assert.match(error.message, /\b200\b/);
          assert.match(error.message, /not JSON/);
          assert.match(error.message, expectedContentType);
          assert.ok(!inspect(error, { depth: null }).includes(BODY_MARKER), "the error quotes the body");
          for (const { arguments: [warning] } of warnings.mock.calls) {
            assert.ok(!warning.includes(BODY_MARKER), "a retry warning quotes the body");
          }
        } finally {
          await server.close();
        }
      });
    }
  }
});

describe("non-ASCII text", () => {
  // "é" is two bytes in UTF-8, so a split can leave half of it in each chunk.
  const NON_ASCII_CHARACTER = "é";
  const NON_ASCII_SECRETS = { API_KEY: { computed: `caf${NON_ASCII_CHARACTER}-secret`, computedVisibility: "masked" } };
  const NON_ASCII_TOKEN = `caf${NON_ASCII_CHARACTER}-token`;
  const NON_ASCII_RESPONSES = {
    fetch: { body: { secrets: NON_ASCII_SECRETS }, expected: NON_ASCII_SECRETS },
    oidcAuth: { body: { token: NON_ASCII_TOKEN }, expected: NON_ASCII_TOKEN },
  };
  // Long enough that the client reads the two halves separately.
  const PAUSE_BETWEEN_CHUNKS_MS = 20;

  /** Answers 200 with `body`, sent as two chunks that divide NON_ASCII_CHARACTER. */
  function splitInsideCharacter(body) {
    return (_request, response) => {
      const bytes = Buffer.from(JSON.stringify(body));
      const splitAt = bytes.indexOf(Buffer.from(NON_ASCII_CHARACTER)) + 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.write(bytes.subarray(0, splitAt), () => {
        setTimeout(() => response.end(bytes.subarray(splitAt)), PAUSE_BETWEEN_CHUNKS_MS);
      });
    };
  }

  for (const { name, call } of DOPPLER_CALLS) {
    const { body, expected } = NON_ASCII_RESPONSES[name];
    test(`${name}() keeps a character split between response chunks`, { timeout: CASE_TIMEOUT_MS }, async () => {
      const respond = splitInsideCharacter(body);
      const server = await startServer(respond, respond);
      try {
        assert.deepEqual(await settled(call(server.domain)), expected);
        assert.equal(server.requests(), 1);
      } finally {
        await server.close();
      }
    });
  }
});

describe("getOidcToken()", () => {
  test("retries a reset from GitHub's token endpoint", { timeout: CASE_TIMEOUT_MS }, async () => {
    const server = await startServer(reset, json(200, { value: GITHUB_ID_TOKEN }));
    const restore = setEnvironment({
      ACTIONS_ID_TOKEN_REQUEST_URL: server.url,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    });
    try {
      assert.equal(await settled(getOidcToken()), GITHUB_ID_TOKEN);
      assert.equal(server.requests(), 2);
    } finally {
      restore();
      await server.close();
    }
  });

  test("gives up after three requests without a response", { timeout: CASE_TIMEOUT_MS }, async () => {
    const server = await startServer(reset, reset);
    const restore = setEnvironment({
      ACTIONS_ID_TOKEN_REQUEST_URL: server.url,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    });
    try {
      await assert.rejects(settled(getOidcToken()), /Error Code : undefined/);
      assert.equal(server.requests(), 3);
    } finally {
      restore();
      await server.close();
    }
  });

  // core retries a 502, 503 or 504 itself; an answered request is not retried here.
  const ANSWERED_FAILURES = [
    ["a 403", json(403, { message: "Forbidden" }), /Error Code : 403/],
    ["a response without a token", json(200, {}), /do not have ID Token field/],
  ];

  for (const [failure, respond, expectedError] of ANSWERED_FAILURES) {
    test(`does not retry ${failure} from GitHub's token endpoint`, { timeout: CASE_TIMEOUT_MS }, async () => {
      const server = await startServer(respond, json(200, { value: GITHUB_ID_TOKEN }));
      const restore = setEnvironment({
        ACTIONS_ID_TOKEN_REQUEST_URL: server.url,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      });
      try {
        await assert.rejects(settled(getOidcToken()), expectedError);
        assert.equal(server.requests(), 1);
      } finally {
        restore();
        await server.close();
      }
    });
  }

  const MISSING_PERMISSION = [
    ["the request URL", { ACTIONS_ID_TOKEN_REQUEST_URL: undefined, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token" }],
    ["the request token", { ACTIONS_ID_TOKEN_REQUEST_URL: "http://127.0.0.1:9/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }],
    ["both request variables", { ACTIONS_ID_TOKEN_REQUEST_URL: undefined, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }],
  ];

  for (const [missing, environment] of MISSING_PERMISSION) {
    test(`tries once without ${missing}`, { timeout: CASE_TIMEOUT_MS }, async () => {
      const getIDToken = mock.method(core, "getIDToken");
      const restore = setEnvironment(environment);
      try {
        await assert.rejects(settled(getOidcToken()), /ACTIONS_ID_TOKEN_REQUEST/);
        assert.equal(getIDToken.mock.callCount(), 1);
      } finally {
        restore();
        getIDToken.mock.restore();
      }
    });
  }
});

describe("backoff", () => {
  const BASE_DELAY_MS = 50;
  // The first retry waits twice the base plus up to one base of jitter: 100-150 ms.
  const FIRST_RETRY_MIN_MS = 2 * BASE_DELAY_MS;
  // Timers run against libuv's cached loop time, which can trail performance.now().
  const TIMER_SLACK_MS = 10;
  const FIRST_RETRY_WARNING = /retrying in 0\.1s/;

  /** Runs `call` against a server that fails once, with a nonzero base delay. */
  async function timeFirstRetry(first, rest, call) {
    const server = await startServer(first, rest);
    const previous = setRetryBaseDelay(BASE_DELAY_MS);
    try {
      const started = performance.now();
      await settled(call(server));
      return { elapsed: performance.now() - started, requests: server.requests() };
    } finally {
      setRetryBaseDelay(previous);
      await server.close();
    }
  }

  function assertWaitedBeforeRetrying({ elapsed, requests }) {
    assert.equal(requests, 2);
    assert.ok(elapsed >= FIRST_RETRY_MIN_MS - TIMER_SLACK_MS, `retried after ${elapsed} ms`);
    const [warning] = warnings.mock.calls[0].arguments;
    assert.match(warning, FIRST_RETRY_WARNING);
  }

  test("waits before retrying a Doppler request", { timeout: CASE_TIMEOUT_MS }, async () => {
    const result = await timeFirstRetry(
      json(429, { messages: ["Rate limit exceeded"], success: false }),
      json(200, { secrets: SECRETS }),
      (server) => fetch(SERVICE_TOKEN, null, null, server.domain),
    );
    assertWaitedBeforeRetrying(result);
  });

  test("waits before retrying GitHub's token endpoint", { timeout: CASE_TIMEOUT_MS }, async () => {
    let restore = () => {};
    try {
      const result = await timeFirstRetry(reset, json(200, { value: GITHUB_ID_TOKEN }), (server) => {
        restore = setEnvironment({
          ACTIONS_ID_TOKEN_REQUEST_URL: server.url,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
        });
        return getOidcToken();
      });
      assertWaitedBeforeRetrying(result);
    } finally {
      restore();
    }
  });
});

describe("withRetry()", () => {
  test("gives up after five attempts with the last error", async () => {
    let attempts = 0;
    const alwaysFails = async () => {
      attempts += 1;
      throw new Error(`failure ${attempts}`);
    };
    const retryEverything = () => true;
    const noDelay = 0;

    await assert.rejects(withRetry(alwaysFails, 5, noDelay, retryEverything), /^Error: failure 5$/);
    assert.equal(attempts, 5);
    assert.equal(warnings.mock.callCount(), 4, "the last failure is thrown, not retried");
  });
});

describe("the action", () => {
  test(
    "fetches secrets through a GitHub token reset and a JWKS 400",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const github = await startServer(reset, json(200, { value: GITHUB_ID_TOKEN }));
      let oidcRequests = 0;
      const doppler = await startServer(
        json(400, { messages: [JWKS_ERROR], success: false }),
        (request, response) => {
          if (request.url.startsWith("/v3/auth/oidc")) {
            oidcRequests += 1;
            json(200, { token: EXCHANGED_TOKEN })(request, response);
          } else {
            json(200, { secrets: SECRETS })(request, response);
          }
        },
      );
      const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "secrets-fetch-action-"));
      const outputFile = path.join(outputDirectory, "output");
      // The runner creates this file before the step starts; core only appends to it.
      await writeFile(outputFile, "");
      const restore = setEnvironment({
        NODE_ENV: "test",
        ACTIONS_ID_TOKEN_REQUEST_URL: github.url,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
        GITHUB_OUTPUT: outputFile,
        GITHUB_ENV: undefined,
        "INPUT_AUTH-METHOD": "oidc",
        "INPUT_DOPPLER-IDENTITY-ID": "identity-id",
        "INPUT_DOPPLER-API-DOMAIN": doppler.domain,
        "INPUT_INJECT-ENV-VARS": "false",
        "INPUT_OUTPUT-DOPPLER-TOKEN": "false",
      });
      try {
        // A fresh specifier runs index.js again instead of reusing a cached module.
        await settled(import("./index.js?case=oidc-retries"));
        const output = await readFile(outputFile, "utf8");
        assert.match(output, /^API_KEY<<(.+)\nfetched-secret-value\n\1$/m);
        assert.equal(github.requests(), 2);
        assert.equal(oidcRequests, 1);
      } finally {
        restore();
        await Promise.all([github.close(), doppler.close()]);
        await rm(outputDirectory, { recursive: true, force: true });
      }
    },
  );
});
