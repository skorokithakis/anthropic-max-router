#!/usr/bin/env node

import express, { Request, Response } from 'express';
import readline from 'readline';
import crypto from 'crypto';
import { getValidAccessToken, loadTokens, saveTokens } from '../token-manager.js';
import { startOAuthFlow, exchangeCodeForTokens } from '../oauth.js';
import { ensureRequiredSystemPrompt, stripUnknownFields } from './middleware.js';
import { AnthropicRequest, AnthropicResponse, OpenAIChatCompletionRequest } from '../types.js';
import { logger } from './logger.js';
import {
  translateOpenAIToAnthropic,
  translateAnthropicToOpenAI,
  translateAnthropicStreamToOpenAI,
  translateAnthropicErrorToOpenAI,
  validateOpenAIRequest,
} from './translator.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

// Read at startup so the value is fixed for the lifetime of the process.
// Trim whitespace so accidental trailing newlines in env files don't silently
// enable auth mode with an unmatchable key.
const ROUTER_API_KEY: string | undefined = process.env.ROUTER_API_KEY?.trim() || undefined;

// A random nonce used to HMAC both sides of every key comparison. This ensures
// timingSafeEqual always receives fixed-length digests, preventing the early
// return on length mismatch from leaking the configured key length.
const HMAC_KEY = crypto.randomBytes(32);

/**
 * Extracts bearer token from Authorization header
 * @param req Express request object
 * @returns Bearer token if present, null otherwise
 */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return null;
}

/**
 * Extracts the presented API key from a request, checking both the
 * x-api-key header and the Authorization: Bearer scheme.
 */
function extractPresentedKey(req: Request): string | null {
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey && typeof xApiKey === 'string') {
    return xApiKey;
  }
  return extractBearerToken(req);
}

/**
 * Returns true when the presented key matches ROUTER_API_KEY using a
 * constant-time comparison to prevent timing attacks.
 */
function isValidRouterApiKey(presented: string): boolean {
  if (!ROUTER_API_KEY) {
    return false;
  }
  // HMAC both values with the same nonce so timingSafeEqual always receives
  // 32-byte digests. Without this, comparing raw buffers of different lengths
  // requires an early return that leaks the configured key length via timing.
  const expected = crypto.createHmac('sha256', HMAC_KEY).update(ROUTER_API_KEY).digest();
  const actual = crypto.createHmac('sha256', HMAC_KEY).update(presented).digest();
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Middleware that enforces ROUTER_API_KEY authentication when the env var is
 * set. Requests that do not present the correct key receive a 401 response.
 * When ROUTER_API_KEY is unset this middleware is a no-op.
 */
function requireRouterApiKey(req: Request, res: Response, next: () => void): void {
  if (!ROUTER_API_KEY) {
    next();
    return;
  }
  const presented = extractPresentedKey(req);
  if (!presented || !isValidRouterApiKey(presented)) {
    res.status(401).json({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Invalid or missing API key.',
      },
    });
    return;
  }
  next();
}

// Endpoint configuration
const endpointConfig = {
  anthropicEnabled: true, // default
  openaiEnabled: true, // default - enable both endpoints
  allowBearerPassthrough: true, // default - allow clients to use their own bearer tokens
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--version' || arg === '-v') {
      console.log(`Anthropic MAX Plan Router v${packageJson.version}`);
      process.exit(0);
    }

    if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    }

    if (arg === '--quiet' || arg === '-q') {
      logger.setLevel('quiet');
    } else if (arg === '--minimal' || arg === '-m') {
      logger.setLevel('minimal');
    } else if (arg === '--verbose' || arg === '-V') {
      logger.setLevel('maximum');
    } else if (arg === '--port' || arg === '-p') {
      const portValue = args[i + 1];
      if (portValue && !portValue.startsWith('-')) {
        PORT = parseInt(portValue);
        i++; // Skip next arg since we consumed it
      }
    } else if (arg === '--enable-all-endpoints') {
      endpointConfig.anthropicEnabled = true;
      endpointConfig.openaiEnabled = true;
    } else if (arg === '--enable-openai') {
      endpointConfig.openaiEnabled = true;
    } else if (arg === '--disable-openai') {
      endpointConfig.openaiEnabled = false;
    } else if (arg === '--enable-anthropic') {
      endpointConfig.anthropicEnabled = true;
    } else if (arg === '--disable-anthropic') {
      endpointConfig.anthropicEnabled = false;
    } else if (arg === '--disable-bearer-passthrough') {
      endpointConfig.allowBearerPassthrough = false;
    }
    // medium is default, no flag needed
  }

  // Validate that at least one endpoint is enabled
  if (!endpointConfig.anthropicEnabled && !endpointConfig.openaiEnabled) {
    console.error('Error: At least one endpoint must be enabled');
    console.error('Use --enable-anthropic or --enable-openai');
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
Anthropic MAX Plan Router v${packageJson.version}

Usage: npm run router [options]

Options:
  -h, --help                Show this help message
  -v, --version             Show version number
  -p, --port PORT           Port to listen on (default: 3000)

  Endpoint control (default: both enabled):
  --enable-anthropic        Enable Anthropic /v1/messages endpoint (default: enabled)
  --disable-anthropic       Disable Anthropic endpoint
  --enable-openai           Enable OpenAI /v1/chat/completions endpoint (default: enabled)
  --disable-openai          Disable OpenAI endpoint
  --enable-all-endpoints    Enable both Anthropic and OpenAI endpoints (same as default)

  Authentication control (default: passthrough enabled):
  --disable-bearer-passthrough  Force all requests to use router's OAuth tokens

  Verbosity levels (default: medium):
  -q, --quiet               Quiet mode - no request logging
  -m, --minimal             Minimal logging - one line per request
                            Default: Medium logging - summary per request
  -V, --verbose             Maximum logging - full request/response bodies

Environment variables:
  ROUTER_PORT               Port to listen on (default: 3000)
  ANTHROPIC_DEFAULT_MODEL   Override model mapping (e.g., claude-haiku-4-5)

Examples:
  npm run router                          # Start Anthropic endpoint only
  npm run router -- --enable-openai       # Enable OpenAI compatibility
  npm run router -- --enable-all-endpoints # Enable both endpoints
  npm run router -- --port 8080           # Start on port 8080
  npm run router -- --minimal             # Start with minimal logging
  npm run router -- --verbose             # Start with full request/response logging
  npm run router -- --quiet               # Start with no request logging
  npm run router -- -p 8080 --verbose     # Combine options

More info: https://github.com/nsxdavid/anthropic-max-router
`);
}

let PORT = process.env.ROUTER_PORT ? parseInt(process.env.ROUTER_PORT) : 3000;
parseArgs();

// When ROUTER_API_KEY is set the router owns authentication end-to-end, so
// bearer passthrough must be disabled regardless of any CLI flag.
if (ROUTER_API_KEY) {
  endpointConfig.allowBearerPassthrough = false;
}

const app = express();

// Anthropic API configuration
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA =
  'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';

// Health check must be registered before auth middleware so monitoring tools
// can reach it without an API key even when ROUTER_API_KEY is set.
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'anthropic-max-plan-router' });
});

// Enforce ROUTER_API_KEY on every request when the env var is set. Placed
// before express.json() so unauthenticated requests are rejected before the
// body is parsed, avoiding unnecessary memory allocation for large payloads.
app.use(requireRouterApiKey);

// Parse JSON request bodies with increased limit for large payloads
app.use(express.json({ limit: '50mb' }));

// OpenAI Models endpoint - proxy to Anthropic API with API key.
// When ROUTER_API_KEY is set the router uses its own OAuth token for all
// Anthropic calls and never receives a client Anthropic API key, so it cannot
// forward a key to the upstream /v1/models endpoint.
app.get('/v1/models', async (req: Request, res: Response) => {
  if (ROUTER_API_KEY) {
    res.status(501).json({
      type: 'error',
      error: {
        type: 'not_implemented',
        message:
          '/v1/models is not available in authenticated proxy mode (ROUTER_API_KEY is set). The router uses its own OAuth token and cannot forward a client Anthropic API key to the upstream endpoint.',
      },
    });
    return;
  }

  try {
    // Check for API key in headers
    const apiKey =
      req.headers['x-api-key'] ||
      (req.headers['authorization']?.startsWith('Bearer ')
        ? req.headers['authorization'].substring(7)
        : null);

    if (!apiKey) {
      res.status(401).json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message:
            'x-api-key header is required for /v1/models endpoint. Note: API key is only used for this endpoint; other endpoints use OAuth authentication.',
        },
      });
      return;
    }

    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey as string,
        'anthropic-version': ANTHROPIC_VERSION,
      },
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({
      type: 'error',
      error: {
        type: 'internal_error',
        message: error instanceof Error ? error.message : 'Failed to fetch models',
      },
    });
  }
});

// Shared handler for /v1/messages endpoint
const handleMessagesRequest = async (req: Request, res: Response) => {
  const requestId = Math.random().toString(36).substring(7);
  const timestamp = new Date().toISOString();

  try {
    // Get the request body and strip unknown fields (e.g., context_management from Agent SDK)
    const originalRequest = stripUnknownFields(req.body as Record<string, unknown>);

    const hadSystemPrompt = !!(originalRequest.system && originalRequest.system.length > 0);

    // Ensure the required system prompt is present
    const modifiedRequest = ensureRequiredSystemPrompt(originalRequest);

    // Determine which authentication method to use
    const clientBearerToken = extractBearerToken(req);
    const usePassthrough = endpointConfig.allowBearerPassthrough && clientBearerToken !== null;

    let accessToken: string;
    if (usePassthrough) {
      accessToken = clientBearerToken!;
      if (logger['level'] === 'maximum') {
        logger.info(`[Passthrough] Using client bearer token for request ${requestId}`);
      }
    } else {
      // Get a valid OAuth access token (auto-refreshes if needed)
      accessToken = await getValidAccessToken();
      if (logger['level'] === 'maximum') {
        logger.info(`[OAuth] Using router OAuth token for request ${requestId}`);
      }
    }

    // Forward the request to Anthropic API
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA,
      },
      body: JSON.stringify(modifiedRequest),
    });

    // Forward the status code and response
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.status(response.status);
      // Pipe the Anthropic response stream directly to the client
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        res.write(chunk);
      }
      res.end();
      // Logging for streaming responses
      logger.logRequest(requestId, timestamp, originalRequest, hadSystemPrompt, {
        status: response.status,
        data: undefined,
      });
    } else {
      const responseData = (await response.json()) as AnthropicResponse;
      logger.logRequest(requestId, timestamp, originalRequest, hadSystemPrompt, {
        status: response.status,
        data: responseData,
      });
      res.status(response.status).json(responseData);
    }
  } catch (error) {
    // Log the error
    logger.logRequest(
      requestId,
      timestamp,
      req.body as AnthropicRequest,
      false,
      undefined,
      error instanceof Error ? error : new Error('Unknown error')
    );

    // If headers were already sent (e.g., streaming response in progress),
    // we cannot send an error response - just log and return
    if (res.headersSent) {
      logger.error(`[${requestId}] Error occurred after headers sent:`, error);
      return;
    }

    // Handle specific error cases
    if (error instanceof Error) {
      res.status(500).json({
        error: {
          type: 'internal_error',
          message: error.message,
        },
      });
      return;
    }

    res.status(500).json({
      error: {
        type: 'internal_error',
        message: 'An unexpected error occurred',
      },
    });
  }
};

// OpenAI Chat Completions endpoint handler
const handleChatCompletionsRequest = async (req: Request, res: Response) => {
  const requestId = Math.random().toString(36).substring(7);
  const timestamp = new Date().toISOString();

  try {
    // Get the request body as an OpenAI request
    const openaiRequest = req.body as OpenAIChatCompletionRequest;

    // Validate the request
    validateOpenAIRequest(openaiRequest);

    // Translate OpenAI request to Anthropic format
    const anthropicRequest = translateOpenAIToAnthropic(openaiRequest);

    const hadSystemPrompt = !!(anthropicRequest.system && anthropicRequest.system.length > 0);

    // Ensure the required system prompt is present
    const modifiedRequest = ensureRequiredSystemPrompt(anthropicRequest);

    // Determine which authentication method to use
    const clientBearerToken = extractBearerToken(req);
    const usePassthrough = endpointConfig.allowBearerPassthrough && clientBearerToken !== null;

    let accessToken: string;
    if (usePassthrough) {
      accessToken = clientBearerToken!;
      if (logger['level'] === 'maximum') {
        logger.info(`[Passthrough] Using client bearer token for request ${requestId}`);
      }
    } else {
      // Get a valid OAuth access token (auto-refreshes if needed)
      accessToken = await getValidAccessToken();
      if (logger['level'] === 'maximum') {
        logger.info(`[OAuth] Using router OAuth token for request ${requestId}`);
      }
    }

    // Forward the request to Anthropic API
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA,
      },
      body: JSON.stringify(modifiedRequest),
    });

    // Handle streaming responses
    if (
      openaiRequest.stream &&
      response.headers.get('content-type')?.includes('text/event-stream')
    ) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.status(response.status);

      // Generate a message ID for the stream
      const messageId = `chatcmpl-${requestId}`;

      // Translate Anthropic stream to OpenAI format
      for await (const chunk of translateAnthropicStreamToOpenAI(
        response.body as AsyncIterable<Uint8Array>,
        openaiRequest.model,
        messageId
      )) {
        res.write(chunk);
      }

      res.end();

      // Log streaming response
      logger.logRequest(
        requestId,
        timestamp,
        modifiedRequest,
        hadSystemPrompt,
        { status: response.status, data: undefined },
        undefined,
        'openai'
      );
    } else {
      // Handle non-streaming response
      if (!response.ok) {
        const errorData = await response.json();
        const openaiError = translateAnthropicErrorToOpenAI(errorData);
        logger.logRequest(
          requestId,
          timestamp,
          modifiedRequest,
          hadSystemPrompt,
          { status: response.status, data: errorData as AnthropicResponse },
          undefined,
          'openai'
        );
        res.status(response.status).json(openaiError);
        return;
      }

      const anthropicResponse = (await response.json()) as AnthropicResponse;
      const openaiResponse = translateAnthropicToOpenAI(anthropicResponse, openaiRequest.model);

      logger.logRequest(
        requestId,
        timestamp,
        modifiedRequest,
        hadSystemPrompt,
        { status: response.status, data: anthropicResponse },
        undefined,
        'openai'
      );

      res.status(response.status).json(openaiResponse);
    }
  } catch (error) {
    // Log the error
    logger.logRequest(
      requestId,
      timestamp,
      req.body as AnthropicRequest,
      false,
      undefined,
      error instanceof Error ? error : new Error('Unknown error'),
      'openai'
    );

    // If headers were already sent (e.g., streaming response in progress),
    // we cannot send an error response - just log and return
    if (res.headersSent) {
      logger.error(`[${requestId}] Error occurred after headers sent:`, error);
      return;
    }

    // Return OpenAI-format error
    const openaiError = translateAnthropicErrorToOpenAI(
      error instanceof Error ? { message: error.message } : { message: 'Unknown error' }
    );

    res.status(500).json(openaiError);
  }
};

// Register endpoints conditionally based on configuration
if (endpointConfig.anthropicEnabled) {
  // Main Anthropic proxy endpoint
  app.post('/v1/messages', handleMessagesRequest);

  // Route alias to handle Stagehand v3 SDK bug that doubles the /v1 prefix
  app.post('/v1/v1/messages', handleMessagesRequest);
}

if (endpointConfig.openaiEnabled) {
  // OpenAI Chat Completions endpoint
  app.post('/v1/chat/completions', handleChatCompletionsRequest);
}

// Startup sequence
async function startRouter() {
  logger.startup('');
  logger.startup('███╗   ███╗ █████╗ ██╗  ██╗    ██████╗ ██╗      █████╗ ███╗   ██╗');
  logger.startup('████╗ ████║██╔══██╗╚██╗██╔╝    ██╔══██╗██║     ██╔══██╗████╗  ██║');
  logger.startup('██╔████╔██║███████║ ╚███╔╝     ██████╔╝██║     ███████║██╔██╗ ██║');
  logger.startup('██║╚██╔╝██║██╔══██║ ██╔██╗     ██╔═══╝ ██║     ██╔══██║██║╚██╗██║');
  logger.startup('██║ ╚═╝ ██║██║  ██║██╔╝ ██╗    ██║     ███████╗██║  ██║██║ ╚████║');
  logger.startup('╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝    ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝');
  logger.startup('                         ═══════ Router ═══════                     ');
  logger.startup('');

  // Check if we have tokens
  let tokens = await loadTokens();

  if (!tokens && !endpointConfig.allowBearerPassthrough) {
    // OAuth is required when bearer passthrough is disabled
    logger.startup('No OAuth tokens found. Starting authentication...');
    logger.startup('');

    try {
      const { code, verifier, state } = await startOAuthFlow(askQuestion);
      logger.startup('✅ Authorization received');
      logger.startup('🔄 Exchanging for tokens...\n');

      const newTokens = await exchangeCodeForTokens(code, verifier, state);
      await saveTokens(newTokens);
      tokens = newTokens;

      logger.startup('✅ Authentication successful!');
      logger.startup('');
    } catch (error) {
      logger.error('❌ Authentication failed:', error instanceof Error ? error.message : error);
      rl.close();
      process.exit(1);
    }
  } else {
    logger.startup('✅ OAuth tokens found.');
  }

  // Validate/refresh token (skip if no tokens and passthrough is enabled)
  if (tokens) {
    try {
      await getValidAccessToken();
      logger.startup('✅ Token validated.');
    } catch (error) {
      logger.error('❌ Token validation failed:', error);
      logger.info('Please delete .oauth-tokens.json and restart.');
      rl.close();
      process.exit(1);
    }
  } else if (endpointConfig.allowBearerPassthrough) {
    logger.startup('⚠️  No OAuth tokens - bearer passthrough mode only');
  }

  // Close readline interface since we don't need it anymore
  rl.close();

  logger.startup('');

  // Start the server
  app.listen(PORT, () => {
    logger.startup(`🚀 Router running on http://localhost:${PORT}`);
    logger.startup('');
    logger.startup('📋 Endpoints:');

    if (endpointConfig.anthropicEnabled) {
      logger.startup(`   POST http://localhost:${PORT}/v1/messages (Anthropic)`);
    }

    if (endpointConfig.openaiEnabled) {
      logger.startup(`   POST http://localhost:${PORT}/v1/chat/completions (OpenAI)`);
    }

    logger.startup(`   GET  http://localhost:${PORT}/health`);
    logger.startup('');

    if (endpointConfig.anthropicEnabled && endpointConfig.openaiEnabled) {
      logger.startup('💡 Both Anthropic and OpenAI endpoints are enabled');
    } else if (endpointConfig.openaiEnabled) {
      logger.startup(
        '💡 OpenAI compatibility mode - configure tools to use OpenAI Chat Completions API'
      );
    } else {
      logger.startup(
        '💡 Configure your AI tool to use http://localhost:' + PORT + ' as the base URL'
      );
    }

    if (ROUTER_API_KEY) {
      logger.startup('🔐 Authenticated proxy mode: ENABLED (ROUTER_API_KEY is set)');
      logger.startup('🔑 Bearer token passthrough: DISABLED - all requests use router OAuth');
    } else if (endpointConfig.allowBearerPassthrough) {
      logger.startup('🔑 Bearer token passthrough: ENABLED - clients can use their own API keys');
    } else {
      logger.startup('🔑 Bearer token passthrough: DISABLED - all requests use router OAuth');
    }

    logger.startup('');
  });
}

// Start the router
startRouter().catch((error) => {
  logger.error('Failed to start router:', error);
  process.exit(1);
});
