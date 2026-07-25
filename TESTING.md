# OpenAI Compatibility Testing Guide

This guide provides comprehensive testing steps for the OpenAI API compatibility feature.

## End-to-End Smoke Test

The router runs in a Docker container with port 3000 published. `tests/smoke.py` runs on your
machine and hits it. That is the whole setup.

The script uses only the Python 3 standard library, so there is nothing to install for it.

### Step 1: create the auth file (one time)

The router authenticates to Anthropic with OAuth tokens stored in a file called
`.oauth-tokens.json`. You never write this file by hand — the interactive CLI creates it. It
must never be committed, and is already covered by `.gitignore`.

```bash
npm install
npm start
```

In the menu:

1. Choose option **1** (Authenticate).
2. Copy the URL that is printed and open it in your browser yourself — it is not opened for
   you, despite what the prompt says.
3. Authorize. The page then shows a **code** and a **state** value.
4. Paste both back into the prompt joined by a `#`, like `code#state`.

You should see `✅ Tokens saved to .oauth-tokens.json`. Now choose option **6** to exit.

> Do not choose option 4. That is Logout, and it deletes the tokens you just created.

This is the only step that needs `npm install`, because the CLI runs through `tsx`.

### Step 2: give the auth file to the container

The container reads its credentials from `tmp/smoke/`, which is bind-mounted as the router's
working directory. Copy the file in:

```bash
mkdir -p tmp/smoke
cp .oauth-tokens.json tmp/smoke/
```

Do this again whenever you re-authenticate. The container refreshes the access token in place
inside `tmp/smoke/`, so you do not need to copy anything back.

A directory is mounted rather than the file itself on purpose: Docker silently creates a
*directory* when a bind-mounted file path does not exist on the host, which fails in confusing
ways.

### Step 3: start the router

```bash
docker compose -f compose.test.yml up router
```

Leave it running. It listens on `http://localhost:3000`.

If credentials are missing or invalid the container exits instead of starting — check its
output. Note that because `ROUTER_API_KEY` is set, bearer passthrough is disabled and valid
OAuth tokens are mandatory just to boot.

### Step 4: run the test

In another terminal:

```bash
ROUTER_API_KEY=smoke-test-key python3 tests/smoke.py
```

`smoke-test-key` is the default key the compose file gives the router. Pass the same value here
so the script can authenticate; override both with your own `ROUTER_API_KEY` if you prefer.

Five checks run, printing one line each:

1. `/health` is reachable **without** credentials
2. `/v1/messages` returns generated content
3. `/v1/messages` with `stream: true` returns a valid SSE stream
4. `/v1/chat/completions` (OpenAI-compatible) returns generated content
5. A wrong API key is rejected with 401

Exit code is 0 if everything passed, 1 otherwise. Raw response bodies are printed on failure.

Nothing asserts on what the model actually says — only that non-empty content came back with
HTTP 200. Model wording varies, and any content assertion would be a false negative waiting to
happen.

`ROUTER_URL` overrides the target if you are not on `http://localhost:3000`.

### Running without Docker

If you would rather run the router directly, `npm install` then:

```bash
# terminal 1
ROUTER_API_KEY=smoke-test-key npm run router

# terminal 2
ROUTER_API_KEY=smoke-test-key python3 tests/smoke.py
```

In this mode the router reads `.oauth-tokens.json` from the repository root, so no copying is
needed. Omit `ROUTER_API_KEY` from both commands to run unauthenticated — check 5 is then
skipped.

### A caveat about this test

It calls the live Anthropic API, so it needs working credentials and fails when Anthropic is
unreachable or your tokens have expired. Neither is a code defect. Run it by hand; never wire
it into CI as a gate.

## Quick Test (Recommended First Step)

### 1. Start the Router with OpenAI Endpoint

```bash
npm run router -- --enable-openai --verbose
```

The startup should show:
```
📋 Endpoints:
   POST http://localhost:3000/v1/chat/completions (OpenAI)
   GET  http://localhost:3000/health
```

### 2. Run Automated Tests (Node.js)

In a separate terminal:

```bash
node test-openai-endpoint.js
```

This will run 6 automated tests covering:
- Basic request/response translation
- Model mapping for various GPT models
- Streaming responses
- Error handling for unsupported features
- System prompt handling
- Health check endpoint

**Expected output:** All tests should pass with green checkmarks.

---

## Python OpenAI SDK Testing

### Prerequisites

Install the OpenAI Python SDK:
```bash
pip install openai
```

### Run Python Tests

```bash
python test-openai-sdk.py
```

This tests real-world compatibility with the official OpenAI SDK, including:
- Basic completions
- Streaming
- Multiple model names
- System messages
- Error handling

---

## Manual Testing Steps

### Test 1: Basic cURL Request

**PowerShell:**
```powershell
curl -X POST http://localhost:3000/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d '{
    "model": "claude-opus-4-5",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Say hello!"}
    ],
    "max_tokens": 50
  }'
```

**Bash/Linux/Mac:**
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-5",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Say hello!"}
    ],
    "max_tokens": 50
  }'
```

**Expected:**
- Status 200
- JSON response with OpenAI format
- `choices[0].message.content` contains Claude's response
- `usage` object with token counts

### Test 2: Model Mapping Verification

Run with different models and check router logs:

```bash
# Test claude-opus-4-5 → claude-opus-4-5
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-5", "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 10}'

# Test claude-opus-4-5 → claude-haiku-4-5
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-5", "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 10}'
```

**Check router logs for:**
- `Model: claude-opus-4-5` (for claude-opus-4-5)
- `Model: claude-haiku-4-5` (for claude-opus-4-5)

### Test 3: Streaming

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -N \
  -d '{
    "model": "claude-opus-4-5",
    "messages": [{"role": "user", "content": "Count to 3"}],
    "stream": true,
    "max_tokens": 50
  }'
```

**Expected:**
- Server-sent events stream
- Multiple `data: {...}` chunks
- Final `data: [DONE]` marker

### Test 4: Error Handling

Test unsupported parameter `n > 1`:
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4-5",
    "messages": [{"role": "user", "content": "Hello"}],
    "n": 2,
    "max_tokens": 50
  }'
```

**Expected:**
- Status 400 or 500
- Error message mentioning "Multiple completions"

### Test 5: Both Endpoints Simultaneously

Start router with both endpoints:
```bash
npm run router -- --enable-all-endpoints --verbose
```

Send requests to both:
```bash
# OpenAI endpoint
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-5", "messages": [{"role": "user", "content": "Hi from OpenAI"}], "max_tokens": 20}'

# Anthropic endpoint
curl -X POST http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-5", "messages": [{"role": "user", "content": "Hi from Anthropic"}], "max_tokens": 20}'
```

**Check router logs:**
- Should see `[OpenAI]` prefix for first request
- Should see `[Anthropic]` prefix for second request

---

## JavaScript/TypeScript SDK Testing

### Install OpenAI SDK
```bash
npm install openai
```

### Test Script

Create `test-openai.mjs`:
```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'not-used',
  baseURL: 'http://localhost:3000/v1',
});

async function test() {
  console.log('Testing basic completion...');
  const response = await client.chat.completions.create({
    model: 'claude-opus-4-5',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Say hello!' }
    ],
    max_tokens: 50
  });

  console.log('Response:', response.choices[0].message.content);
  console.log('Tokens:', response.usage);

  console.log('\nTesting streaming...');
  const stream = await client.chat.completions.create({
    model: 'claude-opus-4-5',
    messages: [{ role: 'user', content: 'Count to 3' }],
    stream: true,
    max_tokens: 50
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) process.stdout.write(content);
  }
  console.log('\n\nDone!');
}

test().catch(console.error);
```

Run:
```bash
node test-openai.mjs
```

---

## Custom Model Mapping Testing

### Test Environment Variable Override

```bash
ANTHROPIC_DEFAULT_MODEL=claude-haiku-4-5 npm run router -- --enable-openai --verbose
```

Send a request:
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-5", "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 10}'
```

**Check router logs:** Should show `Model: claude-haiku-4-5` (overridden)

### Test Custom Mappings File

Create `.router-mappings.json`:
```json
{
  "gpt-5-experimental": "claude-sonnet-4",
  "my-custom-model": "claude-haiku-4-5"
}
```

Start router:
```bash
npm run router -- --enable-openai --verbose
```

Test:
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "my-custom-model", "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 10}'
```

**Check router logs:** Should use mapping from file

---

## Logging Verification

Test different verbosity levels:

### Minimal
```bash
npm run router -- --enable-openai --minimal
```

**Expected output:**
```
[10:30:45] [OpenAI] ✓ 200 claude-opus-4-5 (in:28 out:19)
```

### Medium (default)
```bash
npm run router -- --enable-openai
```

**Expected output:**
```
[2025-11-15T10:30:45.123Z] [abc123] Incoming OpenAI request
  Model: claude-opus-4-5
  Max tokens: 1000
  ✓ Translated OpenAI → Anthropic format
  ✓ Injected required system prompt
  ✓ OAuth token validated
  → Forwarding to Anthropic API...
  ✓ Success (200)
  Tokens: input=28, output=19
```

### Verbose
```bash
npm run router -- --enable-openai --verbose
```

**Expected:** Full JSON request/response bodies

---

## Integration Testing with Real Tools

### Test with LangChain (Python)

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="claude-opus-4-5",
    api_key="not-used",
    base_url="http://localhost:3000/v1"
)

response = llm.invoke("Say hello!")
print(response.content)
```

### Test with LiteLLM

```python
import litellm

response = litellm.completion(
    model="claude-opus-4-5",
    messages=[{"role": "user", "content": "Hello!"}],
    api_base="http://localhost:3000/v1",
    api_key="not-used"
)

print(response.choices[0].message.content)
```

---

## Troubleshooting

### Router not starting
- Check: OAuth tokens present in `.oauth-tokens.json`
- Solution: Authenticate first with `npm run router`

### Endpoint validation error
- Error: "At least one endpoint must be enabled"
- Solution: Don't use both `--disable-anthropic` and `--disable-openai`

### Connection refused
- Check: Router is running on correct port
- Solution: Verify with `curl http://localhost:3000/health`

### Model mapping not working
- Check: Router logs in verbose mode
- Look for: "Model: claude-..." line showing actual model used

### Streaming not working
- Check: `stream: true` in request
- Check: Response headers include `text/event-stream`
- Solution: Use `-N` flag with curl for streaming

---

## Success Criteria

All tests pass when:

✅ Basic requests return valid OpenAI-format responses
✅ Model names are correctly mapped (check router logs)
✅ Streaming works with proper SSE format
✅ Unsupported features return helpful errors
✅ System prompts are properly combined
✅ Both endpoints work simultaneously
✅ Real OpenAI SDKs (Python/JavaScript) work without code changes
✅ Token usage is correctly reported
✅ Logging shows endpoint type at all verbosity levels

---

## Next Steps

After successful testing:

1. **Update package version** to 1.2.0
2. **Build for production**: `npm run build`
3. **Test npx**: `npx anthropic-max-router --enable-openai`
4. **Commit changes** with descriptive message
5. **Publish to npm** (if applicable)
6. **Update GitHub release notes**

---

## Reporting Issues

If you find bugs during testing:

1. Note the exact command used
2. Include router logs (with `--verbose`)
3. Include full error messages
4. Note your Node.js version: `node --version`
5. Note your OS and environment

Report at: https://github.com/nsxdavid/anthropic-max-router/issues
