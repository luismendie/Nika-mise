import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Avisos de Mercado Pago por las suscripciones del plan. No se confía en el cuerpo:
// se consulta cada suscripción o pago directo a Mercado Pago con el token de Nika.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESTADO: Record<string, string> = { authorized: "activo", paused: "pausado", cancelled: "cancelado", pending: "pendiente" };

async function aplicar(admin: any, pa: any) {
  const neg = String(pa.external_reference || "");
  if (!UUID.test(neg)) return;
  const { data: n } = await admin.from("nm_negocios").select("id,mp_preapproval,plan_hasta").eq("id", neg).maybeSingle();
  if (!n || (n.mp_preapproval && n.mp_preapproval !== pa.id)) return;
  const est = ESTADO[pa.status] || "pendiente";
  const upd: Record<string, unknown> = { plan_estado: est, mp_preapproval: pa.id };
  if (est === "activo") {
    const prox = pa.next_payment_date ? new Date(pa.next_payment_date).getTime() : Date.now() + 31 * 864e5;
    upd.plan_hasta = new Date(Math.max(prox + 5 * 864e5, n.plan_hasta ? new Date(n.plan_hasta).getTime() : 0)).toISOString();
    if (pa.reason) upd.plan = String(pa.reason).replace(/^Nika Mise · plan /, "").slice(0, 30);
  }
  await admin.from("nm_negocios").update(upd).eq("id", neg);
}

Deno.serve(async (req) => {
  const ok = () => new Response("ok", { status: 200 });
  try {
    const TOKEN = Deno.env.get("NIKA_MP_TOKEN");
    if (!TOKEN) return ok();
    const u = new URL(req.url);
    let id = u.searchParams.get("data.id") || u.searchParams.get("id") || "";
    let tipo = u.searchParams.get("type") || u.searchParams.get("topic") || "";
    if (req.method === "POST") { try { const b = await req.json(); id = id || String(b?.data?.id || ""); tipo = tipo || String(b?.type || b?.topic || ""); } catch { /* sin cuerpo */ } }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return ok();
    const mp = (p: string) => fetch("https://api.mercadopago.com" + p, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    if (tipo === "subscription_preapproval" || tipo === "preapproval") {
      const r = await mp(`/preapproval/${id}`); if (r.ok) await aplicar(admin, await r.json());
    } else if (tipo === "subscription_authorized_payment" || tipo === "authorized_payment") {
      const r = await mp(`/authorized_payments/${id}`); if (!r.ok) return ok();
      const ap = await r.json();
      const r2 = await mp(`/preapproval/${ap.preapproval_id}`); if (!r2.ok) return ok();
      const pa = await r2.json();
      const neg = String(pa.external_reference || "");
      if (UUID.test(neg)) {
        await admin.from("nm_pagos_plan").upsert({ negocio_id: neg, mp_id: String(ap.id), tipo: "cuota", monto: ap.transaction_amount, estado: ap.payment?.status || ap.status, detalle: { preapproval: pa.id, intento: ap.retry_attempt || 0 } }, { onConflict: "mp_id" });
        await aplicar(admin, pa);
      }
    }
  } catch (_) { /* siempre 200 */ }
  return ok();
});
