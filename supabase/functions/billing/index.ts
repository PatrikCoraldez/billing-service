import { createClient } from "npm:@supabase/supabase-js@2.119.0";

type Item = { product_id: string; name: string; quantity: number; unit_price_cents: number };
type InvoiceInput = { order_id: string; currency: "PEN"; items: Item[]; total_cents: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const columns = "id,issuer_id,order_id,currency,items,total_cents,status,created_at";
const maxBytes = 32_768;

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k))) {
    fail(422, "VALIDATION_ERROR", `Campos requeridos y únicos: ${keys.join(", ")}`);
  }
}
function validate(value: unknown): InvoiceInput {
  exact(value, ["order_id", "currency", "items", "total_cents"]);
  if (typeof value.order_id !== "string" || !uuid.test(value.order_id) || value.currency !== "PEN") {
    fail(422, "VALIDATION_ERROR", "order_id debe ser UUID en minúsculas y currency debe ser PEN.");
  }
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 6) {
    fail(422, "VALIDATION_ERROR", "items debe contener entre 1 y 6 líneas.");
  }
  const seen = new Set<string>();
  const items: Item[] = value.items.map((item: unknown) => {
    exact(item, ["product_id", "name", "quantity", "unit_price_cents"]);
    if (typeof item.product_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item.product_id) ||
        seen.has(item.product_id) || typeof item.name !== "string" ||
        item.name.length < 1 || item.name.length > 200 || !item.name.trim() ||
        typeof item.quantity !== "number" || !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 || item.quantity > 5 ||
        typeof item.unit_price_cents !== "number" || !Number.isSafeInteger(item.unit_price_cents) ||
        item.unit_price_cents < 0 || item.unit_price_cents > 1_000_000_000) {
      fail(422, "VALIDATION_ERROR", "Línea inválida, producto repetido o entero fuera de rango.");
    }
    seen.add(item.product_id);
    return { product_id: item.product_id, name: item.name,
      quantity: item.quantity, unit_price_cents: item.unit_price_cents };
  }).sort((a, b) => a.product_id < b.product_id ? -1 : a.product_id > b.product_id ? 1 : 0);
  const total = items.reduce((sum, i) => sum + i.quantity * i.unit_price_cents, 0);
  if (typeof value.total_cents !== "number" || !Number.isSafeInteger(value.total_cents) || value.total_cents !== total) {
    fail(422, "VALIDATION_ERROR", "total_cents debe ser entero e igual a la suma de las líneas.");
  }
  return { order_id: value.order_id, currency: "PEN", items, total_cents: total };
}
async function readJson(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) fail(400, "BAD_JSON", "Falta el cuerpo JSON.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); fail(413, "PAYLOAD_TOO_LARGE", "Máximo 32768 bytes."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { fail(400, "BAD_JSON", "JSON mal formado."); }
}
function issuerFor(req: Request): string {
  let clients: unknown;
  try { clients = JSON.parse(Deno.env.get("BILLING_CLIENTS") ?? "{}"); }
  catch { fail(503, "CONFIG_ERROR", "Configuración del servicio incompleta."); }
  if (!clients || typeof clients !== "object" || Array.isArray(clients)) {
    fail(503, "CONFIG_ERROR", "Configuración del servicio incompleta.");
  }
  const entries = Object.entries(clients);
  if (!entries.length || entries.some(([id, token]) => !/^[a-z0-9_-]{1,40}$/.test(id) ||
      typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) ||
      new Set(entries.map(([, token]) => token)).size !== entries.length) {
    fail(503, "CONFIG_ERROR", "Configuración del servicio incompleta.");
  }
  const token = req.headers.get("X-Billing-Token") ?? "";
  const issuer = entries.find(([, expected]) => expected === token)?.[0];
  if (!issuer) fail(401, "UNAUTHORIZED", "Token ausente o inválido.");
  return issuer;
}
function database() {
  const url = Deno.env.get("SUPABASE_URL");
  const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
  const key = keys.default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) fail(503, "CONFIG_ERROR", "Faltan credenciales internas del servicio.");
  return createClient(url!, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
  });
}
function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}
function snapshot(row: Record<string, unknown>) {
  return { ...row, number: `DEMO-${row.id}` };
}

Deno.serve(async (req: Request) => {
  try {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/billing/health") {
      return response({ status: "ok", service: "billing", version: "1" });
    }
    const issuer = issuerFor(req);
    const match = path.match(/^\/billing\/invoices\/([0-9a-f-]{36})$/);
    if (req.method === "GET" && match && uuid.test(match[1])) {
      const { data, error } = await database().from("invoices").select(columns)
        .eq("issuer_id", issuer).eq("id", match[1]).maybeSingle();
      if (error) fail(503, "DEPENDENCY_UNAVAILABLE", "No se pudo consultar la factura.");
      if (!data) fail(404, "NOT_FOUND", "Factura no encontrada.");
      return response(snapshot(data));
    }
    if (path !== "/billing/invoices") fail(404, "NOT_FOUND", "Ruta no encontrada.");
    if (req.method !== "POST") return response({ error: { code: "METHOD_NOT_ALLOWED", message: "Usa POST." } }, 405, { Allow: "POST" });
    if ((req.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase() !== "application/json") {
      fail(415, "UNSUPPORTED_MEDIA_TYPE", "Usa Content-Type: application/json.");
    }
    const payload = validate(await readJson(req));
    if (req.headers.get("Idempotency-Key") !== payload.order_id) {
      fail(422, "VALIDATION_ERROR", "Idempotency-Key debe ser exactamente order_id.");
    }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(JSON.stringify(payload))))).map(b => b.toString(16).padStart(2, "0")).join("");
    const db = database();
    const { data, error } = await db.from("invoices").insert({
      ...payload, issuer_id: issuer, request_hash: hash,
    }).select(columns).single();
    if (!error) return response(snapshot(data), 201, { "X-Idempotent-Replay": "false" });
    if (error.code !== "23505") fail(503, "DEPENDENCY_UNAVAILABLE", "No se pudo guardar la factura.");
    const existing = await db.from("invoices").select(`${columns},request_hash`)
      .eq("issuer_id", issuer).eq("order_id", payload.order_id).single();
    if (existing.error) fail(503, "DEPENDENCY_UNAVAILABLE", "Reintenta con la misma clave y cuerpo.");
    const { request_hash, ...row } = existing.data;
    if (request_hash !== hash) fail(409, "IDEMPOTENCY_CONFLICT", "El pedido ya fue facturado con otro contenido.");
    return response(snapshot(row), 200, { "X-Idempotent-Replay": "true" });
  } catch (error) {
    if (error instanceof ApiError) return response({ error: { code: error.code, message: error.message } }, error.status);
    console.error("billing: fallo interno; no se registran tokens ni cuerpos");
    return response({ error: { code: "DEPENDENCY_UNAVAILABLE", message: "Servicio temporalmente no disponible." } }, 503);
  }
});
