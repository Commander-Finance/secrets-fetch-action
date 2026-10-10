import https from "https";
import core from "@actions/core";
import { VERSION } from "./meta.js";

// Adapted from https://github.com/DopplerHQ/cli/blob/a47f6d765bf9cb2155563e61287e325e492e3dea/pkg/http/config.go#L27
const MAX_ATTEMPTS = 5;
const BASE_DELAY = 500;
let retryBaseDelay = BASE_DELAY;

/**
 * Set the base backoff delay for every retried request. Tests set it to 0 so
 * they do not wait out real backoff.
 * @param {number} milliseconds
 * @returns {number} The previous base delay
 */
export function setRetryBaseDelay(milliseconds) {
  const previous = retryBaseDelay;
  retryBaseDelay = milliseconds;
  return previous;
}

/**
 * Custom error class for Doppler API errors that the retry wrapper can use to determine if an error should be retried
 */
class DopplerApiError extends Error {
  /**
   * @param {string} message
   * @param {number} statusCode
   * @param {string} contentType
   */
  constructor(message, statusCode, contentType) {
    super(message);
    this.statusCode = statusCode;
    this.contentType = contentType;
  }
}

/**
 * A request that got no usable response from Doppler: a refused or reset
 * connection, a DNS failure, a body cut off mid-transfer, or a 200 whose body
 * is not JSON, such as an error page from a proxy in front of the API
 */
class DopplerTransportError extends Error {}

/**
 * @param {Error} error - The socket or request error behind the failure
 * @returns {DopplerTransportError}
 */
function transportError(error) {
  return new DopplerTransportError(`Doppler API Error: ${error}`, { cause: error });
}

/**
 * @param {import("http").IncomingMessage} res - A 200 response
 * @param {string} payload - Its body
 * @returns {unknown} The parsed body, of whatever JSON type it holds
 */
function parseSuccessBody(res, payload) {
  try {
    return JSON.parse(payload);
  } catch {
    // The parser's message quotes the start of the body, so it is not passed on.
    throw new DopplerTransportError(
      `Doppler API Error: ${res.statusCode} ${res.statusMessage} with a body that is not JSON (${res.headers["content-type"] ?? "no content type"})`,
    );
  }
}

// Doppler answers 400 with this when it cannot fetch GitHub's signing keys to
// validate an OIDC token. The same token is accepted on a retry.
const JWKS_UNAVAILABLE = "could not retrieve JSON Web Key Set";

// core.getIDToken reports the HTTP status as "Error Code : <status>", which is
// "undefined" when the request got no response. The failures seen in production
// all got no response, so an answered request is not retried; core already
// retries a 502, 503 or 504 itself.
const ID_TOKEN_TRANSPORT_FAILURE = /Error Code : undefined/;

// A hung token endpoint costs @actions/http-client's three-minute request
// timeout on every attempt, so this stops sooner than the Doppler requests do.
const ID_TOKEN_MAX_ATTEMPTS = 3;

/**
 * Adapted from https://github.com/DopplerHQ/cli/blob/b008b823ec58f6982e26392b6fd0c30345e100a0/pkg/http/http.go#L359-L364
 * Determines if a Doppler request should be retried. Unlike the CLI, this
 * retries a 5xx with a JSON body, because Doppler reports its 29-second
 * request timeout as a 503 with one.
 */
function shouldRetry(error) {
  if (error instanceof DopplerTransportError) {
    return true;
  }
  if (!(error instanceof DopplerApiError)) {
    return false;
  }
  const { statusCode, message } = error;
  return (
    statusCode === 429 ||
    (statusCode >= 100 && statusCode <= 199) ||
    (statusCode >= 500 && statusCode <= 599) ||
    (statusCode === 400 && message.includes(JWKS_UNAVAILABLE))
  );
}

/**
 * Retry wrapper with exponential backoff
 * @param {Function} fn - The function to retry
 * @param {number} maxAttempts - Maximum number of attempts
 * @param {number} baseDelay - Base delay in ms
 * @param {(error: Error) => boolean} isRetryable - Whether an error is worth another attempt
 * @returns {Promise}
 */
export async function withRetry(fn, maxAttempts = MAX_ATTEMPTS, baseDelay = retryBaseDelay, isRetryable = shouldRetry) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Don't retry on the last attempt
      if (attempt === maxAttempts) {
        break;
      }
      
      if (!isRetryable(error)) {
        break; // Don't retry non-retryable errors
      }

      // Exponential backoff with full-jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * baseDelay;
      core.warning(`${error.message} (attempt ${attempt} of ${maxAttempts}); retrying in ${(delay / 1000).toFixed(1)}s`);
      await new Promise(resolve => setTimeout(resolve, delay)); 
    }
  }
  
  throw lastError;
}
/**
 * Internal fetch function without retry logic
 * @param {string} dopplerToken
 * @param {string | null} [dopplerProject]
 * @param {string | null} [dopplerConfig]
 * @param {string} apiDomain 
 * @returns {Promise<Record<string, Record>>}
 */
async function _fetch(dopplerToken, dopplerProject, dopplerConfig, apiDomain) {
  return new Promise(function (resolve, reject) {
    const encodedAuthData = Buffer.from(`${dopplerToken}:`).toString("base64");
    const authHeader = `Basic ${encodedAuthData}`;
    const userAgent = `secrets-fetch-github-action/${VERSION}`;

    const url = new URL(`https://${apiDomain}/v3/configs/config/secrets`);
    if (dopplerProject && dopplerConfig) {
      url.searchParams.append("project", dopplerProject);
      url.searchParams.append("config", dopplerConfig);
    }

    https
      .get(
        url.href,
        {
          headers: {
            Authorization: authHeader,
            "user-agent": userAgent,
            "accepts": "application/json",
          },
        },
        (res) => {
          let payload = "";
          // Decodes across chunk boundaries, so a character split between chunks survives.
          res.setEncoding("utf8");
          res.on("data", (data) => (payload += data));
          res.on("error", (error) => {
            reject(transportError(error));
          });
          res.on("end", () => {
            if (res.statusCode === 200) {
              try {
                resolve(parseSuccessBody(res, payload).secrets);
              } catch (error) {
                reject(error);
              }
            } else {
              try {
                const error = JSON.parse(payload).messages.join(" ");
                reject(new DopplerApiError(`Doppler API Error: ${error}`, res.statusCode, res.headers["content-type"]));
              } catch (error) {
                // In the event an upstream issue occurs and no JSON payload is supplied
                reject(new DopplerApiError(`Doppler API Error: ${res.statusCode} ${res.statusMessage}`, res.statusCode, res.headers["content-type"]));
              }
            }
          });
        }
      )
      .on("error", (error) => {
        reject(transportError(error));
      });
  });
}

/**
 * Internal OIDC auth function without retry logic
 * @param {string} identityId 
 * @param {string} oidcToken 
 * @param {string} apiDomain 
 * @returns {Promise<string>}
 */
async function _oidcAuth(identityId, oidcToken, apiDomain) {
  return new Promise(function (resolve, reject) {
    const userAgent = `secrets-fetch-github-action/${VERSION}`;

    const url = new URL(`https://${apiDomain}/v3/auth/oidc`);
    const body = JSON.stringify({
      identity: identityId,
      token: oidcToken
    });
   
    const request = https
      .request(
        url.href,
        {
          headers: {
            "user-agent": userAgent,
            "accepts": "application/json",
            "Content-Type": "application/json",
            "Content-Length": body.length,
          },
          method: 'POST'
        },
        (res) => {
          let payload = "";
          // Decodes across chunk boundaries, so a character split between chunks survives.
          res.setEncoding("utf8");
          res.on("data", (data) => (payload += data));
          res.on("error", (error) => {
            reject(transportError(error));
          });
          res.on("end", () => {
            if (res.statusCode === 200) {
              try {
                resolve(parseSuccessBody(res, payload).token);
              } catch (error) {
                reject(error);
              }
            } else {
              try {
                const error = JSON.parse(payload).messages.join(" ");
                reject(new DopplerApiError(`Doppler API Error: ${error}`, res.statusCode, res.headers["content-type"]));
              } catch (error) {
                // In the event an upstream issue occurs and no JSON payload is supplied
                reject(new DopplerApiError(`Doppler API Error: ${res.statusCode} ${res.statusMessage}`, res.statusCode, res.headers["content-type"]));
              }
            }
          });
        }
      );

    request
      .on("error", (error) => {
        reject(transportError(error));
      });

    request.write(body);

    request.end()
  });
}

/**
 * Fetch secrets from Doppler the API with retry logic
 * @param {string} dopplerToken
 * @param {string | null} [dopplerProject]
 * @param {string | null} [dopplerConfig]
 * @param {string} apiDomain 
 * @returns {Promise<Record<string, Record>>}
 */
export async function fetch(dopplerToken, dopplerProject, dopplerConfig, apiDomain) {
  return withRetry(() => _fetch(dopplerToken, dopplerProject, dopplerConfig, apiDomain));
}

/**
 * Exchange an OIDC token for a short lived Doppler service account token with retry logic
 * @param {string} identityId 
 * @param {string} oidcToken 
 * @param {string} apiDomain 
 * @returns {Promise<string>}
 */
export async function oidcAuth(identityId, oidcToken, apiDomain) {
  return withRetry(() => _oidcAuth(identityId, oidcToken, apiDomain));
}

/**
 * Request the job's GitHub OIDC token, retrying a request that got no response.
 * Every other failure, including a job without `id-token: write`, is tried once.
 * @returns {Promise<string>}
 */
export async function getOidcToken() {
  return withRetry(() => core.getIDToken(), ID_TOKEN_MAX_ATTEMPTS, retryBaseDelay, (error) =>
    ID_TOKEN_TRANSPORT_FAILURE.test(error.message),
  );
}
