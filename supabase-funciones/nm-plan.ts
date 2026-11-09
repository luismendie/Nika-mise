import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Suscripción mensual del plan de Nika Mise con Mercado Pago (cuenta de Nika, no la del negocio).
// Acciones: suscribir (crea la suscripción y devuelve el link de pago), verificar (consulta el estado
// directo a Mercado Pago y actualiza el plan) y cancelar. El precio se calcula acá, nunca en el navegador.
const PLANES = [{ n: "Inicial", hasta: 2, precio: 29900 }, { n: "Crecimiento", hasta: 5, precio: 54900 }, { n: "Comercio", hasta: 10, precio: 89900 }];
const EXTRA = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

function precioPlan(emp: number) {
  emp = Math.max(1, Math.floor(emp || 1));
  const p = PLANES.find((x) => emp <= x.hasta);
  const base = p ? { plan: p.n, precio: p.precio } : { plan: "Empresa", precio: PLANES[PLANES.length - 1].precio + (emp - 10) * EXTRA };
  const iva = Math.max(0, Math.min(27, Number(Deno.env.get("NIKA_PLAN_IVA") || "0")));
  return { ...base, total: Math.round(base.precio * (1 + iva / 100)) };
}
const ESTADO: Record<string, string> = { authorized: "activo", paused: "pausado", cancelled: "cancelado", pending: "pendiente" };

async function aplicarPreapproval(admin: any, pa: any) {
  const neg = String(pa.external_reference || "");
  if (!UUID.test(neg)) return null;
  const { data: n } = await admin.from("nm_negocios").select("id,mp_preapproval,plan_hasta").eq("id", neg).maybeSingle();
  if (!n || (n.mp_preapproval && n.mp_preapproval !== pa.id)) return null;
  const est = ESTADO[pa.status] || "pendiente";
  const upd: Record<string, unknown> = { plan_estado: est, mp_preapproval: pa.id };
  if (est === "activo") {
    // acceso hasta el próximo cobro + 5 días de gracia; nunca se acorta lo ya pagado
    const prox = pa.next_payment_date ? new Date(pa.next_payment_date).getTime() : Date.now() + 31 * 864e5;
    const hasta = Math.max(prox + 5 * 864e5, n.plan_hasta ? new Date(n.plan_hasta).getTime() : 0);
    upd.plan_hasta = new Date(hasta).toISOString();
    if (pa.reason) upd.plan = String(pa.reason).replace(/^Nika Mise · plan /, "").slice(0, 30);
  }
  await admin.from("nm_negocios").update(upd).eq("id", neg);
  return { estado: est, hasta: upd.plan_hasta || n.plan_hasta };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const TOKEN = Deno.env.get("NIKA_MP_TOKEN");
    if (!TOKEN) return json({ error: "El cobro del plan todavía no está configurado. Escribinos por WhatsApp para activarlo." }, 503);
    const url = Deno.env.get("SUPABASE_URL")!;
    const user = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } }, auth: { persistSession: false } });
    const { data: u } = await user.auth.getUser();
    if (!u?.user) return json({ error: "Iniciá sesión de nuevo." }, 401);
    const b = await req.json().catch(() => ({}));
    const neg = String(b.negocio || "");
    if (!UUID.test(neg)) return json({ error: "Negocio inválido." }, 400);
    const { data: esDueno } = await user.rpc("nm_es_dueno", { n: neg });
    if (!esDueno) return json({ error: "Solo el dueño puede manejar el plan." }, 403);
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: n } = await admin.from("nm_negocios").select("id,nombre,empleados,mp_preapproval,plan_estado,plan_hasta,plan").eq("id", neg).maybeSingle();
    if (!n) return json({ error: "No encontramos el negocio." }, 404);
    const mp = (path: string, init: RequestInit = {}) => fetch("https://api.mercadopago.com" + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) } });

    if (b.accion === "verificar") {
      if (!n.mp_preapproval) return json({ estado: n.plan_estado, hasta: n.plan_hasta, plan: n.plan });
      const r = await mp(`/preapproval/${encodeURIComponent(n.mp_preapproval)}`);
      if (!r.ok) return json({ estado: n.plan_estado, hasta: n.plan_hasta, plan: n.plan });
      const res = await aplicarPreapproval(admin, await r.json());
      const { data: n2 } = await admin.from("nm_negocios").select("plan,plan_estado,plan_hasta").eq("id", neg).maybeSingle();
      return json({ estado: n2?.plan_estado, hasta: n2?.plan_hasta, plan: n2?.plan, ok: !!res });
    }
    if (b.accion === "cancelar") {
      if (!n.mp_preapproval) return json({ error: "No hay una suscripción activa." }, 400);
      const r = await mp(`/preapproval/${encodeURIComponent(n.mp_preapproval)}`, { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
      if (!r.ok) return json({ error: "Mercado Pago no respondió. Probá de nuevo en un rato." }, 502);
      await admin.from("nm_negocios").update({ plan_estado: "cancelado" }).eq("id", neg);
      return json({ estado: "cancelado", hasta: n.plan_hasta });
    }
    if (b.accion === "suscribir") {
      const email = String(b.email || u.user.email || "").trim().toLowerCase();
      if (!EMAIL.test(email)) return json({ error: "Escribí el mail de tu cuenta de Mercado Pago." }, 400);
      if (n.plan_estado === "activo" && n.mp_preapproval) return json({ error: "Tu plan ya está activo." }, 400);
      const pr = precioPlan(n.empleados);
      const back = String(Deno.env.get("NIKA_APP_URL") || "https://nika-mise.vercel.app") + "/?plan=volver";
      const r = await mp("/preapproval", { method: "POST", body: JSON.stringify({
        reason: `Nika Mise · plan ${pr.plan}`, external_reference: neg, payer_email: email, back_url: back, status: "pending",
        auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: pr.total, currency_id: "ARS" },
      }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.init_point) {
        const m = String(j?.message || "");
        return json({ error: /email|payer/i.test(m) ? "Mercado Pago no aceptó ese mail. Usá el mail con el que entrás a Mercado Pago." : "Mercado Pago no pudo crear la suscripción. Probá de nuevo en un rato." }, 502);
      }
      await admin.from("nm_negocios").update({ mp_preapproval: j.id, plan_estado: "pendiente", plan_monto: pr.total }).eq("id", neg);
      return json({ link: j.init_point, plan: pr.plan, monto: pr.total });
    }
    return json({ error: "Acción inválida." }, 400);
  } catch (_e) {
    return json({ error: "Error inesperado. Probá de nuevo." }, 500);
  }
});
