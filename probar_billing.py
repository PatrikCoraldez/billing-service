"""Prueba el contrato por HTTP; no necesita librerías ni claves de Supabase."""
import copy
import getpass
import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.request import Request, urlopen

base = (os.getenv("BILLING_BASE_URL") or input("URL base terminada en /functions/v1/billing: ")).rstrip("/")
token_a = os.getenv("BILLING_TOKEN") or getpass.getpass("Token de tienda-a: ")
token_b = os.getenv("BILLING_PEER_TOKEN") or getpass.getpass("Token de tienda-b: ")
assert base.startswith("https://") or base.startswith("http://127.0.0.1:"), "Usa HTTPS; HTTP solo para prueba local."
assert token_a != token_b, "Usa dos tokens distintos."
passed = []

def call(method, path, body=None, token=token_a, key=None, raw=None, content_type="application/json"):
    headers = {"Content-Type": content_type}
    if token:
        headers["X-Billing-Token"] = token
    if key is not None:
        headers["Idempotency-Key"] = key
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = Request(base + path, data=data, headers=headers, method=method)
    try:
        result = urlopen(req, timeout=20)
    except HTTPError as error:
        result = error
    with result:
        return result.status, json.loads(result.read())

def check(label, condition):
    assert condition, "FALLÓ: " + label
    passed.append(label)
    print("PASA:", label)

order = {"order_id": str(uuid.uuid4()), "currency": "PEN", "items": [
    {"product_id": "p2", "name": "Cable demo", "quantity": 1, "unit_price_cents": 1000},
    {"product_id": "p1", "name": "Producto demo", "quantity": 2, "unit_price_cents": 2500}], "total_cents": 6000}
key = order["order_id"]
check("health (no prueba la BD)", call("GET", "/health", token="")[0] == 200)
check("sin token", call("POST", "/invoices", order, token="", key=key)[0] == 401)
status, invoice = call("POST", "/invoices", order, key=key)
check("crear factura persistida", status == 201 and invoice["total_cents"] == 6000 and invoice["issuer_id"] == "tienda-a")
status, repeated = call("POST", "/invoices", order, key=key)
check("reintento sin duplicar ni cambiar snapshot", status == 200 and repeated == invoice)
status, read = call("GET", "/invoices/" + invoice["id"])
check("consulta persistida", status == 200 and read == invoice)
changed = copy.deepcopy(order)
changed["items"][0]["name"] = "Otro nombre"
status, error = call("POST", "/invoices", changed, key=key)
check("conflicto con cuerpo diferente", status == 409 and error["error"]["code"] == "IDEMPOTENCY_CONFLICT")
for label, change in [
    ("rechaza booleano como cantidad", lambda x: x["items"][0].update(quantity=True)),
    ("rechaza string como cantidad", lambda x: x["items"][0].update(quantity="1")),
    ("rechaza total alterado", lambda x: x.update(total_cents=1)),
    ("rechaza issuer enviado en cuerpo", lambda x: x.update(issuer_id="tienda-b")),
]:
    invalid = copy.deepcopy(order)
    change(invalid)
    check(label, call("POST", "/invoices", invalid, key=key)[0] == 422)
check("exige clave igual al order_id", call("POST", "/invoices", order, key="otra-clave")[0] == 422)
check("no revela factura de otra tienda", call("GET", "/invoices/" + invoice["id"], token=token_b)[0] == 404)
status, peer = call("POST", "/invoices", order, token=token_b, key=key)
check("aísla mismo order_id entre tiendas", status == 201 and peer["id"] != invoice["id"] and peer["issuer_id"] == "tienda-b")
reordered = copy.deepcopy(order)
reordered["items"].reverse()
check("orden de líneas no cambia operación", call("POST", "/invoices", reordered, key=key) == (200, invoice))
concurrent = copy.deepcopy(order)
concurrent["order_id"] = str(uuid.uuid4())
with ThreadPoolExecutor(max_workers=5) as pool:
    results = list(pool.map(lambda _: call("POST", "/invoices", concurrent, key=concurrent["order_id"]), range(5)))
check("5 llamadas simultáneas producen una sola factura", sorted(s for s, _ in results) == [200, 200, 200, 200, 201] and len({r["id"] for _, r in results}) == 1)
check("JSON mal formado", call("POST", "/invoices", raw=b"{", key=key)[0] == 400)
check("Content-Type incorrecto", call("POST", "/invoices", order, key=key, content_type="text/plain")[0] == 415)
check("limita tamaño del cuerpo", call("POST", "/invoices", raw=b" " * 32769, key=key)[0] == 413)
print(f"\n{len(passed)}/{len(passed)} pruebas superadas. Estas pruebas crean 3 facturas sintéticas por ejecución.")
