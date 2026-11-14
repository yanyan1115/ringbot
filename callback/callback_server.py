#!/usr/bin/env python3
"""WeCom self-built app callback: verify the signature, AES-decrypt, and drop incoming messages into a queue directory.

Listens on 127.0.0.1 only; the outside world reaches it through a cloudflared tunnel. Credentials are read from the env file
(WECOM_ENV) and never printed. Strict padding/length checks, AgentID must match, queue write failure returns 500.
Queue: <state>/inbox/<MsgId>.json (mode 600), picked up by the MCP channel plugin.
"""
import base64, hashlib, hmac, json, os, struct, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from defusedxml import ElementTree as ET

ENV_FILE = os.environ.get("WECOM_ENV", "/etc/wecom-agent/wecom.env")
INBOX = os.environ.get("WECOM_INBOX", "/var/lib/wecom-agent/inbox")
SEEN = os.path.join(os.path.dirname(INBOX), "seen-msgids")
PORT = int(os.environ.get("WECOM_PORT", "8765"))
PATH = "/wecom/callback"


def load_env(path):
    env = {}
    for line in open(path):
        if "=" in line and not line.startswith("#"):
            k, v = line.rstrip("\n").split("=", 1)
            env[k] = v
    return env


ENV = load_env(ENV_FILE)
CORP_ID = ENV["WECOM_CORP_ID"]
AGENT_ID = ENV["WECOM_AGENT_ID"]
TOKEN = ENV["WECOM_CALLBACK_TOKEN"]
AES_KEY = base64.b64decode(ENV["WECOM_ENCODING_AES_KEY"] + "=")
ALLOWED = {u for u in ENV.get("WECOM_ALLOWED_USERS", "").split(",") if u}


def signature(*parts):
    return hashlib.sha1("".join(sorted(parts)).encode()).hexdigest()


def decrypt(b64):
    data = base64.b64decode(b64)
    dec = Cipher(algorithms.AES(AES_KEY), modes.CBC(AES_KEY[:16])).decryptor()
    plain = dec.update(data) + dec.finalize()
    pad = plain[-1]
    if not 1 <= pad <= 32 or plain[-pad:] != bytes([pad]) * pad:
        raise ValueError("bad padding")
    plain = plain[:-pad]
    if len(plain) < 20:
        raise ValueError("too short")
    (n,) = struct.unpack(">I", plain[16:20])
    if 20 + n > len(plain):
        raise ValueError("bad length")
    msg, receiver = plain[20:20 + n], plain[20 + n:].decode()
    if not hmac.compare_digest(receiver, CORP_ID):
        raise ValueError("corp id mismatch")
    return msg.decode()


def load_seen():
    try:
        return set(open(SEEN).read().split())
    except FileNotFoundError:
        return set()


SEEN_IDS = load_seen()


def enqueue(fields):
    msgid = fields.get("MsgId") or f"evt-{fields.get('CreateTime', int(time.time()))}-{fields.get('Event', '')}"
    if msgid in SEEN_IDS:
        return False
    SEEN_IDS.add(msgid)
    with open(SEEN, "a") as f:
        f.write(msgid + "\n")
    tmp = os.path.join(INBOX, f".{msgid}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(fields, f, ensure_ascii=False)
    os.rename(tmp, os.path.join(INBOX, f"{msgid}.json"))
    return True


def log(msg):
    print(time.strftime("%F %T"), msg, file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # default logging includes the query string (signature etc.), so skip it

    def _reply(self, code, body=b""):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _query(self):
        u = urlparse(self.path)
        if u.path != PATH:
            return None
        return {k: v[0] for k, v in parse_qs(u.query).items()}

    def do_GET(self):
        q = self._query()
        if q is None or not all(k in q for k in ("msg_signature", "timestamp", "nonce", "echostr")):
            return self._reply(404)
        if not hmac.compare_digest(signature(TOKEN, q["timestamp"], q["nonce"], q["echostr"]), q["msg_signature"]):
            log("GET bad signature")
            return self._reply(403)
        try:
            plain = decrypt(q["echostr"])
        except Exception as e:
            log(f"GET decrypt failed: {type(e).__name__}")
            return self._reply(400)
        log("GET verify ok")
        self._reply(200, plain.encode())

    def do_POST(self):
        q = self._query()
        if q is None or not all(k in q for k in ("msg_signature", "timestamp", "nonce")):
            return self._reply(404)
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1 << 20:
            return self._reply(413)
        try:
            enc = ET.fromstring(self.rfile.read(n)).findtext("Encrypt") or ""
        except Exception:
            return self._reply(400)
        if not hmac.compare_digest(signature(TOKEN, q["timestamp"], q["nonce"], enc), q["msg_signature"]):
            log("POST bad signature")
            return self._reply(403)
        try:
            root = ET.fromstring(decrypt(enc))
        except Exception as e:
            log(f"POST decrypt failed: {type(e).__name__}")
            return self._reply(400)
        fields = {c.tag: (c.text or "") for c in root}
        if fields.get("AgentID") != AGENT_ID:
            log("POST agent id mismatch")
            return self._reply(200, b"success")
        if not ALLOWED:
            # setup mode: no whitelist yet -> show who wrote, queue nothing
            log(f"POST dropped (WECOM_ALLOWED_USERS empty), from={fields.get('FromUserName')}")
            return self._reply(200, b"success")
        if fields.get("FromUserName") not in ALLOWED:
            log("POST from non-allowed user, dropped")
            return self._reply(200, b"success")
        try:
            new = enqueue(fields)
        except Exception as e:
            log(f"queue write failed: {type(e).__name__}")
            return self._reply(500)  # let WeCom retry
        log(f"POST {fields.get('MsgType')} queued={new}")
        self._reply(200, b"success")


def main():
    os.makedirs(INBOX, mode=0o700, exist_ok=True)
    os.chmod(os.path.dirname(INBOX), 0o700)
    log(f"listening 127.0.0.1:{PORT}{PATH}")
    if not ALLOWED:
        log("WARNING: WECOM_ALLOWED_USERS is empty; every message is dropped and only its sender UserID is logged")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
