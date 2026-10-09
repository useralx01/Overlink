"""PC Link predefined device connections; one JSON request on stdin per process.

The controller supplies the connection from its current-user protected settings,
never from a remote tool argument. Example configurations (secrets stay local):
  {"type":"http","base_url":"https://device.example","paths":["/status"],
   "methods":["GET"],"headers":{"Authorization":"Bearer ..."}}
  {"type":"mqtt","host":"broker.example","port":8883,"tls":true,
   "username":"...","password":"...","subscribe_topics":["status/#"],
   "publish_topics":["commands/set"]}
Actions: http_request, mqtt_subscribe, mqtt_publish. HTTP writes and MQTT publish
add top-level approved:true only after the controller permission gateway approves.
For a locally configured plaintext LAN device, allow_insecure_http or
allow_plaintext_mqtt must explicitly be true; HTTPS/MQTT TLS always verify certs.
"""
from __future__ import annotations

import base64
import ipaddress
import json
import queue
import re
import ssl
import sys
import threading
import time
from urllib.parse import urlsplit

MAX_REQUEST = 256 * 1024
MAX_RESPONSE = 256 * 1024
MAX_PAYLOAD = 32 * 1024
HTTP_METHODS = frozenset(("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"))


class DeviceError(Exception):
    def __init__(self, code, message, uncertain=False):
        super().__init__(message)
        self.code, self.uncertain = code, uncertain


def fail(code, message, uncertain=False):
    raise DeviceError(code, message, uncertain)


def integer(data, key, default, low, high):
    value = data.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        fail("invalid_argument", f"{key} must be an integer from {low} to {high}.")
    return value


def string(value, label, maximum=2048, empty=False):
    if not isinstance(value, str) or (not value and not empty) or len(value) > maximum or "\0" in value:
        fail("invalid_argument", f"Invalid {label}.")
    return value


def approved(request):
    if request.get("approved") is not True:
        fail("approval_required", "The local permission gateway must approve this device write.")


def http_plan(request):
    connection, args = request["connection"], request["args"]
    base = string(connection.get("base_url"), "configured base_url").rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        fail("invalid_configuration", "Configure an HTTP(S) base URL without credentials, query, or fragment.")
    if parsed.scheme == "http" and connection.get("allow_insecure_http") is not True:
        fail("invalid_configuration", "HTTPS is required unless plaintext HTTP is explicitly enabled in the local connection.")
    try:
        parsed.port
    except ValueError:
        fail("invalid_configuration", "Invalid configured HTTP port.")
    path = string(args.get("path"), "path")
    decoded = __import__("urllib.parse", fromlist=["unquote"]).unquote(path)
    if not path.startswith("/") or path.startswith("//") or any(c in path for c in "?#\\\r\n") or any(p in (".", "..") for p in decoded.split("/")):
        fail("invalid_argument", "Use an exact configured endpoint path without traversal, query, or fragment.")
    paths = connection.get("paths", [])
    if not isinstance(paths, list) or path not in paths:
        fail("endpoint_not_allowed", "This endpoint is not in the local device allowlist.")
    method = string(args.get("method", "GET"), "method", 12).upper()
    methods = connection.get("methods", ["GET", "HEAD"])
    if method not in HTTP_METHODS or not isinstance(methods, list) or method not in methods:
        fail("method_not_allowed", "This HTTP method is not enabled in the local connection.")
    if method not in ("GET", "HEAD"):
        approved(request)
    if "body" in args and "json" in args:
        fail("invalid_argument", "Specify body or json, not both.")
    if method in ("GET", "HEAD") and ("body" in args or "json" in args):
        fail("invalid_argument", "Read requests cannot include a request body.")
    headers = connection.get("headers", {})
    if not isinstance(headers, dict) or len(headers) > 30:
        fail("invalid_configuration", "Configured headers must be a small object.")
    for key, value in headers.items():
        if not isinstance(key, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}", key) or key.lower() in ("host", "content-length", "transfer-encoding") or not isinstance(value, str) or len(value) > 8192 or any(c in value for c in "\r\n\0"):
            fail("invalid_configuration", "Invalid configured HTTP header.")
    params = args.get("params", {})
    if not isinstance(params, dict) or len(params) > 40 or any(not isinstance(k, str) or len(k) > 200 or not isinstance(v, (str, int, float, bool)) for k, v in params.items()):
        fail("invalid_argument", "params must be a small object of scalar values.")
    body = args.get("body")
    if body is not None:
        string(body, "body", MAX_PAYLOAD, empty=True)
        if len(body.encode("utf-8")) > MAX_PAYLOAD:
            fail("invalid_argument", "Request body exceeds 32 KiB.")
    if "json" in args:
        try:
            encoded = json.dumps(args["json"], ensure_ascii=False, allow_nan=False).encode("utf-8")
        except (TypeError, ValueError, RecursionError):
            fail("invalid_argument", "json must be a valid JSON value.")
        if len(encoded) > MAX_PAYLOAD:
            fail("invalid_argument", "JSON request body exceeds 32 KiB.")
    timeout = integer(args, "timeout_seconds", 10, 1, 20)
    return {"url": base + path, "method": method, "headers": headers, "params": params, "body": body, "timeout": timeout, "writes": method not in ("GET", "HEAD")}


def http_request(request):
    plan = http_plan(request)
    import requests
    with requests.Session() as session:
        session.trust_env = False
        options = dict(headers=plan["headers"], params=plan["params"], timeout=plan["timeout"], allow_redirects=False, stream=True, verify=True)
        if plan["body"] is not None:
            options["data"] = plan["body"].encode("utf-8")
        if "json" in request["args"]:
            options["json"] = request["args"]["json"]
        try:
            with session.request(plan["method"], plan["url"], **options) as response:
                if 300 <= response.status_code < 400:
                    fail("redirect_refused", "The device returned a redirect; it was not followed.", plan["writes"])
                if response.headers.get("Content-Length", "").isdigit() and int(response.headers["Content-Length"]) > MAX_RESPONSE:
                    fail("response_too_large", "The device response exceeds 256 KiB.", plan["writes"])
                chunks, total = [], 0
                for chunk in response.iter_content(8192):
                    total += len(chunk)
                    if total > MAX_RESPONSE:
                        fail("response_too_large", "The device response exceeds 256 KiB.", plan["writes"])
                    chunks.append(chunk)
                payload = b"".join(chunks)
                content_type = response.headers.get("Content-Type", "")[:120]
                result = {"ok": response.ok, "status": response.status_code, "content_type": content_type, "bytes": len(payload)}
                if "json" in content_type.lower():
                    try:
                        result["body"] = json.loads(payload.decode("utf-8"))
                    except (ValueError, UnicodeDecodeError, RecursionError):
                        result["body"] = payload.decode("utf-8", errors="replace")
                elif not content_type or content_type.startswith("text/"):
                    result["body"] = payload.decode("utf-8", errors="replace")
                else:
                    result["base64"] = base64.b64encode(payload).decode("ascii")
                return result
        except requests.exceptions.SSLError:
            fail("tls_error", "The device TLS certificate could not be verified.", plan["writes"])
        except requests.exceptions.Timeout:
            fail("timeout", "The device request timed out. Check the device before repeating a write.", plan["writes"])
        except requests.exceptions.RequestException:
            fail("network_error", "The device request failed. Check the configured endpoint and connection.", plan["writes"])


def mqtt_plan(request):
    connection, args = request["connection"], request["args"]
    host = string(connection.get("host"), "configured MQTT host", 253)
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if not re.fullmatch(r"(?=.{1,253}\Z)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", host):
            fail("invalid_configuration", "Configure a broker hostname or IP address, without a URL or path.")
    tls = connection.get("tls", True)
    if not isinstance(tls, bool) or (not tls and connection.get("allow_plaintext_mqtt") is not True):
        fail("invalid_configuration", "MQTT TLS is required unless plaintext MQTT is explicitly enabled locally.")
    port = integer(connection, "port", 8883 if tls else 1883, 1, 65535)
    topic = string(args.get("topic"), "topic", 1024)
    if any(ord(c) < 32 for c in topic):
        fail("invalid_argument", "The MQTT topic contains a control character.")
    publishing = request["action"] == "mqtt_publish"
    allowed = connection.get("publish_topics" if publishing else "subscribe_topics", [])
    if not isinstance(allowed, list) or topic not in allowed:
        fail("topic_not_allowed", "This topic is not in the local device allowlist.")
    if publishing:
        approved(request)
        if "+" in topic or "#" in topic:
            fail("invalid_argument", "MQTT publish cannot use a wildcard topic.")
        payload = string(args.get("payload", ""), "payload", MAX_PAYLOAD, empty=True).encode("utf-8")
        if len(payload) > MAX_PAYLOAD:
            fail("invalid_argument", "MQTT payload exceeds 32 KiB.")
    else:
        payload = None
        parts = topic.split("/")
        if any(("+" in p and p != "+") or ("#" in p and (p != "#" or i != len(parts)-1)) for i, p in enumerate(parts)):
            fail("invalid_argument", "Invalid MQTT subscription filter.")
    return {"host": host, "port": port, "tls": tls, "topic": topic, "publish": publishing, "payload": payload, "qos": integer(args, "qos", 0, 0, 1), "seconds": integer(args, "timeout_seconds", 5, 1, 20 if publishing else 5), "maximum": integer(args, "max_messages", 10, 1, 25)}


def mqtt_request(request):
    plan = mqtt_plan(request)
    import paho.mqtt.client as mqtt
    connection = request["connection"]
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, clean_session=True, reconnect_on_failure=False)
    client.connect_timeout = min(plan["seconds"], 5)
    if "username" in connection:
        client.username_pw_set(string(connection["username"], "configured username", 2048), string(connection.get("password", ""), "configured password", 8192, empty=True))
    if plan["tls"]:
        ca = connection.get("ca_cert")
        if ca is not None:
            string(ca, "configured CA certificate path", 2048)
        client.tls_set(ca_certs=ca, cert_reqs=ssl.CERT_REQUIRED, tls_version=ssl.PROTOCOL_TLS_CLIENT)
    connected, subscribed = threading.Event(), threading.Event()
    messages, status = [], {"connection": None, "subscription": None, "bytes": 0}

    def on_connect(c, userdata, flags, reason, properties):
        status["connection"] = int(reason.value)
        connected.set()
    def on_subscribe(c, userdata, mid, reasons, properties):
        status["subscription"] = all(int(reason.value) < 128 for reason in reasons)
        subscribed.set()
    def on_message(c, userdata, message):
        if len(messages) >= plan["maximum"] or status["bytes"] + len(message.payload) > MAX_RESPONSE or len(message.payload) > MAX_PAYLOAD:
            return
        status["bytes"] += len(message.payload)
        messages.append({"topic": message.topic, "payload": message.payload.decode("utf-8", errors="replace"), "qos": message.qos, "retained": message.retain})
    client.on_connect, client.on_subscribe, client.on_message = on_connect, on_subscribe, on_message
    deadline = time.monotonic() + plan["seconds"]
    try:
        client.connect(plan["host"], plan["port"], keepalive=30)
        client.loop_start()
        if not connected.wait(max(0, deadline-time.monotonic())) or status["connection"] != 0:
            fail("connection_failed", "The MQTT broker did not accept the connection.")
        if plan["publish"]:
            retain = request["args"].get("retain", False)
            if not isinstance(retain, bool):
                fail("invalid_argument", "retain must be a boolean.")
            info = client.publish(plan["topic"], plan["payload"], qos=plan["qos"], retain=retain)
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                fail("publish_failed", "The MQTT publish failed. Check the device before retrying.", True)
            info.wait_for_publish(max(0.01, deadline-time.monotonic()))
            if not info.is_published():
                fail("timeout", "MQTT publish was not confirmed. Check the device before retrying.", True)
            return {"ok": True, "published": True, "topic": plan["topic"], "bytes": len(plan["payload"]), "qos": plan["qos"]}
        rc, _ = client.subscribe(plan["topic"], plan["qos"])
        if rc != mqtt.MQTT_ERR_SUCCESS or not subscribed.wait(max(0, deadline-time.monotonic())) or status["subscription"] is not True:
            fail("subscribe_failed", "The MQTT broker did not accept the subscription.")
        while time.monotonic() < deadline and len(messages) < plan["maximum"]:
            time.sleep(min(0.05, max(0, deadline-time.monotonic())))
        return {"ok": True, "messages": messages, "bytes": status["bytes"], "bounded": True}
    except DeviceError:
        raise
    except (OSError, ValueError, RuntimeError):
        fail("network_error", "The MQTT connection failed. Check the configured broker, TLS certificate, and credentials.", plan["publish"])
    finally:
        try:
            client.disconnect()
            client.loop_stop()
        except Exception:
            pass


def execute(request):
    if not isinstance(request, dict) or not isinstance(request.get("connection"), dict) or not isinstance(request.get("args", {}), dict):
        fail("invalid_argument", "Expected action, a local connection object, and args.")
    request = dict(request)
    request.setdefault("args", {})
    action = request.get("action")
    if action == "http_request" and request["connection"].get("type") in ("http", "api"):
        plan = http_plan(request)
        call, seconds, writes = http_request, plan["timeout"], plan["writes"]
    elif action in ("mqtt_publish", "mqtt_subscribe") and request["connection"].get("type") == "mqtt":
        plan = mqtt_plan(request)
        call, seconds, writes = mqtt_request, plan["seconds"], plan["publish"]
    else:
        fail("invalid_argument", "The action does not match the configured connection type.")
    # One operation per process. An absolute deadline also bounds slow streaming
    # responses or DNS/providers that ignore their individual socket timeouts.
    outcomes = queue.Queue(maxsize=1)
    def worker():
        try:
            outcomes.put((call(request), None))
        except Exception as error:
            outcomes.put((None, error))
    threading.Thread(target=worker, daemon=True).start()
    try:
        result, error = outcomes.get(timeout=seconds)
    except queue.Empty:
        fail("timeout", "The device operation reached its time limit. Check the device before repeating a write.", writes)
    if error:
        if isinstance(error, DeviceError):
            raise error
        fail("device_error", "The device operation failed. Check the local connection configuration.", writes)
    return result


def self_test():
    import unittest
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    class Handler(BaseHTTPRequestHandler):
        hits = []
        def log_message(self, *args): pass
        def do_GET(self):
            self.hits.append(self.path)
            if self.path == "/redirect":
                self.send_response(302); self.send_header("Location", "/secret"); self.end_headers(); return
            if self.path == "/large":
                self.send_response(200); self.send_header("Content-Length", str(MAX_RESPONSE+1)); self.end_headers(); return
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b'{"local_fixture":true}')
        def do_POST(self):
            self.hits.append("POST")
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b'{"write_fixture":true}')
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    fixture = {"type":"http", "base_url":f"http://127.0.0.1:{server.server_port}", "allow_insecure_http":True, "paths":["/status", "/redirect", "/large", "/write"], "methods":["GET","POST"]}
    def request(**args): return {"action":"http_request", "connection":fixture, "args":args}
    class Tests(unittest.TestCase):
        def test_local_http(self): self.assertTrue(execute(request(path="/status"))["body"]["local_fixture"])
        def test_redirect_refused(self):
            with self.assertRaises(DeviceError) as error: execute(request(path="/redirect"))
            self.assertEqual(error.exception.code, "redirect_refused"); self.assertNotIn("/secret", Handler.hits)
        def test_response_bound(self):
            with self.assertRaises(DeviceError): execute(request(path="/large"))
        def test_allowlist(self):
            with self.assertRaises(DeviceError): execute(request(path="/not-configured"))
        def test_url_override_and_traversal(self):
            for path in ("https://evil.example", "//evil.example", "/../status", "/%2e%2e/status", "/status?token=x"):
                with self.assertRaises(DeviceError): execute(request(path=path))
        def test_write_requires_gateway(self):
            with self.assertRaises(DeviceError) as error: execute(request(path="/write",method="POST",json={"fixture":True}))
            self.assertEqual(error.exception.code,"approval_required")
        def test_approved_local_write(self):
            r = request(path="/write",method="POST",json={"fixture":True}); r["approved"] = True
            self.assertTrue(execute(r)["body"]["write_fixture"])
        def test_default_tls(self):
            r = request(path="/status"); r["connection"] = dict(fixture); r["connection"].pop("allow_insecure_http")
            with self.assertRaises(DeviceError): http_plan(r)
            r = {"action":"mqtt_subscribe","connection":{"type":"mqtt","host":"broker.example","subscribe_topics":["status/#"]},"args":{"topic":"status/#"}}
            self.assertTrue(mqtt_plan(r)["tls"]); r["connection"]["tls"]=False
            with self.assertRaises(DeviceError): mqtt_plan(r)
        def test_mqtt_validation_without_network(self):
            r = {"action":"mqtt_publish","approved":True,"connection":{"type":"mqtt","host":"broker.example","publish_topics":["commands/set", "commands/#"]},"args":{"topic":"commands/set","payload":"fixture"}}
            self.assertEqual(mqtt_plan(r)["port"],8883); r["args"]["topic"]="commands/#"
            with self.assertRaises(DeviceError): mqtt_plan(r)
            r["args"]["topic"]="commands/set"; r.pop("approved")
            with self.assertRaises(DeviceError): mqtt_plan(r)
        def test_bounds(self):
            for args in ({"timeout_seconds":21}, {"timeout_seconds":True}, {"json":"x"*(MAX_PAYLOAD+1)}):
                with self.assertRaises(DeviceError): http_plan(request(path="/write",method="POST",**args) | {"approved":True})
    try:
        result = unittest.TextTestRunner(stream=sys.stderr, verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(Tests))
        return {"ok": result.wasSuccessful(), "tests":result.testsRun, "external_devices_contacted":False}
    finally:
        server.shutdown(); server.server_close()


def main():
    try:
        if "--self-test" in sys.argv:
            result = self_test()
        else:
            raw = sys.stdin.buffer.read(MAX_REQUEST+1)
            if len(raw) > MAX_REQUEST:
                fail("request_too_large", "The device request exceeds 256 KiB.")
            try:
                data = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError, RecursionError):
                fail("invalid_json", "Invalid JSON request.")
            result = execute(data)
    except DeviceError as error:
        result = {"ok":False,"error":{"code":error.code,"message":str(error)},"uncertain":error.uncertain}
    except Exception:
        result = {"ok":False,"error":{"code":"device_error","message":"The device operation failed. Check dependencies and the local configuration."}}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False)+"\n")
    if result.get("ok") is False:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
