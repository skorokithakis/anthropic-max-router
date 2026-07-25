#!/usr/bin/env python3
"""End-to-end smoke test for a running router.

Checks that real generated content comes back through both the Anthropic and OpenAI
endpoints. Nothing asserts on what the model actually says, deliberately: the question is
only "did a response arrive", so a non-empty string at the right JSON path alongside HTTP 200
is the whole bar. Do not add content matching here — model wording varies, and every such
assertion is a false negative waiting to happen.

Needs a running router and valid OAuth credentials. It talks to the live Anthropic API, so it
is not hermetic and must never be used as a CI gate.

Usage: python3 tests/smoke.py
Env:   ROUTER_URL (default http://localhost:3000), ROUTER_API_KEY (optional)
"""

import json
import os
import sys
import urllib.request


BASE_URL = os.environ.get("ROUTER_URL", "http://localhost:3000")
API_KEY = os.environ.get("ROUTER_API_KEY")
TIMEOUT = 30
failed = False


def report(number, passed, detail=""):
    global failed
    print(f"{'PASS' if passed else 'FAIL'} Check {number}{detail}")
    failed = failed or not passed


def raw_response(path, method="GET", body=None, headers=None):
    request_headers = headers or {}
    request = urllib.request.Request(
        BASE_URL + path, data=body, method=method, headers=request_headers
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return response.status, dict(response.headers), response.read().decode()
    except urllib.request.HTTPError as error:
        return error.code, dict(error.headers), error.read().decode()


def request(path, method="GET", payload=None, auth=True):
    headers = {"Content-Type": "application/json"}
    if API_KEY and auth:
        headers["x-api-key"] = API_KEY
    body = json.dumps(payload).encode() if payload is not None else None
    return raw_response(path, method, body, headers)


def parse(body):
    try:
        return json.loads(body)
    except (TypeError, ValueError):
        return None


def has_content(value):
    return isinstance(value, str) and bool(value.strip())


def check_health():
    try:
        status, _, body = request("/health", auth=False)
    except Exception as error:
        report(1, False, f" ({error}) — is the router running?")
        return False
    data = parse(body)
    passed = status == 200 and data is not None and data.get("status") == "ok"
    if not passed:
        print(f"Raw response: {body}")
    report(1, passed)
    return True


MESSAGE = {
    "model": "claude-haiku-4-5",
    "max_tokens": 16,
    "messages": [{"role": "user", "content": "Say hello."}],
}


def check_message():
    try:
        status, _, body = request("/v1/messages", "POST", MESSAGE)
        data = parse(body)
        content = data.get("content") if isinstance(data, dict) else None
        text = content[0].get("text") if content and isinstance(content[0], dict) else None
        print(f"  Reply: {text}")
        passed = status == 200 and has_content(text)
        if not passed:
            print(f"Raw response: {body}")
        report(2, passed)
    except Exception as error:
        report(2, False, f" ({error})")


def check_streaming():
    try:
        status, headers, body = request(
            "/v1/messages", "POST", {**MESSAGE, "stream": True}
        )
        text = ""
        stopped = False
        for event in body.replace("\r\n", "\n").split("\n\n"):
            data_lines = [line[5:].lstrip() for line in event.splitlines() if line.startswith("data:")]
            if not data_lines:
                continue
            try:
                data = json.loads("\n".join(data_lines))
            except ValueError:
                continue
            if data.get("type") == "content_block_delta":
                text += data.get("delta", {}).get("text", "")
            if data.get("type") == "message_stop":
                stopped = True
        print(f"  Reply: {text}")
        content_type = headers.get("Content-Type", "")
        passed = status == 200 and "text/event-stream" in content_type and has_content(text) and stopped
        if not passed:
            print(f"Raw response: {body}")
        report(3, passed)
    except Exception as error:
        report(3, False, f" ({error})")


def check_openai():
    try:
        payload = {"model": "gpt-3.5-turbo", "max_tokens": 16, "messages": MESSAGE["messages"]}
        status, _, body = request("/v1/chat/completions", "POST", payload)
        data = parse(body)
        choices = data.get("choices") if isinstance(data, dict) else None
        message = choices[0].get("message") if choices and isinstance(choices[0], dict) else None
        text = message.get("content") if isinstance(message, dict) else None
        print(f"  Reply: {text}")
        passed = status == 200 and has_content(text)
        if not passed:
            print(f"Raw response: {body}")
        report(4, passed)
    except Exception as error:
        report(4, False, f" ({error})")


def check_wrong_key():
    if not API_KEY:
        print("SKIP Check 5 (ROUTER_API_KEY is unset)")
        return
    try:
        status, _, body = raw_response(
            "/v1/messages",
            "POST",
            json.dumps(MESSAGE).encode(),
            {"Content-Type": "application/json", "x-api-key": API_KEY + "-wrong"},
        )
        data = parse(body)
        passed = status == 401 and data is not None and data.get("error", {}).get("type") == "authentication_error"
        if not passed:
            print(f"Raw response: {body}")
        report(5, passed)
    except Exception as error:
        report(5, False, f" ({error})")


if check_health():
    check_message()
    check_streaming()
    check_openai()
    check_wrong_key()

sys.exit(1 if failed else 0)
