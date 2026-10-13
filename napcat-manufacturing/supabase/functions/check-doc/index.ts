// Supabase Edge Function: check-doc
// Compares an uploaded PDF (Invoice or Tally WO) against the work order saved in the app,
// using the Claude API. The result is saved back on the document row and returned to the app.
//
// Secrets needed (Supabase → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   your Claude API key (starts with sk-ant-)
//   CLAUDE_MODEL        optional, defaults to claude-sonnet-5-5
//
// Deploy with "Verify JWT" turned OFF — the app signs in with its own users, and the function
// instead checks that the caller holds this project's API key (it can't read anything otherwise).

import { createClient } from "npm:@supabase/supabase-js@2";

function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const MODEL = Deno.env.get("CLAUDE_MODEL") || "claude-sonnet-5-5";
const BUCKET = "wo-docs";
const COOLDOWN_SEC = 20; // ignore double-clicks: a check younger than this is returned as-is

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// What Claude must send back — forced through a tool so the shape is always the same.
const REPORT_TOOL = {
  name: "report_check",
  description: "Report the result of comparing the PDF with the work order.",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        enum: ["match", "mismatch", "unclear"],
        description: "match = everything that can be compared agrees; mismatch = at least one real difference or missing item; unclear = PDF unreadable or not the right kind of document",
      },
      summary: { type: "string", description: "One or two plain-English sentences for the office staff. Name the differences, if any." },
      document: {
        type: "object",
        properties: {
          number: { type: "string" },
          date: { type: "string" },
          party: { type: "string", description: "Customer / party name as printed" },
          total_amount: { type: "string", description: "Grand total with currency, if printed" },
        },
      },
      checks: {
        type: "array",
        description: "One row per thing compared, in a sensible order (party, product, size, quantity, then each material).",
        items: {
          type: "object",
          properties: {
            item: { type: "string", description: "What was compared, e.g. 'Customer', 'Size', 'Qty', '32D PU Foam'" },
            work_order: { type: "string", description: "Value in the app work order ('—' if not there)" },
            document: { type: "string", description: "Value in the PDF ('—' if not there)" },
            status: { type: "string", enum: ["ok", "mismatch", "missing", "info"] },
            note: { type: "string" },
          },
          required: ["item", "work_order", "document", "status"],
        },
      },
    },
    required: ["verdict", "summary", "checks"],
  },
};

function woForPrompt(o: any) {
  return {
    work_order_no: o.num, date: o.date, brand: o.brand, model: o.model,
    customer: o.cust, city: o.city, agent: o.agent,
    size_inches: { length: o.L, breadth: o.W, height: o.H }, quantity: o.Q, delivery: o.delivery,
    raw_materials: (o.lines || []).map((l: any) => ({
      material: l.name, unit: l.unit,
      recommended_total: l.recommended, actual_total: l.entered ? l.actual : null,
      with_contingency: l.contingent,
    })),
    substitutions: o.subs || [],
  };
}

function instructions(kind: string, wo: any, others: any[]) {
  const common = `Work order from the factory app (JSON):\n${JSON.stringify(woForPrompt(wo), null, 1)}\n\n` +
    `Rules: ignore case, spacing, punctuation and harmless abbreviations (M/s, Pvt Ltd, &). ` +
    `Sizes may be written as 72x36x6, 72"x36"x6", in cm or mm — convert to inches before comparing (1 in = 2.54 cm), ` +
    `allow ±0.25 in. Report every comparison as a row in checks. Use status "info" for values only one side has and that ` +
    `are not expected on the other (e.g. price). Do not invent values you cannot read — say so and use verdict "unclear" if the PDF ` +
    `cannot be read or is not the right document. Be concise.`;
  if (kind === "invoice") {
    return `You are checking a SALES INVOICE (PDF, usually printed from Tally) for a mattress factory against the work order it was billed for.\n` +
      `Compare: customer/party name, brand and model of mattress, size (L×B×H), quantity. Extract invoice number, date, party and grand total.\n` +
      `If the invoice has several line items, pick the one(s) for this work order's product and size and mention unrelated lines as info.\n` +
      `Part-billing is allowed: other invoices already uploaded for this work order are ${JSON.stringify(others)}. ` +
      `Flag a mismatch if this invoice plus the others bill MORE than the work order quantity, or if model/size/customer differ.\n\n` + common;
  }
  return `You are checking a WORK ORDER ENTERED IN TALLY (PDF — a manufacturing journal / stock journal / job work order) against the original work order issued in the factory app.\n` +
    `Compare: work order reference (if printed), customer, model, size, quantity, and EVERY raw material line — name and quantity with unit (CFT / MTR / PCS / KG). ` +
    `For material quantities compare with actual_total when it is not null, otherwise recommended_total; also accept with_contingency. Allow ±2% for rounding. ` +
    `Flag materials that are in one but not the other, wrong material names/grades (e.g. 32D vs 40D), and wrong quantities.\n\n` + common;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY secret is not set in Supabase." }, 500);

  // The caller must present this project's key; we use it so the function sees exactly what the app sees.
  const key = req.headers.get("apikey") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!key) return json({ error: "Missing project key" }, 401);
  try { // when Supabase provides the project's publishable keys, the caller's key must be one of them
    const known = Object.values(JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}")) as string[];
    if (known.length && !known.includes(key) && !key.startsWith("eyJ")) return json({ error: "Unknown project key" }, 401);
  } catch { /* env not set: the database read below still rejects bad keys */ }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad request body" }, 400); }
  const docId = String(body?.docId || "");
  if (!docId) return json({ error: "docId is required" }, 400);

  const dRes = await sb.from("wo_docs").select("data").eq("id", docId).maybeSingle();
  if (dRes.error) return json({ error: "Could not read document: " + dRes.error.message }, 401);
  if (!dRes.data) return json({ error: "Document not found" }, 404);
  const doc = dRes.data.data;

  if (doc.check?.at && Date.now() - Date.parse(doc.check.at) < COOLDOWN_SEC * 1000) return json(doc.check);

  const oRes = await sb.from("orders").select("data").eq("id", doc.woId).maybeSingle();
  if (oRes.error || !oRes.data) return json({ error: "Work order not found for this document" }, 404);
  const wo = oRes.data.data;

  const f = await sb.storage.from(BUCKET).download(doc.path);
  if (f.error || !f.data) return json({ error: "Could not download the PDF: " + (f.error?.message || "") }, 500);
  const bytes = new Uint8Array(await f.data.arrayBuffer());
  if (bytes.length > 10 * 1024 * 1024) return json({ error: "PDF is larger than 10 MB" }, 413);

  // Other invoices for the same WO (for part-billing quantity totals)
  let others: any[] = [];
  if (doc.kind === "invoice") {
    const r = await sb.from("wo_docs").select("data").eq("wo_id", doc.woId).eq("kind", "invoice");
    others = (r.data || []).map((x: any) => x.data).filter((d: any) => d.id !== doc.id)
      .map((d: any) => ({ invoice_no: d.docNo, date: d.docDate, checked_summary: d.check?.summary || "not checked yet" }));
  }

  const resp = await fetch(Deno.env.get("ANTHROPIC_URL") || "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      tools: [REPORT_TOOL],
      tool_choice: { type: "tool", name: "report_check" },
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: encodeBase64(bytes) } },
          { type: "text", text: instructions(doc.kind, wo, others) +
              `\n\nThe office says this PDF's number is "${doc.docNo}" dated ${doc.docDate || "(not given)"}.` },
        ],
      }],
    }),
  });
  const out = await resp.json();
  if (!resp.ok) return json({ error: "Claude API error: " + (out?.error?.message || resp.status) }, 502);

  const tool = (out.content || []).find((c: any) => c.type === "tool_use");
  if (!tool) return json({ error: "Claude did not return a result" }, 502);

  const check = {
    ...tool.input,
    at: new Date().toISOString(),
    by: String(body?.by || "").slice(0, 60),
    model: MODEL,
    usage: out.usage,
  };
  const upd = await sb.from("wo_docs").update({ data: { ...doc, check } }).eq("id", docId);
  if (upd.error) console.error("save check", upd.error);
  return json(check);
});
