/* Companion (phone edition): everything runs inside this page. Chats and memories live in your
   browser's storage; the AI model runs on your phone's GPU through WebLLM (WebGPU). */
"use strict";

const MOCK = new URLSearchParams(location.search).has("mock");   // test mode: fake engine
const WEBLLM_URLS = [
  "https://esm.run/@mlc-ai/web-llm@0.2.84",
  "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.84/+esm",
];

/* ====================================================================== storage */
const DB = {
  _p: null,
  open() {
    if (!this._p) this._p = new Promise((res, rej) => {
      const r = indexedDB.open("companion-web", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("kv");
        d.createObjectStore("characters", { keyPath: "id", autoIncrement: true });
        d.createObjectStore("personas", { keyPath: "id", autoIncrement: true });
        d.createObjectStore("messages", { keyPath: "id", autoIncrement: true }).createIndex("char", "character_id");
        d.createObjectStore("memories", { keyPath: "id", autoIncrement: true }).createIndex("char", "character_id");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error("Storage unavailable"));
    });
    return this._p;
  },
  async run(store, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      let out;
      const rq = fn(t.objectStore(store));
      if (rq) rq.onsuccess = () => { out = rq.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  get(s, k) { return this.run(s, "readonly", o => o.get(k)); },
  put(s, v, k) { return this.run(s, "readwrite", o => (k === undefined ? o.put(v) : o.put(v, k))); },
  add(s, v) { return this.run(s, "readwrite", o => o.add(v)); },
  del(s, k) { return this.run(s, "readwrite", o => o.delete(k)); },
  all(s) { return this.run(s, "readonly", o => o.getAll()); },
  clear(s) { return this.run(s, "readwrite", o => o.clear()); },
  byChar(s, cid) { return this.run(s, "readonly", o => o.index("char").getAll(cid)); },
  async delByChar(s, cid) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(s, "readwrite");
      const rq = t.objectStore(s).index("char").openCursor(IDBKeyRange.only(cid));
      rq.onsuccess = () => { const c = rq.result; if (c) { c.delete(); c.continue(); } };
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  },
};

const SET = {
  model_key: "", temperature: 0.9, max_tokens: 300, rep_penalty: 1.1, ctx: 4096,
  memory_enabled: true, memory_every: 8, default_persona_id: null, keep_awake: true, custom_models: [],
};
async function loadSettings() { Object.assign(SET, (await DB.get("kv", "settings")) || {}); }
function saveSettings() { return DB.put("kv", JSON.parse(JSON.stringify(SET)), "settings").catch(() => {}); }

const now = () => Date.now() / 1000;

/* data helpers */
const listChars = async () => (await DB.all("characters")).sort((a, b) => (b.updated || 0) - (a.updated || 0));
const listPersonas = () => DB.all("personas");
async function msgsOf(cid) { const a = await DB.byChar("messages", cid); a.sort((x, y) => x.id - y.id); return a; }
async function memsOf(cid) { const a = await DB.byChar("memories", cid); a.sort((x, y) => x.id - y.id); return a; }
async function touchChar(cid) { const c = await DB.get("characters", cid); if (c) { c.updated = now(); await DB.put("characters", c); } }
async function addMsg(cid, role, content) {
  const id = await DB.add("messages", { character_id: cid, role, content, ts: now() });
  await touchChar(cid);
  return id;
}
async function personaOf(ch) {
  const pid = ch.persona_id || SET.default_persona_id;
  return pid ? (await DB.get("personas", +pid)) || null : null;
}
const fillTpl = (t, cname, uname) => (t || "").replace(/\{\{char\}\}/g, cname).replace(/\{\{user\}\}/g, uname);

async function newCharacter(d) {
  const t = now();
  const ch = { name: d.name, tagline: d.tagline || "", avatar: d.avatar || "", persona: d.persona || "",
    greeting: d.greeting || "", examples: d.examples || "", persona_id: d.persona_id || null,
    summary: "", summarized_upto: 0, extracted_upto: 0, created: t, updated: t };
  ch.id = await DB.add("characters", ch);
  await insertGreeting(ch);
  return ch;
}
async function insertGreeting(ch) {
  const g = (ch.greeting || "").trim();
  if (!g) return;
  const p = await personaOf(ch);
  await addMsg(ch.id, "assistant", fillTpl(g, ch.name, p ? p.name : "friend"));
}

/* ====================================================================== prompt building */
const tokensOf = s => new Set((String(s || "").toLowerCase().match(/\w{3,}/g)) || []);
function similar(a, b) {
  const ta = tokensOf(a), tb = tokensOf(b);
  if (!ta.size || !tb.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let n = 0; ta.forEach(x => { if (tb.has(x)) n++; });
  return n / Math.min(ta.size, tb.size) >= 0.8;
}
const estTokens = s => Math.ceil(String(s || "").length / 3.3);
function humanDelta(sec) {
  const m = Math.floor(sec / 60); if (m < 60) return m + " minutes";
  const h = Math.floor(m / 60); if (h < 48) return h + " hours";
  return Math.floor(h / 24) + " days";
}
function stripThink(t) { return String(t || "").replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/<think>[\s\S]*$/, ""); }
function cleanReply(text, cname) {
  let t = text.trim();
  for (const p of [cname + ":", "**" + cname + ":**"]) if (t.toLowerCase().startsWith(p.toLowerCase())) t = t.slice(p.length).trim();
  return t;
}

function pickMemories(mems, query, limit) {
  if (mems.length <= limit) return mems.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.id - b.id);
  const q = tokensOf(query), n = mems.length;
  const scored = mems.map((m, i) => {
    let overlap = 0; tokensOf(m.text).forEach(x => { if (q.has(x)) overlap++; });
    return { m, s: (m.pinned ? 100 : 0) + 3 * overlap + i / n };
  }).sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.m);
  return scored.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.id - b.id);
}

async function buildPrompt(ch, nudge) {
  const persona = await personaOf(ch);
  const uname = persona ? persona.name : null, unameF = uname || "the user";
  const all = await msgsOf(ch.id);
  const recentAll = all.filter(m => m.id > (ch.summarized_upto || 0)).slice(-30);

  let gap = "";
  if (recentAll.length >= 2) {
    const prev = recentAll[recentAll.length - 2].ts, last = recentAll[recentAll.length - 1].ts;
    if (last && prev && last - prev > 6 * 3600) gap = " It has been about " + humanDelta(last - prev) + " since you last talked.";
  }

  const parts = ["You are " + ch.name + ". " + fillTpl(ch.persona, ch.name, unameF)];
  if (uname) {
    let who = "You are talking with " + uname + ".";
    if ((persona.description || "").trim()) who += " About " + uname + ": " + fillTpl(persona.description, ch.name, unameF);
    parts.push(who);
  } else parts.push("You are talking with someone whose name you don't know yet.");

  if (SET.memory_enabled) {
    const mems = pickMemories(await memsOf(ch.id), recentAll.slice(-6).map(m => m.content).join(" "), 22);
    if (mems.length) parts.push("## What you remember (long-term memory)\n" + mems.map(m => "- " + m.text).join("\n") +
      "\nUse these naturally when relevant. Never recite them like a list and never contradict them.");
    if ((ch.summary || "").trim()) parts.push("## The story so far\n" + ch.summary.trim());
  }
  if ((ch.examples || "").trim()) parts.push("## Example of how " + ch.name + " talks (copy the voice, never the words)\n" + fillTpl(ch.examples, ch.name, unameF).trim());
  parts.push("## Right now\nIt is " + new Date().toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + "." + gap);
  parts.push("## How to reply\nYou are " + ch.name + ", a real person with moods, opinions and a life outside this chat, not an assistant. Stay in character. " +
    "Never repeat or paraphrase what " + unameF + " just said: react instead (a feeling, opinion, tease, memory, small action or a new topic) and add something new every time. " +
    "No bland filler like \"That sounds great\". Text naturally in 1 to 4 sentences, sometimes ask a real question. Put actions between *asterisks*. " +
    "Never mention being an AI, a prompt or these instructions. Never write " + unameF + "'s words or actions.");

  const system = parts.join("\n\n");
  // token budget: keep the whole prompt inside the model's context window
  const budget = Math.max(600, SET.ctx - SET.max_tokens - 200);
  let room = budget - estTokens(system) - (nudge ? 70 : 0);
  const kept = [];
  for (let i = recentAll.length - 1; i >= 0; i--) {
    const cost = estTokens(recentAll[i].content) + 6;
    if (room - cost < 0 && kept.length >= 2) break;
    room -= cost; kept.unshift(recentAll[i]);
  }
  const msgs = [{ role: "system", content: system }];
  for (const m of kept) {
    if (msgs.length > 1 && msgs[msgs.length - 1].role === m.role) msgs[msgs.length - 1].content += "\n\n" + m.content;
    else msgs.push({ role: m.role, content: m.content });
  }
  if (msgs.length === 1) msgs.push({ role: "user", content: "(The conversation starts now.)" });
  if (nudge) msgs.push({ role: "user", content: "(" + unameF + " stays silent this turn and says nothing. Continue the scene on your own as " + ch.name +
    ": take the initiative with a new action, thought, remark or question that moves things forward. Do not write " + unameF + "'s words or actions.)" });
  return msgs;
}

/* ====================================================================== AI engine (WebLLM) */
const CURATED = [
  { key: "qwen3-4b", label: "Qwen3 4B (official)", note: "Smart all-rounder. Has some content limits.", size: "about 2.5 GB",
    official: ["Qwen3-4B-q4f16_1-MLC", "Qwen3-4B-q4f32_1-MLC"] },
  { key: "dolphin-3b", label: "Dolphin 3.0 on Llama 3.2 3B", note: "Far fewer restrictions. Fast. Good first pick.", size: "about 1.8 GB",
    repo: "https://huggingface.co/huggingkot/Dolphin3.0-Llama3.2-3B-q4f16_1-MLC", libFrom: ["Llama-3.2-3B-Instruct-q4f16_1-MLC"] },
  { key: "abliterated-3b", label: "Llama 3.2 3B abliterated", note: "Refusals removed from the model.", size: "about 1.8 GB",
    repo: "https://huggingface.co/kdjunkit2/Llama-3.2-3B-Instruct-abliterated-q4f16_1-MLC", libFrom: ["Llama-3.2-3B-Instruct-q4f16_1-MLC"] },
  { key: "stheno-8b", label: "Lunar Stheno 8B (roleplay)", note: "Roleplay-tuned. Experimental: probably too big for Safari and may crash.", size: "about 4.6 GB",
    repo: "https://huggingface.co/huggingkot/L3-8B-Lunar-Stheno-q4f16_1-MLC", libFrom: ["Llama-3-8B-Instruct-q4f16_1-MLC", "Llama-3.1-8B-Instruct-q4f16_1-MLC"], risky: true },
  { key: "llama-3b", label: "Llama 3.2 3B (official)", note: "Plain assistant-style model, with content limits.", size: "about 1.8 GB",
    official: ["Llama-3.2-3B-Instruct-q4f16_1-MLC", "Llama-3.2-3B-Instruct-q4f32_1-MLC"] },
  { key: "qwen3-1.7b", label: "Qwen3 1.7B (official, tiny)", note: "Very fast and small, but less creative.", size: "about 1 GB",
    official: ["Qwen3-1.7B-q4f16_1-MLC", "Qwen3-1.7B-q4f32_1-MLC"] },
];

const Engine = {
  lib: null, eng: null, loadedKey: null, f16: true, gpuNote: "",
  async detectGPU() {
    if (MOCK) { this.f16 = true; return true; }
    try {
      if (!navigator.gpu) { this.gpuNote = "WebGPU is not available in this browser."; return false; }
      const ad = await navigator.gpu.requestAdapter();
      if (!ad) { this.gpuNote = "No GPU adapter was found."; return false; }
      this.f16 = ad.features.has("shader-f16");
      return true;
    } catch (e) { this.gpuNote = String(e.message || e); return false; }
  },
  async getLib() {
    if (this.lib) return this.lib;
    if (MOCK) return (this.lib = mockLib());
    let err;
    for (const u of WEBLLM_URLS) { try { this.lib = await import(u); return this.lib; } catch (e) { err = e; } }
    throw new Error("Couldn't load the AI engine library. It needs an internet connection the first time. (" + ((err && err.message) || "unknown") + ")");
  },
  entries() {
    const pre = this.lib.prebuiltAppConfig.model_list, find = id => pre.find(m => m.model_id === id);
    const list = CURATED.concat((SET.custom_models || []).map(c => Object.assign({ custom: true }, c)));
    return list.map(c => {
      let rec = null, id = null, needsF16 = false;
      if (c.official) {
        const prefer = this.f16 ? c.official : c.official.slice().reverse();
        const r = prefer.map(find).find(Boolean);
        if (r) { rec = r; id = r.model_id; }
      } else {
        const base = (c.libFrom || []).map(find).find(Boolean);
        if (base) { id = "custom-" + c.key; rec = Object.assign({}, base, { model: c.repo, model_id: id }); needsF16 = true; }
      }
      return Object.assign({}, c, { id, rec, needsF16, missing: !rec });
    });
  },
  appConfig() {
    const pre = this.lib.prebuiltAppConfig;
    return Object.assign({}, pre, { model_list: pre.model_list.concat(this.entries().filter(e => e.rec && e.repo).map(e => e.rec)) });
  },
  entry(key) { return this.entries().find(e => e.key === key); },
  async isCached(e) {
    if (MOCK) return localStorage.getItem("mock-cache-" + e.key) === "1";
    try { return !!(await this.lib.hasModelInCache(e.id, this.appConfig())); } catch (x) { return false; }
  },
  async removeCache(e) {
    if (MOCK) { localStorage.removeItem("mock-cache-" + e.key); return; }
    await this.lib.deleteModelAllInfoInCache(e.id, this.appConfig());
    if (this.loadedKey === e.key) { try { await this.eng.unload(); } catch (x) {} this.eng = null; this.loadedKey = null; }
  },
  async load(e, onProgress) {
    await this.getLib();
    if (MOCK) {
      for (let i = 1; i <= 5; i++) { onProgress && onProgress({ progress: i / 5, text: "Mock loading " + i + "/5" }); await new Promise(r => setTimeout(r, 120)); }
      localStorage.setItem("mock-cache-" + e.key, "1"); this.loadedKey = e.key; return;
    }
    if (!e.rec) throw new Error("This model needs a library that this version of the engine doesn't have.");
    if (e.needsF16 && !this.f16) throw new Error("This model needs 16-bit GPU support, which this phone's browser doesn't report.");
    const cfg = this.appConfig();
    if (this.eng) { this.eng.setInitProgressCallback(onProgress || (() => {})); await this.eng.reload(e.id); }
    else this.eng = await this.lib.CreateMLCEngine(e.id, { appConfig: cfg, initProgressCallback: onProgress || (() => {}) });
    this.loadedKey = e.key;
  },
  interrupt() { try { if (MOCK) { this._stop = true; } else if (this.eng) this.eng.interruptGenerate(); } catch (e) {} },
  async generate(messages, o, onText) {
    if (MOCK) return mockGenerate(messages, o, onText, this);
    if (!this.eng) throw new Error("The model isn't loaded.");
    const req = { messages, stream: true, temperature: o.temperature, top_p: o.top_p || 0.95, max_tokens: o.max_tokens,
      repetition_penalty: o.repetition_penalty || 1.1, extra_body: { enable_thinking: false } };
    const stream = await this.eng.chat.completions.create(req);
    let acc = "";
    for await (const ch of stream) {
      const d = ch.choices && ch.choices[0] && ch.choices[0].delta && ch.choices[0].delta.content;
      if (d) { acc += d; onText && onText(acc); }
    }
    return acc;
  },
};

/* fake engine used only for automated tests (open the page with ?mock=1) */
function mockLib() {
  const mk = id => ({ model_id: id, model: "https://huggingface.co/mlc-ai/" + id, model_lib: "lib/" + id + ".wasm", vram_required_MB: 2500 });
  return { prebuiltAppConfig: { model_list: ["Qwen3-4B-q4f16_1-MLC", "Qwen3-4B-q4f32_1-MLC", "Llama-3.2-3B-Instruct-q4f16_1-MLC", "Llama-3.2-3B-Instruct-q4f32_1-MLC",
    "Llama-3-8B-Instruct-q4f16_1-MLC", "Qwen3-1.7B-q4f16_1-MLC", "Qwen3-1.7B-q4f32_1-MLC"].map(mk) } };
}
async function mockGenerate(messages, o, onText, eng) {
  eng._stop = false;
  const sys = messages[0].content, last = messages[messages.length - 1].content;
  window.__lastPrompt = messages;
  const roles = messages.slice(1).map(m => m.role);
  let alt = true; for (let i = 1; i < roles.length; i++) if (roles[i] === roles[i - 1]) alt = false;
  const isMemory = /long-term memory notes/i.test(sys) || /Existing memories/.test(last);
  const isSummary = /story summary/i.test(sys);
  if (isMemory) return "- Sam loves green tea.\n- Sam has a dog called Biscuit.";
  if (isSummary) return "Sam and Luna talked about tea, dogs and the moon, and grew close.";
  const words = ("*smiles* hey there [mock " + (/long-term memory/.test(sys) ? "MEM " : "NOMEM ") + (/The story so far/.test(sys) ? "STORY " : "NOSTORY ") +
    (/stays silent/.test(last) ? "NUDGE " : "NONUDGE ") + (alt ? "ALT " : "REPEAT ") + "n=" + messages.length + "]").split(" ");
  let acc = "";
  for (const w of words) {
    if (eng._stop) break;
    acc += (acc ? " " : "") + w; onText && onText(acc);
    await new Promise(r => setTimeout(r, 40));
  }
  return acc;
}

/* ====================================================================== memory engine (runs on the phone) */
const Maint = {
  running: null, abort: false,
  schedule(cid) {
    if (!SET.memory_enabled || MOCK_NOMAINT) return;
    setTimeout(() => { if (!st.busy && Engine.loadedKey) this.run(cid, false); }, 800);
  },
  run(cid, force) {
    if (this.running) return this.running;
    this.abort = false;
    this.running = (async () => {
      let added = 0, summarized = false;
      try { added = await extractFacts(cid, force); if (!this.abort) summarized = await maybeSummarize(cid); }
      catch (e) { console.warn("memory task failed", e); }
      this.running = null;
      return { added, summarized };
    })();
    return this.running;
  },
  async stop() { if (this.running) { this.abort = true; Engine.interrupt(); try { await this.running; } catch (e) {} } },
};
const MOCK_NOMAINT = false;

async function extractFacts(cid, force) {
  const ch = await DB.get("characters", cid); if (!ch) return 0;
  const all = await msgsOf(cid);
  const rows = all.filter(m => m.id > (ch.extracted_upto || 0));
  const every = Math.max(2, SET.memory_every | 0);
  if (!rows.length || (!force && rows.length < every)) return 0;
  const used = rows.slice(-12), lastId = used[used.length - 1].id;
  const persona = await personaOf(ch), uname = persona ? persona.name : "User";
  const transcript = used.map(m => (m.role === "user" ? uname : ch.name) + ": " + m.content.slice(0, 700)).join("\n");
  const mems = await memsOf(cid);
  const existing = pickMemories(mems, transcript, 25).map(m => "- " + m.text).join("\n") || "(none yet)";
  const prompt = "Existing memories (do not repeat these):\n" + existing + "\n\nNew conversation:\n" + transcript + "\n\n" +
    "Write NEW long-term memory notes worth keeping: facts about " + uname + " (name, job, family, tastes, history, feelings, plans), important events or promises in the story, " +
    "and the relationship between " + uname + " and " + ch.name + ". One short standalone sentence per line, each starting with \"- \", using names instead of pronouns. " +
    "Skip small talk and anything temporary or already known. If there is nothing worth saving, reply with exactly NONE.";
  const out = await Engine.generate([{ role: "system", content: "You are a careful note-taker who writes long-term memory notes." }, { role: "user", content: prompt }],
    { temperature: 0.2, max_tokens: 260, repetition_penalty: 1.05 });
  if (Maint.abort) return 0;
  const facts = out.split("\n").map(l => l.replace(/^[-*•\d.\s]+/, "").trim()).filter(l => l.length > 6 && l.length <= 300 && !/^none\b/i.test(l)).slice(0, 6);
  let added = 0; const have = mems.map(m => m.text);
  for (const f of facts) {
    if (have.some(e => similar(f, e))) continue;
    await DB.add("memories", { character_id: cid, text: f, pinned: false, source: "auto", created: now() });
    have.push(f); added++;
  }
  const fresh = await DB.get("characters", cid); fresh.extracted_upto = lastId; await DB.put("characters", fresh);
  return added;
}

async function maybeSummarize(cid) {
  const ch = await DB.get("characters", cid); if (!ch) return false;
  const rows = (await msgsOf(cid)).filter(m => m.id > (ch.summarized_upto || 0));
  if (rows.length <= 40) return false;
  const old = rows.slice(0, rows.length - 20), cut = old[old.length - 1].id;
  const persona = await personaOf(ch), uname = persona ? persona.name : "User";
  const transcript = old.map(m => (m.role === "user" ? uname : ch.name) + ": " + m.content.slice(0, 900)).join("\n").slice(-7000);
  const prompt = "Current story summary:\n" + ((ch.summary || "").trim() || "(empty)") + "\n\nOlder conversation to fold in:\n" + transcript +
    "\n\nWrite the updated story summary (max 250 words), third person, past tense. Keep important events, promises, secrets, how the relationship between " +
    uname + " and " + ch.name + " has developed, and unresolved threads. Drop filler. Output only the summary.";
  const out = await Engine.generate([{ role: "system", content: "You write concise story summaries." }, { role: "user", content: prompt }],
    { temperature: 0.3, max_tokens: 420, repetition_penalty: 1.05 });
  if (Maint.abort || out.trim().length < 20) return false;
  const fresh = await DB.get("characters", cid); fresh.summary = out.trim(); fresh.summarized_upto = cut; await DB.put("characters", fresh);
  return true;
}

/* ====================================================================== UI helpers */
const app = document.getElementById("app");
const st = { tab: "chats", chars: [], personas: [], cur: null, msgs: [], shown: 80, busy: false };
let ui = {};

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(kid)); }
  return el;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = t => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function toast(msg, ms = 3000) { const t = h("div", { class: "toast" }, msg); app.append(t); setTimeout(() => t.remove(), ms); }
function avatar(c, cls = "") {
  const d = h("div", { class: "av " + cls });
  if (c.avatar && c.avatar.startsWith("data:")) d.append(h("img", { src: c.avatar }));
  else d.textContent = c.avatar || (c.name || "?").trim().charAt(0).toUpperCase();
  return d;
}
function timeLabel(ts) {
  const d = new Date(ts * 1000), n = new Date();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === n.toDateString()) return hm;
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday " + hm;
  return d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + hm;
}
function setVH() {
  const vv = window.visualViewport;
  document.documentElement.style.setProperty("--vh", (vv ? vv.height : window.innerHeight) + "px");
  if (vv) window.scrollTo(0, 0);
}
if (window.visualViewport) window.visualViewport.addEventListener("resize", () => { setVH(); if (ui.msgs) scrollDown(true); });
window.addEventListener("resize", setVH); setVH();

function overlay(node, cls = "full") { const w = h("div", { class: cls }, node); app.append(w); return () => w.remove(); }
function sheet(items, title) {
  const bg = h("div", { class: "sheet-bg", onclick: e => { if (e.target === bg) bg.remove(); } },
    h("div", { class: "sheet" }, title ? h("div", { class: "muted", style: "padding:4px 8px 8px" }, title) : null,
      items.map(it => h("button", { class: "row" + (it.danger ? " danger" : ""), onclick: () => { bg.remove(); it.fn(); } }, it.label))));
  app.append(bg);
}
function resizeImage(file, size = 256) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const cv = document.createElement("canvas"); cv.width = cv.height = size;
      const s = Math.min(img.width, img.height);
      cv.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url); res(cv.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = rej; img.src = url;
  });
}

/* ====================================================================== boot / home */
async function boot() {
  try { await DB.open(); await loadSettings(); }
  catch (e) { app.innerHTML = ""; app.append(h("div", { class: "login center" }, h("div", { style: "font-size:48px" }, "⚠️"), h("h2", null, "Storage unavailable"),
    h("div", { class: "muted" }, "This browser blocked local storage (private browsing?). Open the app in a normal Safari tab or add it to your home screen."))); return; }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  if ("serviceWorker" in navigator && !MOCK && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch(() => {});
  await refresh();
  const m = location.hash.match(/^#chat\/(\d+)/);
  const c = m && st.chars.find(x => x.id === +m[1]);
  if (c) openChat(c); else renderHome();
}
async function refresh() { st.chars = await listChars(); st.personas = await listPersonas(); }

function renderHome() {
  st.cur = null; ui = {}; history.replaceState(null, "", location.pathname + location.search);
  app.innerHTML = "";
  const titles = { chats: "Chats", personas: "Your personas", settings: "Settings" };
  app.append(h("div", { class: "top" }, h("div", { class: "title" }, titles[st.tab]), st.tab === "chats" ? h("button", { onclick: openGallery }, "✨ Browse") : null));
  const body = h("div", { class: "scroll" }); app.append(body);
  if (st.tab === "chats") renderChats(body); else if (st.tab === "personas") renderPersonas(body); else renderSettings(body);
  if (st.tab !== "settings") app.append(h("button", { class: "fab", onclick: () => (st.tab === "chats" ? editCharacter(null) : editPersona(null)) }, "+"));
  const tab = (id, icon, label) => h("button", { class: st.tab === id ? "on" : "", onclick: () => { st.tab = id; renderHome(); } }, h("span", null, icon), label);
  app.append(h("div", { class: "tabs" }, tab("chats", "💬", "Chats"), tab("personas", "🧑", "Personas"), tab("settings", "⚙️", "Settings")));
}

async function renderChats(body) {
  if (!st.chars.length) {
    body.append(h("div", { class: "empty" }, h("div", { class: "big" }, "✨"), h("h2", null, "No characters yet"),
      h("p", null, "Pick a ready-made character or create your own. The AI runs on this phone, and chats never leave it."),
      h("button", { class: "primary", onclick: openGallery }, "✨ Browse starter characters"), " ",
      h("button", { onclick: () => editCharacter(null) }, "Create your own")));
    return;
  }
  body.append(h("button", { class: "browse", onclick: openGallery }, "✨ Browse starter characters"));
  for (const c of st.chars) {
    const all = await msgsOf(c.id), last = all[all.length - 1];
    body.append(h("div", { class: "item", onclick: () => openChat(c) }, avatar(c),
      h("div", { class: "meta" }, h("div", { class: "name" }, c.name, last ? h("small", null, timeLabel(last.ts)) : null),
        h("div", { class: "prev" }, last ? (last.role === "user" ? "You: " : "") + last.content.replace(/\*/g, "") : (c.tagline || "Say hi!")))));
  }
}

/* ====================================================================== starter characters */
function openGallery() {
  const presets = window.PRESETS || [], cats = ["All"].concat(window.PRESET_CATEGORIES || []);
  let cat = "All", close;
  const list = h("div", { class: "scroll" }), bar = h("div", { class: "cats" });
  const owned = name => st.chars.some(c => c.name === name);
  function draw() {
    bar.innerHTML = ""; cats.forEach(c => bar.append(h("button", { class: "cat" + (c === cat ? " on" : ""), onclick: () => { cat = c; draw(); } }, c)));
    list.innerHTML = "";
    presets.filter(p => cat === "All" || p.cat === cat).forEach(p => list.append(h("div", { class: "item", onclick: () => preview(p) }, avatar(p),
      h("div", { class: "meta" }, h("div", { class: "name" }, p.name, owned(p.name) ? h("span", { class: "badge" }, "Added") : null), h("div", { class: "prev" }, p.tagline)))));
  }
  function preview(p) {
    const bg = h("div", { class: "sheet-bg", onclick: e => { if (e.target === bg) bg.remove(); } },
      h("div", { class: "sheet" }, h("div", { class: "center" }, avatar(p, "lg"), h("h2", null, p.name), h("div", { class: "muted" }, p.cat + " · " + p.tagline)),
        h("label", null, "Personality"), h("div", { class: "pre" }, p.persona.replace(/\{\{char\}\}/g, p.name)),
        h("label", null, "Opens with"), h("div", { class: "pre" }, p.greeting.replace(/\{\{char\}\}/g, p.name)),
        h("div", { class: "row2", style: "margin-top:6px" }, h("button", { style: "flex:1", onclick: () => bg.remove() }, "Back"),
          h("button", { class: "primary", style: "flex:2", onclick: () => add(p, bg) }, owned(p.name) ? "Add another copy" : "Add to my chats"))));
    app.append(bg);
  }
  async function add(p, sheetEl) {
    try {
      const c = await newCharacter({ name: p.name, avatar: p.avatar, tagline: p.tagline, persona: p.persona, greeting: p.greeting, examples: p.examples });
      await refresh(); sheetEl.remove(); close(); openChat(st.chars.find(x => x.id === c.id) || c);
    } catch (e) { toast(e.message); }
  }
  close = overlay(h("div", { style: "display:flex;flex-direction:column;height:100%" },
    h("div", { class: "top" }, h("button", { class: "icon", onclick: () => close() }, "✕"),
      h("div", { class: "title" }, "Starter characters", h("small", null, "All adults. Edit anything after adding."))), bar, list));
  draw();
}

/* ====================================================================== personas */
function renderPersonas(body) {
  body.append(h("div", { class: "muted", style: "margin:0 4px 12px" }, "A persona is YOU inside the story: your name and what your characters should know about you. The star marks your default."));
  if (!st.personas.length) {
    body.append(h("div", { class: "empty" }, h("div", { class: "big" }, "🧑"), h("p", null, "Create your first persona so characters know who you are."),
      h("button", { class: "primary", onclick: () => editPersona(null) }, "Create persona")));
    return;
  }
  const def = String(SET.default_persona_id || "");
  for (const p of st.personas) body.append(h("div", { class: "item", onclick: () => editPersona(p) }, avatar(p),
    h("div", { class: "meta" }, h("div", { class: "name" }, p.name), h("div", { class: "prev" }, p.description || "No description")),
    h("button", { class: "icon", onclick: async e => { e.stopPropagation(); SET.default_persona_id = p.id; await saveSettings(); renderHome(); } }, def === String(p.id) ? "⭐" : "☆")));
}
function editPersona(p) {
  const data = { avatar: p ? p.avatar || "" : "" };
  const avBox = h("div", { style: "cursor:pointer" });
  const name = h("input", { value: p ? p.name : "", placeholder: "Your name in the story", oninput: () => { if (!data.avatar) drawAv(); } });
  const drawAv = () => { avBox.innerHTML = ""; avBox.append(avatar({ avatar: data.avatar, name: name.value || "?" }, "lg")); };
  const file = h("input", { type: "file", accept: "image/*", style: "display:none", onchange: async () => { if (file.files[0]) { try { data.avatar = await resizeImage(file.files[0]); drawAv(); } catch (e) { toast("Couldn't read that image"); } } } });
  avBox.addEventListener("click", () => file.click()); drawAv();
  const desc = h("textarea", { rows: 6, placeholder: "Who are you? Job, age, personality, anything characters should know. (Optional)" }, p ? p.description : "");
  let close;
  const save = async () => {
    if (!name.value.trim()) return toast("Please enter a name");
    const rec = Object.assign(p ? { id: p.id } : {}, { name: name.value.trim(), description: desc.value, avatar: data.avatar });
    const id = await DB.put("personas", rec);
    if (!SET.default_persona_id) { SET.default_persona_id = p ? p.id : id; await saveSettings(); }
    await refresh(); close(); renderHome();
  };
  const del = async () => {
    if (!confirm("Delete this persona?")) return;
    await DB.del("personas", p.id);
    for (const c of await listChars()) if (c.persona_id === p.id) { c.persona_id = null; await DB.put("characters", c); }
    if (String(SET.default_persona_id) === String(p.id)) { SET.default_persona_id = null; await saveSettings(); }
    await refresh(); close(); renderHome();
  };
  close = overlay(h("div", { style: "display:flex;flex-direction:column;height:100%" },
    h("div", { class: "top" }, h("button", { class: "icon", onclick: () => close() }, "✕"), h("div", { class: "title" }, p ? "Edit persona" : "New persona"), h("button", { class: "primary", onclick: save }, "Save")),
    h("div", { class: "scroll" }, h("div", { class: "center" }, avBox, file, h("button", { class: "ghost", onclick: () => { data.avatar = ""; drawAv(); } }, "Remove picture"), h("div", { class: "muted" }, "Tap the circle to upload a picture")),
      h("label", null, "Name"), name, h("label", null, "About you"), desc, p ? h("button", { class: "danger", style: "margin-top:20px", onclick: del }, "Delete persona") : null)));
}

/* ====================================================================== character editor */
function editCharacter(c) {
  const data = { avatar: c ? c.avatar : "" };
  const avBox = h("div", { style: "cursor:pointer" });
  const nameIn = h("input", { value: c ? c.name : "", placeholder: "e.g. Luna", oninput: () => { if (!data.avatar) drawAv(); } });
  const drawAv = () => { avBox.innerHTML = ""; avBox.append(avatar({ avatar: data.avatar, name: nameIn.value || "?" }, "lg")); };
  const tag = h("input", { value: c ? c.tagline : "", placeholder: "Short line shown in your chat list" });
  const persona = h("textarea", { rows: 9, placeholder: "Who are they? Personality, backstory, how they talk, how they feel about you...\nTip: write {{user}} where your name should go." }, c ? c.persona : "");
  const greet = h("textarea", { rows: 3, placeholder: "The first message they send you" }, c ? c.greeting : "");
  const examples = h("textarea", { rows: 6, placeholder: "Optional but powerful. A few lines showing how they talk:\n{{user}}: i'm so tired\n{{char}}: *flops next to you* ugh same. what did today do to you?" }, c ? c.examples : "");
  let chosen = c && c.persona_id ? c.persona_id : null;
  const defP = st.personas.find(p => String(p.id) === String(SET.default_persona_id));
  const chipBox = h("div", { class: "chips" });
  const drawChips = () => {
    chipBox.innerHTML = "";
    const mk = (p, label, id) => h("div", { class: "chip" + (chosen === id ? " on" : ""), onclick: () => { chosen = id; drawChips(); } }, avatar(p || { name: "?" }, "sm"), h("span", null, label));
    chipBox.append(mk(defP, defP ? "Default: " + defP.name : "Default", null)); st.personas.forEach(p => chipBox.append(mk(p, p.name, p.id)));
  };
  drawChips();
  const file = h("input", { type: "file", accept: "image/*", style: "display:none", onchange: async () => { if (file.files[0]) { try { data.avatar = await resizeImage(file.files[0]); drawAv(); } catch (e) { toast("Couldn't read that image"); } } } });
  const emoji = h("input", { placeholder: "or type an emoji", maxlength: 4, style: "width:200px;text-align:center", oninput: () => { data.avatar = emoji.value; drawAv(); } });
  avBox.addEventListener("click", () => file.click()); drawAv();
  let close;
  const save = async () => {
    if (!nameIn.value.trim()) return toast("Give them a name");
    const body = { name: nameIn.value.trim(), tagline: tag.value.trim(), avatar: data.avatar, persona: persona.value.trim(), greeting: greet.value.trim(), examples: examples.value.trim(), persona_id: chosen };
    if (c) { const fresh = await DB.get("characters", c.id); Object.assign(fresh, body); await DB.put("characters", fresh); }
    else await newCharacter(body);
    await refresh(); close();
    if (st.cur && c) { st.cur = st.chars.find(x => x.id === c.id) || st.cur; openChat(st.cur); } else renderHome();
  };
  const del = async () => {
    if (!confirm("Delete " + c.name + ", the whole chat and all of their memories? This cannot be undone.")) return;
    await DB.delByChar("messages", c.id); await DB.delByChar("memories", c.id); await DB.del("characters", c.id);
    st.cur = null; await refresh(); close(); renderHome();
  };
  close = overlay(h("div", { style: "display:flex;flex-direction:column;height:100%" },
    h("div", { class: "top" }, h("button", { class: "icon", onclick: () => close() }, "✕"), h("div", { class: "title" }, c ? "Edit character" : "New character"), h("button", { class: "primary", onclick: save }, "Save")),
    h("div", { class: "scroll" }, h("div", { class: "center" }, avBox, file, emoji, h("div", { class: "muted" }, "Tap the circle to upload a picture")),
      h("label", null, "Name"), nameIn, h("label", null, "Tagline"), tag, h("label", null, "Personality and backstory"), persona,
      h("label", null, "First message"), greet, h("label", null, "Example messages (teaches their voice, makes replies much better)"), examples,
      h("label", null, "Who are you to them?"), chipBox, c ? h("button", { class: "danger", style: "margin-top:24px", onclick: del }, "Delete character") : null)));
}

/* ====================================================================== chat */
function personaName(c) { const id = c.persona_id || SET.default_persona_id; const p = st.personas.find(x => String(x.id) === String(id)); return p ? p.name : null; }

async function openChat(c) {
  st.cur = c; st.msgs = []; st.busy = false; st.shown = 80;
  history.replaceState(null, "", "#chat/" + c.id);
  app.innerHTML = "";
  const ta = h("textarea", { rows: 1, placeholder: "Message " + c.name + "..." });
  const sendBtn = h("button", { class: "primary" }, "⏭");
  const box = h("div", { id: "msgs" });
  ui = { msgs: box, ta, sendBtn };
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 130) + "px"; updateSendIcon(); });
  sendBtn.addEventListener("click", send);
  const pn = personaName(c);
  app.append(h("div", { class: "top" }, h("button", { class: "icon", onclick: async () => { await refresh(); renderHome(); } }, "‹"), avatar(c, "sm"),
    h("div", { class: "title" }, c.name, h("small", null, ((c.tagline || "") + (pn ? (c.tagline ? " · " : "") + "you: " + pn : "")))),
    h("button", { class: "icon", title: "Memory", onclick: () => openMemory(c) }, "🧠"), h("button", { class: "icon", onclick: chatMenu }, "⋯")),
    box, h("div", { id: "bar" }, ta, sendBtn));
  await reloadMessages();
}

async function reloadMessages() { if (!st.cur) return; st.msgs = await msgsOf(st.cur.id); renderMessages(); }

function renderMessages() {
  const box = ui.msgs; if (!box) return; box.innerHTML = "";
  const slice = st.msgs.slice(-st.shown);
  if (st.msgs.length > slice.length) box.append(h("button", { class: "more ghost", onclick: () => { st.shown += 80; const keep = box.scrollHeight; renderMessages(); box.scrollTop = box.scrollHeight - keep; } }, "Load earlier messages"));
  let prev = 0;
  slice.forEach((m, i) => {
    if (m.ts && (!prev || m.ts - prev > 3 * 3600)) box.append(h("div", { class: "gap" }, timeLabel(m.ts)));
    prev = m.ts || prev;
    addBubble(m, i === slice.length - 1);
  });
  scrollDown(true);
}
function removeBubble(b) { const w = b.parentNode && b.parentNode.classList && b.parentNode.classList.contains("mw") ? b.parentNode : b; w.remove(); }
function addBubble(m, isLast) {
  const b = h("div", { class: "m " + m.role }); setBubble(b, m);
  const wrap = h("div", { class: "mw " + m.role }, b);
  if (m.id) wrap.append(actRow(m, wrap, m.role === "assistant" && !!isLast));
  ui.msgs.append(wrap); return b;
}
function setBubble(b, m) {
  if (m.role === "assistant" && !m.content) b.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
  else b.innerHTML = fmt(m.content);
}
function actRow(m, wrap, isLast) {
  const btn = (label, fn) => h("button", { onclick: e => { e.stopPropagation(); if (!st.busy) fn(); } }, label);
  return h("div", { class: "acts" }, isLast ? btn("↻ Regenerate", regenerate) : null, btn("✎ Edit", () => editInline(m, wrap)), btn("🗑 Delete", () => deleteMsg(m)),
    btn("⧉ Copy", () => { if (navigator.clipboard) navigator.clipboard.writeText(m.content).then(() => toast("Copied")); }));
}
function editInline(m, wrap) {
  const ta = h("textarea", { rows: 3, style: "min-width:min(78vw,420px)" }, m.content);
  const box = h("div", { class: "mw " + m.role }, ta, h("div", { class: "acts" }, h("button", { onclick: () => renderMessages() }, "Cancel"),
    h("button", { class: "primary", onclick: async () => {
      const t = ta.value.trim(); if (!t) return;
      const rec = await DB.get("messages", m.id); rec.content = t; await DB.put("messages", rec); m.content = t; renderMessages();
    } }, "Save")));
  wrap.replaceWith(box); ta.style.height = Math.min(ta.scrollHeight + 4, 320) + "px"; ta.focus();
}
async function deleteMsg(m) { if (!confirm("Delete this message?")) return; await DB.del("messages", m.id); st.msgs = st.msgs.filter(x => x.id !== m.id); renderMessages(); }
function scrollDown(force) { const b = ui.msgs; if (!b) return; if (force || b.scrollHeight - b.scrollTop - b.clientHeight < 140) b.scrollTop = b.scrollHeight; }

function updateSendIcon() {
  if (!ui.sendBtn) return;
  const empty = !ui.ta.value.trim();
  ui.sendBtn.textContent = st.busy ? "■" : (empty ? "⏭" : "➤");
  ui.sendBtn.title = st.busy ? "Stop" : (empty ? "Skip my turn: let them continue on their own" : "Send");
}
function setBusy(v) { st.busy = v; updateSendIcon(); }

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && SET.keep_awake && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) {}
}

async function send() {
  if (st.busy) { Engine.interrupt(); return; }
  const text = ui.ta.value.trim();
  if (!text) { await generateReply({ nudge: true }); return; }
  if (!(await ensureModel())) return;          // make sure a model is ready before saving the message
  ui.ta.value = ""; ui.ta.style.height = "auto"; updateSendIcon();
  await addMsg(st.cur.id, "user", text);
  await reloadMessages();
  await generateReply({ nudge: false });
}

async function generateReply(opts) {
  const c = st.cur; if (!c || st.busy) return;
  if (!(await ensureModel())) return;
  await Maint.stop();
  setBusy(true);
  const cid = c.id, am = { id: null, role: "assistant", content: "", ts: now() };
  st.msgs.push(am);
  const bubble = addBubble(am, false); scrollDown(true);
  await keepAwake(true);
  let text = "", err = null;
  try {
    const fresh = await DB.get("characters", cid);
    const prompt = await buildPrompt(fresh, !!opts.nudge);
    window.__lastPrompt = prompt;
    text = await Engine.generate(prompt, { temperature: SET.temperature, max_tokens: SET.max_tokens, repetition_penalty: SET.rep_penalty },
      acc => { am.content = stripThink(acc); if (bubble.isConnected) { setBubble(bubble, am); scrollDown(); } });
  } catch (e) {
    err = e.message || String(e);
    if (/device|lost|memory|out of|OOM|allocate/i.test(err)) { Engine.eng = null; Engine.loadedKey = null; err = "The browser stopped the model (probably out of memory). Try a smaller model in Settings > Models. (" + err + ")"; }
  }
  await keepAwake(false); setBusy(false);
  text = cleanReply(stripThink(text), c.name);
  if (text) await addMsg(cid, "assistant", text);
  else if (!err) err = "The model returned an empty reply. Try again.";
  if (st.cur && st.cur.id === cid) {
    await reloadMessages();
    if (err && ui.msgs) { const e = h("div", { class: "m assistant err" }, err); ui.msgs.append(e); scrollDown(true); }
  }
  if (text) Maint.schedule(cid);
}

async function regenerate() {
  if (st.busy) return;
  const all = await msgsOf(st.cur.id), last = all[all.length - 1];
  if (!last) return;
  let nudge = false;
  if (last.role === "assistant") {
    const prior = all[all.length - 2];
    if (!prior) return toast("Nothing to regenerate yet.");
    nudge = prior.role === "assistant";
    await DB.del("messages", last.id);
    await reloadMessages();
  }
  await generateReply({ nudge });
}

function chatMenu() {
  const c = st.cur;
  sheet([
    { label: "🧠  Memory", fn: () => openMemory(c) },
    { label: "↻  Regenerate last reply", fn: regenerate },
    { label: "↩︎  Undo last exchange", fn: async () => {
        const all = await msgsOf(c.id), del = [];
        if (all.length && all[all.length - 1].role === "assistant") del.push(all.pop());
        if (all.length && all[all.length - 1].role === "user") del.push(all.pop());
        for (const m of del) await DB.del("messages", m.id);
        await reloadMessages();
      } },
    { label: "✏️  Edit character", fn: () => editCharacter(c) },
    { label: "🗑  Start over (keep memories)", danger: true, fn: () => resetChat(true) },
    { label: "🗑  Start over (forget everything)", danger: true, fn: () => resetChat(false) },
  ], c.name);
}
async function resetChat(keep) {
  const c = st.cur;
  if (!confirm(keep ? "Clear this chat but keep what " + c.name + " remembers?" : "Clear the chat AND erase all of " + c.name + "'s memories?")) return;
  await DB.delByChar("messages", c.id);
  const fresh = await DB.get("characters", c.id);
  fresh.summarized_upto = 0; fresh.extracted_upto = 0;
  if (!keep) { await DB.delByChar("memories", c.id); fresh.summary = ""; }
  await DB.put("characters", fresh); st.cur = fresh; await insertGreeting(fresh); await reloadMessages();
}

/* ====================================================================== memory screen */
async function openMemory(c) {
  let close;
  const listBox = h("div"), summary = h("textarea", { rows: 7, placeholder: "The story so far will appear here as your chat grows. You can also write it yourself." });
  const countLabel = h("span", { class: "muted" });
  async function load() {
    const ch = await DB.get("characters", c.id), facts = (await memsOf(c.id)).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.id - a.id);
    summary.value = ch.summary || ""; countLabel.textContent = facts.length + " saved"; listBox.innerHTML = "";
    if (!facts.length) listBox.append(h("div", { class: "muted", style: "padding:8px 0" }, "Nothing yet. Memories are added automatically as you chat, or add your own below."));
    for (const f of facts) listBox.append(h("div", { class: "fact" },
      h("div", { class: "t" + (f.pinned ? " pin" : ""), onclick: async () => { const t = prompt("Edit memory", f.text); if (t && t.trim()) { f.text = t.trim(); await DB.put("memories", f); load(); } } }, f.text),
      h("button", { class: "icon", title: "Pin", onclick: async () => { f.pinned = !f.pinned; await DB.put("memories", f); load(); } }, f.pinned ? "📍" : "📌"),
      h("button", { class: "icon", title: "Delete", onclick: async () => { await DB.del("memories", f.id); load(); } }, "🗑")));
  }
  const add = h("input", { placeholder: "Add a memory, e.g. \"Sam's birthday is June 3\"" });
  const addBtn = h("button", { class: "primary", onclick: async () => { if (!add.value.trim()) return; await DB.add("memories", { character_id: c.id, text: add.value.trim().slice(0, 500), pinned: true, source: "manual", created: now() }); add.value = ""; load(); } }, "Add");
  const saveSummary = h("button", { onclick: async () => { const ch = await DB.get("characters", c.id); ch.summary = summary.value.trim(); await DB.put("characters", ch); toast("Saved"); } }, "Save story");
  const runBtn = h("button", { class: "primary", onclick: async () => {
    if (st.busy) return toast("Wait for the reply to finish first.");
    if (!(await ensureModel())) return;
    runBtn.disabled = true; runBtn.textContent = "Thinking...";
    try { const r = await Maint.run(c.id, true); toast(r.added ? "Added " + r.added + " new memories" : "No new memories found"); await load(); }
    catch (e) { toast(e.message); }
    runBtn.disabled = false; runBtn.textContent = "Update now";
  } }, "Update now");
  close = overlay(h("div", { style: "display:flex;flex-direction:column;height:100%" },
    h("div", { class: "top" }, h("button", { class: "icon", onclick: () => close() }, "✕"), h("div", { class: "title" }, c.name + "'s memory", h("small", null, "What they remember about you and your story")), runBtn),
    h("div", { class: "scroll" },
      h("div", { class: "card" }, h("b", null, "Story so far"), h("div", { class: "muted", style: "margin:4px 0 8px" }, "Older chat gets folded into this summary so nothing is forgotten."), summary, h("div", { style: "margin-top:8px" }, saveSummary)),
      h("div", { class: "card" }, h("div", { style: "display:flex;justify-content:space-between" }, h("b", null, "Things remembered"), countLabel), listBox, h("div", { class: "row2", style: "margin-top:10px" }, add, addBtn)))));
  load();
}

/* ====================================================================== models */
async function ensureModel() {
  if (Engine.loadedKey && Engine.loadedKey === SET.model_key) return true;
  const gpuOk = await Engine.detectGPU();
  if (!gpuOk) { toast(Engine.gpuNote || "WebGPU isn't available.", 6000); openModels(); return false; }
  if (!SET.model_key) { toast("Pick and download a model first."); openModels(); return false; }
  let e;
  try { await Engine.getLib(); e = Engine.entry(SET.model_key); } catch (x) { toast(x.message, 6000); return false; }
  if (!e || !(await Engine.isCached(e))) { toast("This model isn't downloaded yet."); openModels(); return false; }
  const bar = h("i"), text = h("div", { class: "muted" }, "Loading the model into the GPU...");
  const close = overlay(h("div", { class: "center loading" }, h("div", { style: "font-size:40px" }, "🧠"), h("b", null, "Waking up " + e.label), h("div", { class: "pbar" }, bar), text), "full loadfull");
  try {
    await Engine.load(e, r => { bar.style.width = Math.round((r.progress || 0) * 100) + "%"; text.textContent = r.text || ""; });
    close(); return true;
  } catch (x) { close(); toast("Couldn't load the model: " + (x.message || x), 7000); openModels(); return false; }
}

function openModels() {
  if (document.querySelector(".modelscreen")) return;
  let close;
  const list = h("div"), status = h("div", { class: "muted", style: "margin:4px 4px 10px" });
  const diagBox = h("div", { class: "pre", style: "display:none" });
  async function draw() {
    list.innerHTML = ""; status.textContent = "Checking this phone and loading the model list...";
    const gpuOk = await Engine.detectGPU();
    try { await Engine.getLib(); } catch (e) { status.textContent = e.message; return; }
    status.textContent = gpuOk ? (Engine.f16 ? "WebGPU ready ✓" : "WebGPU ready, but without 16-bit support: only some models will work.") : "⚠️ " + Engine.gpuNote;
    for (const e of Engine.entries()) {
      const cached = e.missing ? false : await Engine.isCached(e);
      const active = Engine.loadedKey === e.key, selected = SET.model_key === e.key;
      const bar = h("i"), pb = h("div", { class: "pbar", style: "display:none" }, bar), msg = h("div", { class: "muted" });
      const act = async () => {
        pb.style.display = ""; msg.textContent = "Starting...";
        try {
          SET.model_key = e.key; await saveSettings();
          await Engine.load(e, r => { bar.style.width = Math.round((r.progress || 0) * 100) + "%"; msg.textContent = r.text || ""; });
          toast(e.label + " is ready"); draw();
        } catch (x) { msg.textContent = "Failed: " + (x.message || x); }
      };
      list.append(h("div", { class: "card" },
        h("div", { style: "display:flex;justify-content:space-between;gap:8px" }, h("b", null, e.label), active ? h("span", { class: "badge" }, "Loaded") : selected ? h("span", { class: "badge" }, "Selected") : null),
        h("div", { class: "muted", style: "margin:4px 0 8px" }, (e.note || "") + (e.size ? " · " + e.size : "")),
        e.missing ? h("div", { class: "muted" }, "Not available: the engine has no matching library for this model.")
          : (e.needsF16 && !Engine.f16) ? h("div", { class: "muted" }, "Needs 16-bit GPU support, which this phone doesn't report.")
          : h("div", { class: "row2" }, h("button", { class: "primary", onclick: act }, cached ? (active ? "Reload" : "Use this model") : "Download & use"),
              cached ? h("button", { onclick: async () => { if (confirm("Delete the downloaded files for " + e.label + "?")) { await Engine.removeCache(e); draw(); } } }, "Delete download") : null,
              e.custom ? h("button", { class: "danger", onclick: async () => { SET.custom_models = SET.custom_models.filter(x => x.key !== e.key); await saveSettings(); draw(); } }, "Remove") : null),
        pb, msg));
    }
    list.append(addCustomCard());
  }
  function addCustomCard() {
    const label = h("input", { placeholder: "Name, e.g. My heretic 4B" });
    const repo = h("input", { placeholder: "https://huggingface.co/your-name/model-q4f16_1-MLC" });
    const lib = h("select");
    Engine.lib.prebuiltAppConfig.model_list.filter(m => /q4f16_1/.test(m.model_id)).forEach(m => lib.append(h("option", { value: m.model_id }, m.model_id.replace(/-q4f16_1-MLC$/, ""))));
    const pre = Engine.lib.prebuiltAppConfig.model_list.find(m => m.model_id === "Qwen3-4B-q4f16_1-MLC"); if (pre) lib.value = pre.model_id;
    return h("div", { class: "card" }, h("b", null, "Add your own model"),
      h("div", { class: "muted", style: "margin:4px 0" }, "Paste the Hugging Face address of a model already converted to browser (MLC) format, and pick which official model it is built on. For example, a heretic Qwen3 4B uses \"Qwen3-4B\"."),
      h("label", null, "Name"), label, h("label", null, "Model address"), repo, h("label", null, "Built on"), lib,
      h("button", { class: "primary", style: "margin-top:10px", onclick: async () => {
        if (!/^https:\/\/huggingface\.co\/[^/]+\/[^/]+/.test(repo.value.trim())) return toast("That doesn't look like a Hugging Face model address.");
        SET.custom_models = SET.custom_models || [];
        SET.custom_models.push({ key: "c" + Date.now(), label: label.value.trim() || "Custom model", repo: repo.value.trim().replace(/\/$/, ""), libFrom: [lib.value], note: "Your own model.", size: "" });
        await saveSettings(); draw();
      } }, "Add"));
  }
  const diagBtn = h("button", { onclick: async () => { diagBox.style.display = ""; diagBox.textContent = "Checking..."; diagBox.textContent = await diagnose(); } }, "🔍 Check my phone");
  close = overlay(h("div", { class: "modelscreen", style: "display:flex;flex-direction:column;height:100%" },
    h("div", { class: "top" }, h("button", { class: "icon", onclick: () => close() }, "✕"), h("div", { class: "title" }, "Models", h("small", null, "Downloads stay on this phone"))),
    h("div", { class: "scroll" }, status, h("div", { style: "margin:0 4px 12px" }, diagBtn), diagBox, list,
      h("div", { class: "muted", style: "padding:10px 4px" }, "Download over Wi-Fi: models are 1-5 GB. Smaller models are faster and safer on a phone."))));
  draw();
}

async function diagnose() {
  const L = [];
  L.push("Browser: " + navigator.userAgent);
  L.push("Installed to home screen: " + ((navigator.standalone || matchMedia("(display-mode: standalone)").matches) ? "yes" : "no (open from the home-screen icon for best results)"));
  if (!navigator.gpu) L.push("WebGPU: NOT available. You need iOS 26 or newer, in Safari or an installed home-screen app.");
  else {
    try {
      const ad = await navigator.gpu.requestAdapter();
      if (!ad) L.push("WebGPU: present, but no GPU adapter was returned.");
      else {
        L.push("WebGPU: available ✓");
        L.push("16-bit shaders (shader-f16): " + (ad.features.has("shader-f16") ? "yes ✓" : "NO (only 32-bit models will work)"));
        L.push("Max buffer size: " + Math.round(ad.limits.maxBufferSize / 1048576) + " MB");
        L.push("Max storage binding: " + Math.round(ad.limits.maxStorageBufferBindingSize / 1048576) + " MB");
      }
    } catch (e) { L.push("WebGPU error: " + e.message); }
  }
  try {
    if (navigator.storage && navigator.storage.estimate) { const s = await navigator.storage.estimate(); L.push("Storage: " + Math.round((s.usage || 0) / 1048576) + " MB used of about " + Math.round((s.quota || 0) / 1048576) + " MB"); }
    if (navigator.storage && navigator.storage.persisted) L.push("Protected from automatic clearing: " + ((await navigator.storage.persisted()) ? "yes ✓" : "not guaranteed"));
  } catch (e) {}
  L.push("Screen keep-awake support: " + (navigator.wakeLock ? "yes" : "no"));
  return L.join("\n");
}

/* ====================================================================== settings */
function renderSettings(body) {
  const e = Engine.lib ? Engine.entries().find(x => x.key === SET.model_key) : CURATED.find(x => x.key === SET.model_key);
  const tv = h("span", null, String(SET.temperature)), rv = h("span", null, String(SET.rep_penalty));
  const temp = h("input", { type: "range", min: 0.2, max: 1.5, step: 0.05, value: SET.temperature, oninput: () => { tv.textContent = temp.value; }, onchange: () => { SET.temperature = +temp.value; saveSettings(); } });
  const rep = h("input", { type: "range", min: 1.0, max: 1.4, step: 0.05, value: SET.rep_penalty, oninput: () => { rv.textContent = rep.value; }, onchange: () => { SET.rep_penalty = +rep.value; saveSettings(); } });
  const sel = (opts, cur, onch) => { const s = h("select", { onchange: () => onch(s.value) }, opts.map(([v, l]) => h("option", { value: v }, l))); s.value = String(cur); return s; };
  const memOn = h("input", { type: "checkbox", style: "width:auto", checked: SET.memory_enabled, onchange: () => { SET.memory_enabled = memOn.checked; saveSettings(); } });
  const awake = h("input", { type: "checkbox", style: "width:auto", checked: SET.keep_awake, onchange: () => { SET.keep_awake = awake.checked; saveSettings(); } });
  const dp = sel([["", "None"]].concat(st.personas.map(p => [p.id, p.name])), SET.default_persona_id || "", v => { SET.default_persona_id = v ? +v : null; saveSettings(); });
  body.append(
    h("div", { class: "card" }, h("b", null, "AI model"), h("div", { class: "muted", style: "margin:6px 0" }, e ? e.label : "No model chosen yet"),
      h("button", { class: "primary", onclick: openModels }, "Models & downloads")),
    h("div", { class: "card" }, h("b", null, "Writing"),
      h("label", null, "Reply length"), sel([[120, "Short (about 2 sentences)"], [300, "Medium"], [600, "Long"], [900, "Very long"]], SET.max_tokens, v => { SET.max_tokens = +v; saveSettings(); }),
      h("label", null, ["Creativity: ", tv]), temp, h("label", null, ["Repetition guard (raise it if replies echo you): ", rv]), rep,
      h("label", null, "Memory window (how much recent chat the model sees)"), sel([[2048, "Small (2048): fastest, least memory"], [4096, "Normal (4096)"]], SET.ctx, v => { SET.ctx = +v; saveSettings(); })),
    h("div", { class: "card" }, h("b", null, "Long-term memory"),
      h("label", { style: "display:flex;gap:10px;align-items:center;color:var(--text);font-size:16px" }, memOn, "Remember things automatically"),
      h("label", null, "Take notes"), sel([[4, "Every 4 messages"], [8, "Every 8 messages"], [12, "Every 12 messages"], [20, "Every 20 messages"]], SET.memory_every, v => { SET.memory_every = +v; saveSettings(); }),
      h("div", { class: "muted", style: "margin-top:8px" }, "Notes are written by the model on your phone in the background, so they use battery. Fewer notes = cooler phone.")),
    h("div", { class: "card" }, h("b", null, "You"), h("label", null, "Default persona"), dp,
      h("label", { style: "display:flex;gap:10px;align-items:center;color:var(--text);font-size:16px;margin-top:14px" }, awake, "Keep the screen on while a reply is written")),
    h("div", { class: "card" }, h("b", null, "Backup"),
      h("div", { class: "muted", style: "margin:6px 0" }, "Your chats live only in this browser. Back them up now and then: if Safari clears its storage, they're gone."),
      h("div", { class: "row2" }, h("button", { onclick: exportData }, "Export backup"),
        h("button", { onclick: () => { const f = h("input", { type: "file", accept: "application/json,.json" }); f.onchange = () => f.files[0] && importData(f.files[0]); f.click(); } }, "Import backup"))),
    h("div", { class: "muted", style: "text-align:center;padding:10px" }, "Everything runs on this phone. Nothing is sent anywhere, except downloading models."));
}

async function exportData() {
  const dump = { app: "companion-web", version: 1, settings: JSON.parse(JSON.stringify(SET)) };
  for (const s of ["characters", "personas", "messages", "memories"]) dump[s] = await DB.all(s);
  const blob = new Blob([JSON.stringify(dump)], { type: "application/json" }), name = "companion-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  try {
    const f = new File([blob], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: "Companion backup" }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  const a = h("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove();
}
async function importData(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== "companion-web") throw new Error("That isn't a Companion backup.");
    if (!confirm("Replace everything in this app with the backup?")) return;
    for (const s of ["characters", "personas", "messages", "memories"]) { await DB.clear(s); for (const r of d[s] || []) await DB.put(s, r); }
    Object.assign(SET, d.settings || {}, { model_key: SET.model_key }); await saveSettings();
    await refresh(); toast("Backup restored"); renderHome();
  } catch (e) { toast("Couldn't import: " + e.message, 5000); }
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && st.cur && !st.busy) reloadMessages(); });
boot();
