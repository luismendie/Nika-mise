/* Nika Mise: la app se guarda en el equipo para abrir sin internet. Los datos van por Supabase (no se guardan acá). */
const V="nm-746b82c333";const APP=["/", "/lib/three.min.js", "/lib/jspdf.umd.min.js", "/lib/jsQR.js", "/lib/zxing.min.js", "/lib/xlsx.full.min.js", "/lib/supabase.js", "/lib/qrcode.js", "/manifest.webmanifest", "/icon-192.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(APP)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{const r=e.request;if(r.method!=="GET")return;const u=new URL(r.url);
 if(u.hostname.endsWith("supabase.co")||u.hostname.endsWith("mercadopago.com"))return;
 if(r.mode==="navigate"){e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(V).then(c=>c.put("/",cp));return res}).catch(()=>caches.match("/")));return}
 if(u.origin===location.origin||u.hostname==="fonts.googleapis.com"||u.hostname==="fonts.gstatic.com"){
  e.respondWith(caches.match(r).then(m=>m||fetch(r).then(res=>{if(res.ok){const cp=res.clone();caches.open(V).then(c=>c.put(r,cp))}return res})))}});
