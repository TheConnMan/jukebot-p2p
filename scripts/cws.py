#!/usr/bin/env python3
"""Chrome Web Store API v2 helper.

status: print the published and submitted crx versions.
submit <zip>: upload the zip, wait until the upload succeeds, then submit
for review with publishType STAGED_PUBLISH.

Reads CWS_SERVICE_ACCOUNT_KEY (service account JSON) and CWS_PUBLISHER_ID.
Mints an access token with the JWT bearer flow from
https://developers.google.com/identity/protocols/oauth2/service-account#httprest
and scope https://www.googleapis.com/auth/chromewebstore.
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ITEM_ID = "ndapkngicjifglcgjeimindjgegplelh"
SCOPE = "https://www.googleapis.com/auth/chromewebstore"
TOKEN_URL = "https://oauth2.googleapis.com/token"
IN_PROGRESS = {"IN_PROGRESS", "UPLOAD_IN_PROGRESS"}


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def access_token(key_json):
    key = json.loads(key_json)
    now = int(time.time())
    header = b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = b64url(
        json.dumps(
            {
                "iss": key["client_email"],
                "scope": SCOPE,
                "aud": TOKEN_URL,
                "iat": now,
                "exp": now + 3600,
            }
        ).encode()
    )
    signing_input = f"{header}.{claims}".encode()
    with tempfile.NamedTemporaryFile("w", delete=False) as handle:
        handle.write(key["private_key"])
        key_path = handle.name
    try:
        os.chmod(key_path, 0o600)
        signed = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", key_path],
            input=signing_input,
            check=True,
            capture_output=True,
        )
    finally:
        os.unlink(key_path)
    assertion = signing_input.decode() + "." + b64url(signed.stdout)
    body = urllib.parse.urlencode(
        {
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        }
    ).encode()
    request = urllib.request.Request(TOKEN_URL, data=body, method="POST")
    payload = call(request)
    token = payload.get("access_token")
    if not token:
        fail("token response had no access_token")
    return token


def call(request):
    try:
        with urllib.request.urlopen(request) as response:
            raw = response.read().decode()
            code = response.status
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        fail(f"HTTP {error.code} {request.full_url}\n{raw}")
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        fail(f"HTTP {code} {request.full_url} was not JSON:\n{raw}")


def api(token, method, url, data=None, headers=None):
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    return call(request)


def publisher():
    publisher_id = os.environ.get("CWS_PUBLISHER_ID", "").strip()
    key_json = os.environ.get("CWS_SERVICE_ACCOUNT_KEY", "")
    if not publisher_id or not key_json.strip():
        fail("CWS_PUBLISHER_ID and CWS_SERVICE_ACCOUNT_KEY are required")
    return publisher_id, access_token(key_json)


def item_url(publisher_id, upload=False):
    host = "https://chromewebstore.googleapis.com/upload" if upload else "https://chromewebstore.googleapis.com"
    return f"{host}/v2/publishers/{publisher_id}/items/{ITEM_ID}"


def crx_versions(block):
    if not block:
        return []
    found = []
    for channel in block.get("distributionChannels") or []:
        version = channel.get("crxVersion")
        if version:
            found.append(version)
    return found


def status(publisher_id, token):
    return api(token, "GET", item_url(publisher_id) + ":fetchStatus")


def print_status(payload):
    published = crx_versions(payload.get("publishedItemRevisionStatus")) or ["none"]
    submitted = crx_versions(payload.get("submittedItemRevisionStatus")) or ["none"]
    print("published " + ", ".join(published))
    print("submitted " + ", ".join(submitted))


def wait_until_succeeded(publisher_id, token, upload_body):
    state = upload_body.get("uploadState", "")
    if state == "SUCCEEDED":
        return upload_body
    if state not in IN_PROGRESS:
        fail("upload did not succeed:\n" + json.dumps(upload_body))
    for _ in range(24):
        time.sleep(5)
        current = status(publisher_id, token)
        state = current.get("lastAsyncUploadState", "")
        if state == "SUCCEEDED":
            return current
        if state not in IN_PROGRESS:
            fail("upload did not succeed:\n" + json.dumps(current))
    fail("upload still in progress")


def submit(zip_path):
    publisher_id, token = publisher()
    data = Path(zip_path).read_bytes()
    uploaded = api(
        token,
        "POST",
        item_url(publisher_id, upload=True) + ":upload",
        data=data,
        headers={"Content-Type": "application/zip"},
    )
    wait_until_succeeded(publisher_id, token, uploaded)
    published = api(
        token,
        "POST",
        item_url(publisher_id) + ":publish",
        data=json.dumps({"publishType": "STAGED_PUBLISH"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    state = published.get("state", "")
    print(f"submitted state {state or 'unknown'}")
    if published.get("warningInfo"):
        print(json.dumps(published["warningInfo"]))


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "status":
        publisher_id, token = publisher()
        print_status(status(publisher_id, token))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "submit":
        submit(sys.argv[2])
        return
    fail("usage: cws.py status | cws.py submit <zip>")


if __name__ == "__main__":
    main()
