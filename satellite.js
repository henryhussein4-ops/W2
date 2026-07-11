/* ZAMA SATELLITE WORKER - World Of Discoveries
   One file for W2, W3, W4, W5. Paste into each account.
   W2 = full home (Vectorize RAG + R2 + video cron). W3-W5 = mirrors (endpoints only).
   Missing bindings are detected and reported cleanly, never crash. */

const VOICES = {
  "aura-asteria": { model: "@cf/deepgram/aura-1", speaker: "asteria" },
  "aura-luna":    { model: "@cf/deepgram/aura-1", speaker: "luna" },
  "aura-stella":  { model: "@cf/deepgram/aura-1", speaker: "stella" },
  "aura-athena":  { model: "@cf/deepgram/aura-1", speaker: "athena" },
  "aura-hera":    { model: "@cf/deepgram/aura-1", speaker: "hera" },
  "aura-orion":   { model: "@cf/deepgram/aura-1", speaker: "orion" },
  "aura-arcas":   { model: "@cf/deepgram/aura-1", speaker: "arcas" },
  "aura-perseus": { model: "@cf/deepgram/aura-1", speaker: "perseus" },
  "aura-angus":   { model: "@cf/deepgram/aura-1", speaker: "angus" },
  "aura-orpheus": { model: "@cf/deepgram/aura-1", speaker: "orpheus" },
  "aura-helios":  { model: "@cf/deepgram/aura-1", speaker: "helios" },
  "aura-zeus":    { model: "@cf/deepgram/aura-1", speaker: "zeus" },
  "melo":         { model: "@cf/myshell-ai/melotts", speaker: "" }
};
const CHAT_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/meta/llama-3.1-8b-instruct-fast"
];
const VISION_MODELS = [
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/llava-hf/llava-1.5-7b-hf"
];
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const IMGEDIT_MODEL = "@cf/runwayml/stable-diffusion-v1-5-img2img";
const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const EMBED_MODEL = "@cf/baai/bge-m3";
const RAG_THRESHOLD_DEFAULT = 0.55;
const RATE_LIMIT_PER_HOUR = 600;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json" }, CORS) });
}
function audioResp(bytes, mime) {
  return new Response(bytes, { status: 200, headers: Object.assign({ "Content-Type": mime || "audio/mpeg", "Cache-Control": "no-store" }, CORS) });
}
function b64ToBytes(b64) {
  const clean = String(b64 || "").includes(",") ? String(b64).split(",")[1] : String(b64 || "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
  return btoa(bin);
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function readBody(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

/* ---------- DB helpers (Firebase RTDB over REST) ---------- */
function db2Url(env, path, extra) {
  return String(env.DB2_URL || "").replace(/\/$/, "") + "/" + path + ".json?auth=" + encodeURIComponent(env.DB2_SECRET || "") + (extra || "");
}
async function db2Get(env, path) {
  if (!env.DB2_URL || !env.DB2_SECRET) return null;
  try { const r = await fetch(db2Url(env, path)); return r.ok ? await r.json() : null; } catch (e) { return null; }
}
async function db2Set(env, path, value) {
  if (!env.DB2_URL || !env.DB2_SECRET) return false;
  try { const r = await fetch(db2Url(env, path), { method: "PUT", body: JSON.stringify(value) }); return r.ok; } catch (e) { return false; }
}
async function db2Push(env, path, value) {
  if (!env.DB2_URL || !env.DB2_SECRET) return null;
  try {
    const r = await fetch(db2Url(env, path), { method: "POST", body: JSON.stringify(value) });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.name ? d.name : null;
  } catch (e) { return null; }
}
async function db2Delete(env, path) {
  if (!env.DB2_URL || !env.DB2_SECRET) return false;
  try { const r = await fetch(db2Url(env, path), { method: "DELETE" }); return r.ok; } catch (e) { return false; }
}
async function db1GetPublic(env, path) {
  if (!env.DB1_URL) return null;
  try {
    const r = await fetch(String(env.DB1_URL).replace(/\/$/, "") + "/" + path + ".json");
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

/* ---------- Auth: verify Firebase ID token from the Zama app ---------- */
async function verifyUser(env, idToken) {
  if (!idToken || !env.FB_API_KEY) return null;
  try {
    const key = "tok:" + (await sha256hex(idToken)).slice(0, 40);
    if (env.KV) {
      const cached = await env.KV.get(key);
      if (cached) return cached;
    }
    const r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + env.FB_API_KEY, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken })
    });
    if (!r.ok) return null;
    const d = await r.json();
    const uid = d && d.users && d.users[0] && d.users[0].localId;
    if (uid && env.KV) await env.KV.put(key, uid, { expirationTtl: 600 });
    return uid || null;
  } catch (e) { return null; }
}
async function rateLimited(env, uid) {
  if (!env.KV) return false;
  try {
    const hour = new Date().toISOString().slice(0, 13);
    const key = "rl:" + uid + ":" + hour;
    const cur = parseInt(await env.KV.get(key) || "0", 10) + 1;
    await env.KV.put(key, String(cur), { expirationTtl: 3900 });
    return cur > RATE_LIMIT_PER_HOUR;
  } catch (e) { return false; }
}

/* ---------- AI primitives ---------- */
async function aiToBytes(result) {
  if (result instanceof ReadableStream) {
    const buf = await new Response(result).arrayBuffer();
    return new Uint8Array(buf);
  }
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result instanceof Uint8Array) return result;
  if (result && typeof result === "object" && typeof result.audio === "string") return b64ToBytes(result.audio);
  if (result && typeof result === "object" && typeof result.image === "string") return b64ToBytes(result.image);
  return null;
}
async function runTTS(env, text, voice) {
  const v = VOICES[voice] || VOICES["aura-asteria"];
  const clean = String(text || "").slice(0, 1800);
  if (!clean.trim()) return null;
  try {
    let out;
    if (v.model === "@cf/myshell-ai/melotts") {
      out = await env.AI.run(v.model, { prompt: clean, lang: "en" });
    } else {
      out = await env.AI.run(v.model, { text: clean, speaker: v.speaker });
    }
    return await aiToBytes(out);
  } catch (e) { return null; }
}
async function runChat(env, messages, maxTok) {
  for (const model of CHAT_MODELS) {
    try {
      const r = await env.AI.run(model, { messages, max_tokens: Math.min(maxTok || 900, 2048) });
      const text = (r && (r.response || r.result || r.output_text || "")) || "";
      if (String(text).trim()) return { ok: true, text: String(text).trim(), model };
    } catch (e) {}
  }
  return { ok: false, text: "" };
}
async function runVisionOnFrame(env, prompt, frameB64) {
  const bytes = b64ToBytes(frameB64);
  for (const model of VISION_MODELS) {
    try {
      const r = await env.AI.run(model, { prompt: String(prompt).slice(0, 500), image: [...bytes], max_tokens: 400 });
      const text = (r && (r.response || r.description || r.result || "")) || "";
      if (String(text).trim()) return String(text).trim();
    } catch (e) {}
  }
  return "";
}
async function runEmbed(env, texts) {
  try {
    const r = await env.AI.run(EMBED_MODEL, { text: texts });
    if (r && r.data && Array.isArray(r.data)) return r.data;
    return null;
  } catch (e) { return null; }
}

/* ---------- Endpoint handlers ---------- */
async function handleTTS(env, body) {
  const bytes = await runTTS(env, body.text, String(body.voice || "aura-asteria"));
  if (!bytes || !bytes.length) return json({ ok: false, error: "tts_failed" });
  return audioResp(bytes, "audio/mpeg");
}
async function handleSTT(env, body) {
  try {
    const b64 = String(body.audio || "").includes(",") ? String(body.audio).split(",")[1] : String(body.audio || "");
    if (!b64) return json({ ok: false, error: "no_audio" });
    const r = await env.AI.run(STT_MODEL, { audio: b64 });
    const text = (r && (r.text || (r.result && r.result.text))) || "";
    return json({ ok: true, text: String(text).trim() });
  } catch (e) { return json({ ok: false, error: "stt_failed" }); }
}
async function handleImage(env, body) {
  try {
    const prompt = String(body.prompt || "").trim().slice(0, 900);
    if (!prompt) return json({ ok: false, error: "no_prompt" });
    const r = await env.AI.run(IMAGE_MODEL, { prompt, steps: 6 });
    const bytes = await aiToBytes(r);
    if (!bytes || !bytes.length) return json({ ok: false, error: "image_failed" });
    return json({ ok: true, image: bytesToB64(bytes), mime: "image/jpeg", text: "Here is your image." });
  } catch (e) { return json({ ok: false, error: "image_failed" }); }
}
async function handleImgEdit(env, body) {
  try {
    const prompt = String(body.prompt || "").trim().slice(0, 700);
    const src = b64ToBytes(body.image || "");
    if (!prompt || !src.length) return json({ ok: false, error: "need_prompt_and_image" });
    const r = await env.AI.run(IMGEDIT_MODEL, { prompt, image: [...src], strength: Math.min(Math.max(Number(body.strength) || 0.6, 0.2), 0.95), num_steps: 20 });
    const bytes = await aiToBytes(r);
    if (!bytes || !bytes.length) return json({ ok: false, error: "edit_failed" });
    return json({ ok: true, image: bytesToB64(bytes), mime: "image/png", text: "Here is your edited image." });
  } catch (e) { return json({ ok: false, error: "edit_failed" }); }
}
async function handleVision(env, body) {
  const frames = Array.isArray(body.frames) ? body.frames : (Array.isArray(body.images) ? body.images : []);
  if (!frames.length) return json({ ok: false, error: "no_frames" });
  const kind = String(body.kind || "image");
  const message = String(body.message || "Describe what you see.").slice(0, 600);
  const transcript = String(body.transcript || "").slice(0, 3000);
  const take = frames.slice(0, kind === "video" || kind === "camera" ? 6 : 4);
  const captions = [];
  for (let i = 0; i < take.length; i++) {
    const cap = await runVisionOnFrame(env, take.length > 1 ? "Describe this frame briefly and factually." : message, take[i]);
    if (cap) captions.push(take.length > 1 ? "Frame " + (i + 1) + ": " + cap : cap);
  }
  if (!captions.length) return json({ ok: false, error: "vision_failed" });
  if (take.length === 1 && !transcript) {
    return json({ ok: true, text: captions[0], kind });
  }
  const sys = "You are Zama, a warm helpful AI by World Of Discoveries in Zambia. You watched a " + (kind === "camera" ? "live camera feed" : kind === "video" ? "short video" : "set of images") + " for the user. Combine what was seen" + (transcript ? " and heard" : "") + " into one natural, direct answer to the user's request. Never mention frames, captions, or systems.";
  const userMsg = "The user asked: " + message + "\n\nWhat was seen:\n" + captions.join("\n") + (transcript ? "\n\nWhat was heard (audio transcript):\n" + transcript : "");
  const r = await runChat(env, [{ role: "system", content: sys }, { role: "user", content: userMsg }], 800);
  return json({ ok: true, text: r.ok ? r.text : captions.join(" "), kind });
}
async function handleChat(env, body) {
  let messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages) {
    messages = [{ role: "system", content: String(body.system || "You are Zama, a warm, honest, helpful AI assistant by World Of Discoveries in Zambia. Reply naturally to the user's newest message.").slice(0, 4000) }];
    const hist = Array.isArray(body.history) ? body.history.slice(-10) : [];
    for (const h of hist) {
      if (h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string") {
        messages.push({ role: h.role, content: h.content.slice(0, 3000) });
      }
    }
    messages.push({ role: "user", content: String(body.message || "").slice(0, 6000) });
  }
  messages = messages.slice(-16).map(m => ({ role: m.role === "system" ? "system" : (m.role === "assistant" ? "assistant" : "user"), content: String(m.content || "").slice(0, 6000) }));
  const r = await runChat(env, messages, Number(body.maxTokens) || 900);
  if (!r.ok) return json({ ok: false, error: "chat_failed" });
  return json({ ok: true, text: r.text, model: r.model });
}
async function handleEmbed(env, body) {
  const texts = Array.isArray(body.texts) ? body.texts.slice(0, 20).map(t => String(t).slice(0, 2000)) : [String(body.text || "").slice(0, 2000)];
  if (!texts[0]) return json({ ok: false, error: "no_text" });
  const vecs = await runEmbed(env, texts);
  if (!vecs) return json({ ok: false, error: "embed_failed" });
  return json({ ok: true, vectors: vecs });
}

/* ---------- RAG (W2 only: needs VEC binding + DB2) ---------- */
function chunkText(text, size, overlap) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const chunks = [];
  let i = 0;
  while (i < t.length && chunks.length < 200) {
    chunks.push(t.slice(i, i + size));
    i += size - overlap;
  }
  return chunks;
}
async function handleRagUpsert(env, uid, body) {
  if (!env.VEC) return json({ ok: false, error: "rag_not_on_this_worker" });
  const docId = String(body.docId || ("doc_" + Date.now())).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
  const source = String(body.source || "document").slice(0, 120);
  const kind = String(body.kind || "doc").slice(0, 20);
  const text = String(body.text || "");
  if (!text.trim()) return json({ ok: false, error: "no_text" });
  const chunks = chunkText(text, 900, 150);
  const ids = [];
  for (let i = 0; i < chunks.length; i += 10) {
    const batch = chunks.slice(i, i + 10);
    const vecs = await runEmbed(env, batch);
    if (!vecs) return json({ ok: false, error: "embed_failed", stored: ids.length });
    const items = [];
    for (let j = 0; j < batch.length; j++) {
      const id = uid.slice(0, 20) + "_" + docId + "_" + (i + j);
      items.push({ id, values: vecs[j], namespace: uid, metadata: { uid, docId, source, kind, idx: i + j } });
      await db2Set(env, "rag/" + uid + "/" + docId + "/" + (i + j), { t: batch[j], s: source, k: kind });
      ids.push(id);
    }
    await env.VEC.upsert(items);
  }
  await db2Set(env, "ragIndex/" + uid + "/" + docId, { source, kind, chunks: chunks.length, ts: Date.now() });
  return json({ ok: true, docId, chunks: chunks.length });
}
async function handleRagQuery(env, uid, body) {
  if (!env.VEC) return json({ ok: false, error: "rag_not_on_this_worker" });
  const q = String(body.query || "").trim().slice(0, 1200);
  if (!q) return json({ ok: false, error: "no_query" });
  const threshold = Math.min(Math.max(Number(body.threshold) || RAG_THRESHOLD_DEFAULT, 0.2), 0.95);
  const topK = Math.min(Math.max(Number(body.topK) || 4, 1), 8);
  const vecs = await runEmbed(env, [q]);
  if (!vecs) return json({ ok: false, error: "embed_failed" });
  let res;
  try {
    res = await env.VEC.query(vecs[0], { topK, namespace: uid, returnMetadata: true });
  } catch (e) { return json({ ok: false, error: "vector_query_failed" }); }
  const matches = [];
  for (const m of (res && res.matches ? res.matches : [])) {
    if (m.score < threshold) continue;
    const md = m.metadata || {};
    const row = await db2Get(env, "rag/" + uid + "/" + md.docId + "/" + md.idx);
    if (row && row.t) matches.push({ text: row.t, score: Math.round(m.score * 1000) / 1000, source: row.s || md.source || "", kind: row.k || md.kind || "" });
  }
  return json({ ok: true, matches, threshold });
}
async function handleRagDelete(env, uid, body) {
  if (!env.VEC) return json({ ok: false, error: "rag_not_on_this_worker" });
  const docId = String(body.docId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
  if (!docId) return json({ ok: false, error: "no_docId" });
  const meta = await db2Get(env, "ragIndex/" + uid + "/" + docId);
  const count = meta && meta.chunks ? meta.chunks : 0;
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(uid.slice(0, 20) + "_" + docId + "_" + i);
  try { if (ids.length) await env.VEC.deleteByIds(ids); } catch (e) {}
  await db2Delete(env, "rag/" + uid + "/" + docId);
  await db2Delete(env, "ragIndex/" + uid + "/" + docId);
  return json({ ok: true, deleted: count });
}

/* ---------- Nearby (Geoapify + Mapbox fallback) ---------- */
const PLACE_CATEGORIES = {
  hospital: "healthcare.hospital", clinic: "healthcare.clinic_or_praxis", pharmacy: "healthcare.pharmacy",
  doctor: "healthcare.clinic_or_praxis", dentist: "healthcare.dentist",
  church: "religion.place_of_worship.christianity", mosque: "religion.place_of_worship.islam",
  temple: "religion.place_of_worship", worship: "religion.place_of_worship",
  school: "education.school", university: "education.university", college: "education.college",
  restaurant: "catering.restaurant", cafe: "catering.cafe", bar: "catering.bar", food: "catering",
  hotel: "accommodation.hotel", lodge: "accommodation", guesthouse: "accommodation.guest_house",
  bank: "service.financial.bank", atm: "service.financial.atm",
  police: "service.police", fuel: "service.vehicle.fuel", petrol: "service.vehicle.fuel", garage: "service.vehicle.repair",
  market: "commercial.marketplace", supermarket: "commercial.supermarket", shop: "commercial", mall: "commercial.shopping_mall",
  park: "leisure.park", gym: "sport.fitness", stadium: "sport.stadium",
  bus: "public_transport.bus", airport: "airport", library: "education.library", post: "service.post"
};
function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}
async function handleNearby(env, body) {
  const lat = Number(body.lat), lon = Number(body.lon);
  const query = String(body.query || "").trim().toLowerCase().slice(0, 120);
  if (!isFinite(lat) || !isFinite(lon)) return json({ ok: false, error: "no_location" });
  if (!query) return json({ ok: false, error: "no_query" });
  const radius = Math.min(Math.max(Number(body.radius) || 8000, 500), 50000);
  const results = [];
  let cat = null;
  for (const k of Object.keys(PLACE_CATEGORIES)) { if (query.includes(k)) { cat = PLACE_CATEGORIES[k]; break; } }
  if (cat && env.GEOAPIFY_KEY) {
    try {
      const u = "https://api.geoapify.com/v2/places?categories=" + encodeURIComponent(cat) +
        "&filter=circle:" + lon + "," + lat + "," + radius + "&bias=proximity:" + lon + "," + lat +
        "&limit=12&apiKey=" + env.GEOAPIFY_KEY;
      const r = await fetch(u);
      if (r.ok) {
        const d = await r.json();
        for (const f of (d.features || [])) {
          const p = f.properties || {};
          results.push({ name: p.name || p.address_line1 || "Unnamed", address: p.address_line2 || p.formatted || "", lat: p.lat, lon: p.lon, km: distKm(lat, lon, p.lat, p.lon), category: p.categories ? p.categories[0] : cat });
        }
      }
    } catch (e) {}
  }
  if (!results.length && env.GEOAPIFY_KEY) {
    try {
      const u = "https://api.geoapify.com/v1/geocode/search?text=" + encodeURIComponent(query) +
        "&bias=proximity:" + lon + "," + lat + "&limit=10&apiKey=" + env.GEOAPIFY_KEY;
      const r = await fetch(u);
      if (r.ok) {
        const d = await r.json();
        for (const f of (d.features || [])) {
          const p = f.properties || {};
          results.push({ name: p.name || p.address_line1 || p.formatted || "Result", address: p.formatted || "", lat: p.lat, lon: p.lon, km: distKm(lat, lon, p.lat, p.lon), category: p.result_type || "place" });
        }
      }
    } catch (e) {}
  }
  if (!results.length && env.MAPBOX_KEY) {
    try {
      const u = "https://api.mapbox.com/geocoding/v5/mapbox.places/" + encodeURIComponent(query) + ".json?proximity=" + lon + "," + lat + "&limit=10&access_token=" + env.MAPBOX_KEY;
      const r = await fetch(u);
      if (r.ok) {
        const d = await r.json();
        for (const f of (d.features || [])) {
          const c = f.center || [0, 0];
          results.push({ name: f.text || "Result", address: f.place_name || "", lat: c[1], lon: c[0], km: distKm(lat, lon, c[1], c[0]), category: (f.place_type && f.place_type[0]) || "place" });
        }
      }
    } catch (e) {}
  }
  results.sort((a, b) => a.km - b.km);
  return json({ ok: true, query, results: results.slice(0, 12) });
}

/* ---------- Videos (Pexels catalog in DB2, fetched by cron) ---------- */
async function fetchPexelsBatch(env, topic) {
  if (!env.PEXELS_KEY) return null;
  try {
    const r = await fetch("https://api.pexels.com/videos/search?query=" + encodeURIComponent(topic || "nature") + "&per_page=10&size=medium", {
      headers: { "Authorization": env.PEXELS_KEY }
    });
    if (!r.ok) return null;
    const d = await r.json();
    const vids = [];
    for (const v of (d.videos || [])) {
      const files = (v.video_files || []).filter(f => f.file_type === "video/mp4").sort((a, b) => (a.width || 0) - (b.width || 0));
      const pick = files.find(f => (f.width || 0) >= 540) || files[files.length - 1];
      if (!pick) continue;
      vids.push({
        id: v.id, url: pick.link, thumb: v.image, w: pick.width || 0, h: pick.height || 0,
        duration: v.duration || 0, by: (v.user && v.user.name) || "Pexels creator", credit: v.url || "https://www.pexels.com", ts: Date.now()
      });
    }
    return vids;
  } catch (e) { return null; }
}
async function handleVideos(env, uid, isAdmin, url) {
  const refresh = url.searchParams.get("refresh") === "1";
  if (refresh && isAdmin) {
    const cfg = await db1GetPublic(env, "config") || {};
    const vids = await fetchPexelsBatch(env, cfg.videosTopic || "nature");
    if (!vids || !vids.length) return json({ ok: false, error: "pexels_failed" });
    await db2Set(env, "videos/latest", { list: vids, topic: cfg.videosTopic || "nature", ts: Date.now() });
    await db2Push(env, "videos/history", { count: vids.length, topic: cfg.videosTopic || "nature", ts: Date.now() });
    if (env.KV) await env.KV.delete("videos:latest");
    return json({ ok: true, videos: vids, refreshed: true });
  }
  if (env.KV) {
    const cached = await env.KV.get("videos:latest");
    if (cached) { try { return json({ ok: true, videos: JSON.parse(cached) }); } catch (e) {} }
  }
  const node = await db2Get(env, "videos/latest");
  const list = node && node.list ? node.list : [];
  if (env.KV && list.length) await env.KV.put("videos:latest", JSON.stringify(list), { expirationTtl: 1800 });
  return json({ ok: true, videos: list });
}

/* ---------- Keyless services (cached) ---------- */
async function cachedFetch(env, cacheKey, ttl, fn) {
  if (env.KV) {
    const c = await env.KV.get(cacheKey);
    if (c) { try { return JSON.parse(c); } catch (e) {} }
  }
  const fresh = await fn();
  if (fresh && env.KV) await env.KV.put(cacheKey, JSON.stringify(fresh), { expirationTtl: ttl });
  return fresh;
}
async function handleNews(env, url) {
  const topic = String(url.searchParams.get("q") || "Zambia").slice(0, 80);
  const data = await cachedFetch(env, "news:" + topic.toLowerCase(), 3600, async () => {
    try {
      const r = await fetch("https://api.gdeltproject.org/api/v2/doc/doc?query=" + encodeURIComponent(topic) + "&mode=ArtList&maxrecords=12&timespan=48H&format=json");
      if (!r.ok) return null;
      const d = await r.json();
      return (d.articles || []).map(a => ({ title: a.title || "", url: a.url || "", source: a.domain || "", image: a.socialimage || "", date: a.seendate || "" })).filter(a => a.title && a.url);
    } catch (e) { return null; }
  });
  if (!data) return json({ ok: false, error: "news_failed" });
  return json({ ok: true, topic, articles: data });
}
async function handleWeather(env, url) {
  const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
  if (!isFinite(lat) || !isFinite(lon)) return json({ ok: false, error: "no_location" });
  const data = await cachedFetch(env, "wx:" + lat.toFixed(2) + ":" + lon.toFixed(2), 1800, async () => {
    try {
      const r = await fetch("https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon + "&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=3&timezone=auto");
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  });
  if (!data) return json({ ok: false, error: "weather_failed" });
  return json({ ok: true, current: data.current || {}, daily: data.daily || {} });
}
async function handleCurrency(env, url) {
  const from = String(url.searchParams.get("from") || "USD").toUpperCase().slice(0, 3);
  const to = String(url.searchParams.get("to") || "ZMW").toUpperCase().slice(0, 3);
  const amount = Number(url.searchParams.get("amount")) || 1;
  const data = await cachedFetch(env, "fx:" + from + ":" + to, 3600, async () => {
    try {
      const r = await fetch("https://api.frankfurter.dev/v1/latest?base=" + from + "&symbols=" + to);
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  });
  if (!data || !data.rates || !isFinite(data.rates[to])) return json({ ok: false, error: "currency_failed" });
  const rate = data.rates[to];
  return json({ ok: true, from, to, rate, amount, converted: Math.round(amount * rate * 100) / 100, date: data.date || "" });
}
async function handleBooks(env, url) {
  const q = String(url.searchParams.get("q") || "").slice(0, 100);
  if (!q) return json({ ok: false, error: "no_query" });
  const data = await cachedFetch(env, "books:" + q.toLowerCase(), 86400, async () => {
    try {
      const r = await fetch("https://openlibrary.org/search.json?q=" + encodeURIComponent(q) + "&limit=6&fields=title,author_name,first_publish_year,cover_i,key");
      if (!r.ok) return null;
      const d = await r.json();
      return (d.docs || []).map(b => ({ title: b.title || "", author: (b.author_name && b.author_name[0]) || "", year: b.first_publish_year || "", cover: b.cover_i ? "https://covers.openlibrary.org/b/id/" + b.cover_i + "-M.jpg" : "", link: b.key ? "https://openlibrary.org" + b.key : "" }));
    } catch (e) { return null; }
  });
  if (!data) return json({ ok: false, error: "books_failed" });
  return json({ ok: true, books: data });
}
async function handleSports(env, url) {
  const team = String(url.searchParams.get("team") || "").slice(0, 60);
  if (!team) return json({ ok: false, error: "no_team" });
  const data = await cachedFetch(env, "sport:" + team.toLowerCase(), 3600, async () => {
    try {
      const tr = await fetch("https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=" + encodeURIComponent(team));
      if (!tr.ok) return null;
      const td = await tr.json();
      const t = td.teams && td.teams[0];
      if (!t) return { team: null };
      const [lastR, nextR] = await Promise.all([
        fetch("https://www.thesportsdb.com/api/v1/json/3/eventslast.php?id=" + t.idTeam),
        fetch("https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=" + t.idTeam)
      ]);
      const lastD = lastR.ok ? await lastR.json() : {};
      const nextD = nextR.ok ? await nextR.json() : {};
      const mapEv = e => ({ event: e.strEvent || "", date: e.dateEvent || "", score: (e.intHomeScore != null && e.intAwayScore != null) ? e.intHomeScore + " - " + e.intAwayScore : "", league: e.strLeague || "" });
      return {
        team: { name: t.strTeam, league: t.strLeague, badge: t.strBadge || "" },
        last: (lastD.results || []).slice(0, 3).map(mapEv),
        next: (nextD.events || []).slice(0, 3).map(mapEv)
      };
    } catch (e) { return null; }
  });
  if (!data) return json({ ok: false, error: "sports_failed" });
  if (!data.team) return json({ ok: false, error: "team_not_found" });
  return json({ ok: true, team: data.team, last: data.last, next: data.next });
}

/* ---------- Files (R2) ---------- */
async function handleFileUpload(env, uid, body) {
  if (!env.R2) return json({ ok: false, error: "files_not_on_this_worker" });
  try {
    const bytes = b64ToBytes(body.data || "");
    if (!bytes.length) return json({ ok: false, error: "no_data" });
    if (bytes.length > 8 * 1024 * 1024) return json({ ok: false, error: "too_large_8mb_max" });
    const mime = String(body.mime || "application/octet-stream").slice(0, 80);
    const safeName = String(body.name || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    const rand = (await sha256hex(uid + Date.now() + Math.random())).slice(0, 16);
    const key = uid.slice(0, 20) + "/" + Date.now() + "_" + rand + "_" + safeName;
    await env.R2.put(key, bytes, { httpMetadata: { contentType: mime } });
    return json({ ok: true, key, mime, size: bytes.length });
  } catch (e) { return json({ ok: false, error: "upload_failed" }); }
}
async function handleFileGet(env, url) {
  if (!env.R2) return json({ ok: false, error: "files_not_on_this_worker" });
  const key = url.searchParams.get("key") || "";
  if (!key) return json({ ok: false, error: "no_key" });
  try {
    const obj = await env.R2.get(key);
    if (!obj) return json({ ok: false, error: "not_found" }, 404);
    const headers = Object.assign({ "Content-Type": (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream", "Cache-Control": "public, max-age=86400" }, CORS);
    return new Response(obj.body, { status: 200, headers });
  } catch (e) { return json({ ok: false, error: "read_failed" }); }
}

/* ---------- Router ---------- */
const OPEN_PATHS = ["/health", "/file/get"];
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/health") {
      return json({ ok: true, worker: "zama-satellite", rag: !!env.VEC, files: !!env.R2, kv: !!env.KV, ts: Date.now() });
    }
    if (path === "/file/get") return handleFileGet(env, url);

    const body = request.method === "POST" ? await readBody(request) : {};
    const idToken = body.idToken || (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("idToken") || "";
    const uid = await verifyUser(env, idToken);
    if (!uid) return json({ ok: false, error: "auth_failed" }, 401);
    const isAdmin = !!env.ADMIN_UID && uid === env.ADMIN_UID;
    if (!isAdmin && await rateLimited(env, uid)) return json({ ok: false, error: "rate_limited" }, 429);

    try {
      switch (path) {
        case "/tts": return await handleTTS(env, body);
        case "/stt": return await handleSTT(env, body);
        case "/image": return await handleImage(env, body);
        case "/imgedit": return await handleImgEdit(env, body);
        case "/vision": return await handleVision(env, body);
        case "/chat": return await handleChat(env, body);
        case "/embed": return await handleEmbed(env, body);
        case "/rag/upsert": return await handleRagUpsert(env, uid, body);
        case "/rag/query": return await handleRagQuery(env, uid, body);
        case "/rag/delete": return await handleRagDelete(env, uid, body);
        case "/nearby": return await handleNearby(env, body);
        case "/videos": return await handleVideos(env, uid, isAdmin, url);
        case "/news": return await handleNews(env, url);
        case "/weather": return await handleWeather(env, url);
        case "/currency": return await handleCurrency(env, url);
        case "/books": return await handleBooks(env, url);
        case "/sports": return await handleSports(env, url);
        case "/file/upload": return await handleFileUpload(env, uid, body);
        default: return json({ ok: false, error: "unknown_endpoint", path }, 404);
      }
    } catch (e) {
      return json({ ok: false, error: "internal", detail: String(e && e.message || e).slice(0, 200) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    try {
      const cfg = await db1GetPublic(env, "config") || {};
      const fetchHour = Number.isFinite(Number(cfg.videosFetchHour)) ? Number(cfg.videosFetchHour) : 4;
      const nowHour = new Date().getUTCHours();
      if (nowHour !== fetchHour) return;
      const today = new Date().toISOString().slice(0, 10);
      if (env.KV) {
        const done = await env.KV.get("cron:videos:" + today);
        if (done) return;
      }
      const vids = await fetchPexelsBatch(env, cfg.videosTopic || "nature");
      if (vids && vids.length) {
        await db2Set(env, "videos/latest", { list: vids, topic: cfg.videosTopic || "nature", ts: Date.now() });
        await db2Push(env, "videos/history", { count: vids.length, topic: cfg.videosTopic || "nature", ts: Date.now() });
        if (env.KV) {
          await env.KV.put("cron:videos:" + today, "1", { expirationTtl: 90000 });
          await env.KV.delete("videos:latest");
        }
      }
    } catch (e) {}
  }
};
