// Questboard: a shared co-op game backlog for a group of friends. The board
// lives in KV ("board") and is edited on the site itself; saves need the
// EDIT_PASSWORD secret. Steam prices and cover art are cached in KV ("steam")
// by a daily cron. Every save keeps the previous version for 30 days
// ("history:*"), and a weekly cron writes a permanent snapshot ("backup:*")
// that nothing ever deletes. Votes on which games to buy and the Activity log
// live in a Durable Object (see Votes below), not in KV.
import { DurableObject } from "cloudflare:workers";
import PAGE from "./index.html";
import FAVICON from "./favicon.svg";

const MAX_BODY = 512 * 1024;
const ACTIVITY_MAX = 400;
const HISTORY_TTL = 60 * 60 * 24 * 30;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/" && (method === "GET" || method === "HEAD")) {
      return new Response(page(env, url), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }
    if (pathname === "/favicon.svg") {
      return new Response(FAVICON, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
    }
    if (pathname === "/favicon.ico") return image("icon-64.png", env);
    if (pathname === "/api/board" && method === "GET") return getBoard(env);
    if (pathname === "/api/board" && method === "PUT") return saveBoard(request, env);
    if (pathname === "/api/login" && method === "POST") {
      return (await authorized(request, env)) ? json({ ok: true }) : json({ error: "Wrong password" }, 401);
    }
    if (pathname === "/api/suggestions" && method === "POST") return addSuggestions(request, env);
    if (pathname === "/api/tidy" && method === "POST") return tidyBoard(request, env);
    if (pathname === "/api/votes" && method === "GET") return json(await readLive(env));
    if (pathname === "/api/vote" && method === "POST") return castVote(request, env);
    if (pathname === "/api/vote/reset" && method === "POST") return resetVotes(request, env);
    if (pathname === "/api/steam-search" && method === "GET") return steamSearch(url.searchParams.get("q") || "");
    if (pathname.startsWith("/img/") && method === "GET") return image(pathname.slice(5), env);
    if (pathname.startsWith("/thumb/") && method === "GET") return thumb(pathname.slice(7), env);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "0 17 * * 4") {
      // Weekly permanent snapshot (Thursday 12:00 Central).
      const board = await env.GAMES_KV.get("board");
      if (board) {
        const stamp = new Date(event.scheduledTime).toISOString().slice(0, 10);
        await env.GAMES_KV.put(`backup:${stamp}`, board);
      }
    } else {
      ctx.waitUntil(refreshSteam(env, null));
    }
  },
};

// The page's title and link-preview text come from the BOARD_TITLE and
// BOARD_DESCRIPTION vars, so each group can name its own board.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function page(env, url) {
  const vars = {
    TITLE: env.BOARD_TITLE || "Questboard",
    DESCRIPTION: env.BOARD_DESCRIPTION || "Our co-op backlog: what we're playing, what's on sale, and what didn't survive contact.",
    ORIGIN: url.origin,
  };
  return PAGE.replace(/\{\{(TITLE|DESCRIPTION|ORIGIN)\}\}/g, (_, k) => esc(vars[k]));
}

async function authorized(request, env) {
  const given = request.headers.get("X-Password") || "";
  const want = env.EDIT_PASSWORD || "";
  if (!want || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

async function getBoard(env) {
  const [board, steam, thumbs, live] = await Promise.all([
    env.GAMES_KV.get("board", "json"),
    env.GAMES_KV.get("steam", "json"),
    env.GAMES_KV.get("thumbs", "json"),
    readLive(env),
  ]);
  return json({
    board: board || { version: 0, lanes: [] },
    steam: steam || { apps: {} },
    activity: live.activity,
    thumbs: thumbs || {},
    votes: live.votes,
    voteRound: live.round,
  });
}

async function saveBoard(request, env) {
  if (!(await authorized(request, env))) return json({ error: "Wrong password" }, 401);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: "Board too large" }, 413);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }
  const lanes = cleanLanes(body.lanes);
  if (!lanes) return json({ error: "Invalid board" }, 400);

  const current = (await env.GAMES_KV.get("board", "json")) || { version: 0, lanes: [] };
  if (body.version !== current.version) {
    return json({ error: "Someone else saved first", board: current }, 409);
  }

  const dismissed = cleanDismissed(body.dismissed ?? current.dismissed);
  const next = { version: current.version + 1, savedAt: new Date().toISOString(), lanes, dismissed };
  await env.GAMES_KV.put(`history:${current.savedAt || "seed"}:v${current.version}`, JSON.stringify(current), {
    expirationTtl: HISTORY_TTL,
  });
  await env.GAMES_KV.put("board", JSON.stringify(next));

  const changes = describeChanges(current.lanes || [], lanes);
  let activity = null;
  if (changes.length) {
    const who = {
      name: str(request.headers.get("X-Editor"), 30) || "Someone",
      tag: await ipTag(request, env),
    };
    const at = next.savedAt;
    const entries = (changes.length > 12
      ? [...changes.slice(0, 10), `made ${changes.length - 10} more changes`]
      : changes
    ).map((text) => ({ at, ...who, text }));
    activity = await logActivity(env, entries);
  }

  // Fetch prices/covers for any newly linked games so the editor sees them now.
  const steam = await refreshSteam(env, lanes);
  return json({ version: next.version, savedAt: next.savedAt, steam, activity });
}

// ---- validation: only known fields, bounded sizes, safe URLs --------------

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const safeUrl = (v) => {
  const s = str(v, 500);
  return /^https?:\/\//i.test(s) ? s : "";
};
const safeCover = (v) => {
  const s = str(v, 500);
  return /^https:\/\//i.test(s) || /^\/img\/[\w.-]+$/.test(s) ? s : "";
};

function cleanLanes(lanes) {
  if (!Array.isArray(lanes) || lanes.length > 60) return null;
  let total = 0;
  const out = [];
  for (const l of lanes) {
    if (!l || typeof l !== "object" || !Array.isArray(l.items)) return null;
    const color = /^#[0-9a-f]{6}$/i.test(l.color) ? l.color : "#8b8b8b";
    const lane = {
      id: str(l.id, 40) || crypto.randomUUID(),
      name: str(l.name, 80) || "Untitled",
      color,
      sortByDiscount: !!l.sortByDiscount,
      showPrices: l.showPrices !== false,
      items: [],
    };
    for (const it of l.items) {
      if (!it || typeof it !== "object") return null;
      if (++total > 3000) return null;
      const item = {
        id: str(it.id, 40) || crypto.randomUUID(),
        title: str(it.title, 200) || "Untitled",
        steam: (Array.isArray(it.steam) ? it.steam : [])
          .map(String)
          .filter((s) => /^\d{1,9}$/.test(s))
          .slice(0, 5),
        tags: (Array.isArray(it.tags) ? it.tags : [])
          .map((t) => str(t, 30))
          .filter(Boolean)
          .slice(0, 10),
      };
      const url = safeUrl(it.url);
      if (url) item.url = url;
      const cover = safeCover(it.cover);
      if (cover) item.cover = cover;
      if (it.suggested) {
        item.suggested = true;
        const why = str(it.why, 400);
        if (why) item.why = why;
        const at = str(it.suggestedAt, 40);
        if (at) item.suggestedAt = at;
      }
      if (it.pending) item.pending = true; // added without a Steam match; the weekly run looks it up
      if (l.trash) {
        const from = str(it.fromLane, 40), fromName = str(it.fromLaneName, 80);
        if (from) item.fromLane = from;
        if (fromName) item.fromLaneName = fromName;
      }
      lane.items.push(item);
    }
    if (l.trash) Object.assign(lane, { id: "trash", name: "Trashed", trash: true, showPrices: false, sortByDiscount: false });
    out.push(lane);
  }
  // exactly one trash column, always last
  const trash = out.filter((l) => l.trash);
  const rest = out.filter((l) => !l.trash);
  const t = trash[0] || { id: "trash", name: "Trashed", color: "#8e8e93", trash: true, showPrices: false, sortByDiscount: false, items: [] };
  for (const extra of trash.slice(1)) t.items.push(...extra.items);
  return [...rest, t];
}

function cleanDismissed(list) {
  return (Array.isArray(list) ? list : [])
    .filter((d) => d && typeof d === "object")
    .map((d) => ({
      title: str(d.title, 200),
      steam: (Array.isArray(d.steam) ? d.steam : []).map(String).filter((x) => /^\d{1,9}$/.test(x)).slice(0, 5),
    }))
    .filter((d) => d.title || d.steam.length)
    .slice(-1000);
}

// ---- weekly suggestions (posted by the scheduled research agent) ------------

const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

async function addSuggestions(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.SUGGEST_TOKEN || auth !== `Bearer ${env.SUGGEST_TOKEN}`) return json({ error: "Unauthorized" }, 401);
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }
  const wanted = (Array.isArray(body.items) ? body.items : []).slice(0, 15);

  const current = (await env.GAMES_KV.get("board", "json")) || { version: 0, lanes: [] };
  const lanes = cleanLanes(current.lanes || []);
  const dismissed = cleanDismissed(current.dismissed);
  const knownIds = new Set([...lanes.flatMap((l) => l.items.flatMap((i) => i.steam)), ...dismissed.flatMap((d) => d.steam)]);
  const knownTitles = new Set([...lanes.flatMap((l) => l.items.map((i) => norm(i.title))), ...dismissed.map((d) => norm(d.title))]);

  const inbox = lanes.find((l) => !l.trash && norm(l.name) === "inbox") || lanes.find((l) => !l.trash);
  if (!inbox) return json({ error: "No inbox" }, 409);

  const at = new Date().toISOString();
  const added = [], skipped = [];
  for (const w of wanted) {
    const title = str(w && w.title, 200);
    if (!title) continue;
    let id = /^\d{1,9}$/.test(String(w.steam || "")) ? String(w.steam) : "";
    if (!id) {
      // resolve on Steam if the agent didn't give an app id
      const r = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&cc=us&l=en`)
        .then((r) => r.json()).catch(() => ({}));
      const hit = (r.items || []).find((i) => norm(i.name) === norm(title)) || (r.items || [])[0];
      if (hit) id = String(hit.id);
    }
    if ((id && knownIds.has(id)) || knownTitles.has(norm(title))) { skipped.push(title); continue; }
    const item = { id: crypto.randomUUID().slice(0, 12), title, steam: id ? [id] : [], tags: [], suggested: true, suggestedAt: at };
    const why = str(w.why, 400);
    if (why) item.why = why;
    inbox.items.unshift(item);
    if (id) knownIds.add(id);
    knownTitles.add(norm(title));
    added.push(item);
  }
  if (!added.length) return json({ added: [], skipped });

  const next = { version: (current.version || 0) + 1, savedAt: at, lanes, dismissed };
  await env.GAMES_KV.put(`history:${current.savedAt || "seed"}:v${current.version}`, JSON.stringify(current), { expirationTtl: HISTORY_TTL });
  await env.GAMES_KV.put("board", JSON.stringify(next));
  await refreshSteam(env, lanes);
  await logActivity(env, added.map((i) => ({ at, name: "Weekly picks", tag: "auto", text: `suggested “${i.title}”` })));
  return json({ added: added.map((i) => ({ title: i.title, steam: i.steam })), skipped });
}

// ---- weekly tidy (same agent): look up pending adds, fix titles -------------
// Body: {updates: [{id, title?, steam?: [appid], url?, cover?}]}. Any update to an
// item clears its "pending" flag, so the agent sends {id} alone to give up on one.
async function tidyBoard(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.SUGGEST_TOKEN || auth !== `Bearer ${env.SUGGEST_TOKEN}`) return json({ error: "Unauthorized" }, 401);
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ error: "Bad JSON" }, 400);
  }
  const updates = (Array.isArray(body.updates) ? body.updates : []).slice(0, 80);

  const current = (await env.GAMES_KV.get("board", "json")) || { version: 0, lanes: [] };
  const lanes = cleanLanes(current.lanes || []);
  const byId = new Map(lanes.flatMap((l) => l.items.map((i) => [i.id, i])));
  const texts = [], applied = [], missing = [];
  for (const u of updates) {
    const it = byId.get(str(u && u.id, 40));
    if (!it) { missing.push(u && u.id); continue; }
    const was = it.title;
    const title = str(u.title, 200);
    if (title && title !== it.title) { texts.push(`renamed “${was}” to “${title}”`); it.title = title; }
    if (Array.isArray(u.steam)) {
      const ids = u.steam.map(String).filter((s) => /^\d{1,9}$/.test(s)).slice(0, 5);
      if (ids.length && ids.join() !== it.steam.join()) { it.steam = ids; texts.push(`linked “${it.title}” on Steam`); }
    }
    const url = safeUrl(u.url);
    if (url) it.url = url;
    const cover = safeCover(u.cover);
    if (cover) it.cover = cover;
    if (it.pending) {
      delete it.pending;
      if (!it.steam.length && !title) texts.push(`couldn't find “${it.title}”`);
    }
    applied.push(it.id);
  }
  if (!applied.length) return json({ applied, missing });

  const at = new Date().toISOString();
  const next = { version: (current.version || 0) + 1, savedAt: at, lanes, dismissed: cleanDismissed(current.dismissed) };
  await env.GAMES_KV.put(`history:${current.savedAt || "seed"}:v${current.version}`, JSON.stringify(current), { expirationTtl: HISTORY_TTL });
  await env.GAMES_KV.put("board", JSON.stringify(next));
  await refreshSteam(env, lanes);
  if (texts.length) {
    await logActivity(env, texts.map((text) => ({ at, name: "AI tidy", tag: "auto", text })));
  }
  return json({ applied, missing, changes: texts });
}

// ---- votes: one vote per person per game; "new vote" clears them all --------

// Votes and the Activity log. A Durable Object handles one request at a time,
// so two people voting (or saving) at the same moment can't overwrite each
// other's entries the way a KV read-modify-write would.
export class Votes extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // One-time move of the log out of KV (where it lived before 2026-10-03).
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.get("activity")) === undefined) {
        await ctx.storage.put("activity", ((await env.GAMES_KV.get("activity", "json")) || []).slice(0, ACTIVITY_MAX));
      }
    });
  }
  async state() {
    const m = await this.ctx.storage.get(["votes", "round", "activity"]);
    return { votes: m.get("votes") || {}, round: m.get("round") || null, activity: (m.get("activity") || []).slice(0, 150) };
  }
  async log(entries) {
    const activity = [...entries, ...((await this.ctx.storage.get("activity")) || [])].slice(0, ACTIVITY_MAX);
    await this.ctx.storage.put("activity", activity);
    return activity.slice(0, 150);
  }
  async cast(id, title, key, name, tag, on) {
    const m = await this.ctx.storage.get(["votes", "activity"]);
    const all = m.get("votes") || {};
    let activity = m.get("activity") || [];
    const before = all[id] || [];
    const list = before.filter((v) => v.k !== key);
    const had = list.length !== before.length;
    if (on) list.push({ k: key, n: name, at: new Date().toISOString() });
    if (list.length) all[id] = list.slice(-50);
    else delete all[id];
    if (on !== had) activity = logVote(activity, { at: new Date().toISOString(), key, name, tag, id, title, on }).slice(0, ACTIVITY_MAX);
    await this.ctx.storage.put({ votes: all, activity });
    return { votes: all, activity: activity.slice(0, 150) };
  }
  // Old rounds are kept (last 20) so a mistaken reset can be undone by hand.
  async reset(entry) {
    const m = await this.ctx.storage.get(["votes", "rounds", "activity"]);
    const all = m.get("votes") || {};
    const rounds = m.get("rounds") || [];
    if (Object.keys(all).length) rounds.unshift({ endedAt: entry.at, by: entry.name, votes: all });
    const round = { startedAt: entry.at, by: entry.name };
    const activity = [entry, ...(m.get("activity") || [])].slice(0, ACTIVITY_MAX);
    await this.ctx.storage.put({ votes: {}, rounds: rounds.slice(0, 20), round, activity });
    return { round, activity: activity.slice(0, 150) };
  }
}

// One person voting on several games in a row becomes one line ("voted for
// “A”, “B” and “C”) instead of a line per click. Taking a vote back within
// 15 minutes just removes it from that line; later it's logged on its own.
const VOTE_MERGE_MS = 15 * 60 * 1000;
function listTitles(games) {
  const q = games.map((g) => `“${g.title}”`);
  if (q.length > 5) return `${q.slice(0, 4).join(", ")} and ${q.length - 4} more`;
  return q.length > 1 ? `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}` : q[0];
}
function logVote(activity, { at, key, name, tag, id, title, on }) {
  const recent = (e) => e.kind === "vote" && e.key === key && Date.parse(at) - Date.parse(e.at) < VOTE_MERGE_MS;
  const line = (e, games) => ({ ...e, games, text: `voted for ${listTitles(games)}` });
  if (on) {
    const top = activity[0];
    if (top && recent(top)) return [{ ...line(top, [...top.games.filter((g) => g.id !== id), { id, title }]), at }, ...activity.slice(1)];
    return [line({ at, name, tag, kind: "vote", key }, [{ id, title }]), ...activity];
  }
  const i = activity.findIndex((e) => recent(e) && e.games.some((g) => g.id === id));
  if (i < 0) return [{ at, name, tag, text: `took back their vote for “${title}”` }, ...activity];
  const games = activity[i].games.filter((g) => g.id !== id);
  return games.length
    ? activity.map((e, j) => (j === i ? line(e, games) : e))
    : activity.filter((_, j) => j !== i);
}

const votesDO = (env) => env.VOTES.get(env.VOTES.idFromName("board"));
const voterKey = (name) => name.toLowerCase().replace(/\s+/g, " ");
// Public shape: { itemId: ["Name", ...] } in voting order.
const publicVotes = (all) => Object.fromEntries(Object.entries(all).map(([id, l]) => [id, l.map((v) => v.n)]));

// { votes, round, activity }: round is when the current vote started and who started it.
async function readLive(env) {
  try {
    const { votes, round, activity } = await votesDO(env).state();
    return { votes: publicVotes(votes), round, activity };
  } catch {
    return { votes: {}, round: null, activity: [] }; // never let votes take the board down
  }
}

// Returns the newest 150 entries, or null if the log couldn't be written
// (a save that already happened must not report failure over its log line).
async function logActivity(env, entries) {
  try {
    return await votesDO(env).log(entries);
  } catch {
    return null;
  }
}

async function voteBody(request, env) {
  if (!(await authorized(request, env))) return { error: json({ error: "Wrong password" }, 401) };
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return { error: json({ error: "Bad JSON" }, 400) };
  }
  const name = str(body.name, 30);
  if (!name) return { error: json({ error: "Set your name first" }, 400) };
  return { body, name };
}

async function castVote(request, env) {
  const { body, name, error } = await voteBody(request, env);
  if (error) return error;
  const id = str(body.id, 40);
  const board = (await env.GAMES_KV.get("board", "json")) || { lanes: [] };
  const item = id && board.lanes.filter((l) => !l.trash).flatMap((l) => l.items).find((i) => i.id === id);
  if (!item) return json({ error: "That game isn't on the board anymore" }, 404);
  const { votes, activity } = await votesDO(env).cast(id, item.title, voterKey(name), name, await ipTag(request, env), !!body.on);
  return json({ votes: publicVotes(votes), activity });
}

async function resetVotes(request, env) {
  const { name, error } = await voteBody(request, env);
  if (error) return error;
  const entry = { at: new Date().toISOString(), name, tag: await ipTag(request, env), text: "started a new vote" };
  const { round, activity } = await votesDO(env).reset(entry);
  return json({ votes: {}, round, activity });
}

// ---- activity ---------------------------------------------------------------

// Short anonymous tag per visitor: HMAC of the IP with a secret salt, so the
// same person gets the same tag but the IP itself is never stored or shown.
// Without the ACTIVITY_SALT secret there are no tags: a known salt would let
// anyone check a guessed IP against a tag.
async function ipTag(request, env) {
  if (!env.ACTIVITY_SALT) return "";
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.ACTIVITY_SALT), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip)));
  return [...sig.slice(0, 2)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function describeChanges(before, after) {
  const out = [];
  const q = (s) => `“${s}”`;
  const index = (lanes) => {
    const m = new Map();
    for (const l of lanes) for (const it of l.items) m.set(it.id, { it, lane: l });
    return m;
  };
  const A = index(before), B = index(after);
  const laneName = (l) => (l.trash ? "Trashed" : l.name);

  for (const [id, { it, lane }] of B) {
    const old = A.get(id);
    if (!old) { out.push(`added ${q(it.title)} to ${laneName(lane)}`); continue; }
    if (old.it.suggested && !it.suggested) out.push(`kept suggestion ${q(it.title)}`);
    if (old.lane.id !== lane.id) {
      if (lane.trash) out.push(`trashed ${q(it.title)}`);
      else if (old.lane.trash) out.push(`restored ${q(it.title)} to ${laneName(lane)}`);
      else out.push(`moved ${q(it.title)} from ${laneName(old.lane)} to ${laneName(lane)}`);
    }
    if (old.it.title !== it.title) out.push(`renamed ${q(old.it.title)} to ${q(it.title)}`);
    else if (
      JSON.stringify([old.it.steam, old.it.tags, old.it.url || "", old.it.cover || ""]) !==
      JSON.stringify([it.steam, it.tags, it.url || "", it.cover || ""])
    ) out.push(`edited ${q(it.title)}`);
  }
  for (const [id, { it, lane }] of A) {
    if (!B.has(id)) out.push(it.suggested ? `passed on suggestion ${q(it.title)}` : lane.trash ? `permanently deleted ${q(it.title)}` : `deleted ${q(it.title)}`);
  }

  const LA = new Map(before.map((l) => [l.id, l])), LB = new Map(after.map((l) => [l.id, l]));
  for (const l of after) {
    if (l.trash) continue;
    const o = LA.get(l.id);
    if (!o) { out.push(`added column ${q(l.name)}`); continue; }
    if (o.name !== l.name) out.push(`renamed column ${q(o.name)} to ${q(l.name)}`);
    if (o.color !== l.color) out.push(`recolored ${q(l.name)}`);
    if (!!o.sortByDiscount !== !!l.sortByDiscount) out.push(`${l.sortByDiscount ? "turned on" : "turned off"} price sorting for ${q(l.name)}`);
    if ((o.showPrices !== false) !== (l.showPrices !== false)) out.push(`${l.showPrices !== false ? "turned on" : "turned off"} prices for ${q(l.name)}`);
  }
  for (const l of before) if (!l.trash && !LB.has(l.id)) out.push(`deleted column ${q(l.name)}`);
  const order = (ls) => ls.filter((l) => !l.trash && LA.has(l.id) && LB.has(l.id)).map((l) => l.id).join();
  if (order(before) !== order(after)) out.push("reordered columns");

  return out;
}

// ---- Steam ----------------------------------------------------------------

// shared.cloudflare.steamstatic.com 301-redirects every image here; go direct.
const ASSET_BASE = "https://shared.steamstatic.com/store_item_assets/";

// lanes === null: refresh everything. Otherwise only fetch IDs not cached yet.
async function refreshSteam(env, lanes) {
  const full = lanes === null;
  const cache = (await env.GAMES_KV.get("steam", "json")) || { apps: {} };
  if (full) lanes = ((await env.GAMES_KV.get("board", "json")) || { lanes: [] }).lanes;
  const all = [...new Set(lanes.flatMap((l) => l.items.flatMap((i) => i.steam)))];
  const todo = full ? all : all.filter((a) => !cache.apps[a]);
  if (!todo.length) return cache;

  const apps = full ? {} : { ...cache.apps };
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50);
    for (const a of chunk) apps[a] = { ...(cache.apps[a] || {}) };

    try {
      const r = await fetch(
        `https://store.steampowered.com/api/appdetails?filters=price_overview&cc=us&appids=${chunk.join(",")}`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      const data = await r.json();
      for (const [a, v] of Object.entries(data || {})) {
        const po = v && v.data && !Array.isArray(v.data) ? v.data.price_overview : null;
        apps[a].price = po
          ? {
              discount: po.discount_percent,
              final: po.final_formatted,
              initial: po.initial_formatted,
            }
          : null;
      }
    } catch (e) {
      console.log("price lookup failed", e);
    }

    try {
      const q = JSON.stringify({
        ids: chunk.map((a) => ({ appid: Number(a) })),
        context: { language: "english", country_code: "US" },
        data_request: { include_assets: true, include_platforms: true, include_release: true },
      });
      const r = await fetch(
        `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(q)}`
      );
      const items = ((await r.json()).response || {}).store_items || [];
      for (const it of items) {
        const as = it.assets || {};
        const name = as.library_capsule || as.header;
        if (as.asset_url_format && name) {
          apps[String(it.appid)].cover = ASSET_BASE + as.asset_url_format.replace("${FILENAME}", name);
        }
        if (it.name) apps[String(it.appid)].name = it.name;
        apps[String(it.appid)].earlyAccess = !!(it.is_early_access || it.release?.is_early_access);
        const pf = it.platforms;
        if (pf) {
          Object.assign(apps[String(it.appid)], {
            deck: pf.steam_deck_compat_category || 0, // 0 unknown, 1 unsupported, 2 playable, 3 verified
            steamos: pf.steam_os_compat_category || 0,
            linuxNative: !!pf.steamos_linux,
          });
        }
      }
    } catch (e) {
      console.log("cover lookup failed", e);
    }
  }
  // ProtonDB tiers change slowly, and Workers cap outbound requests per run,
  // so refresh a rotating slice each time (oldest first), plus any new games.
  const proton = Object.keys(apps)
    .filter((a) => full || !apps[a].proton)
    .sort((x, y) => ((apps[x].proton || {}).checked || "").localeCompare((apps[y].proton || {}).checked || ""))
    .slice(0, full ? 30 : 15);
  await Promise.all(proton.map(async (a) => {
    try {
      const r = await fetch(`https://www.protondb.com/api/v1/reports/summaries/${a}.json`, { headers: { "User-Agent": "Mozilla/5.0" } });
      const d = r.ok ? await r.json() : null;
      apps[a].proton = { tier: d ? d.tier : null, checked: new Date().toISOString() };
    } catch (e) {
      console.log("protondb lookup failed", a, e);
    }
  }));

  const next = { updated: full ? new Date().toISOString() : cache.updated || new Date().toISOString(), apps };
  await env.GAMES_KV.put("steam", JSON.stringify(next));
  return next;
}

async function steamSearch(q) {
  q = q.trim().slice(0, 300);
  if (!q) return json({ items: [] });
  // A pasted store/community link (or a bare app id) resolves straight to that app.
  const link = /(?:steampowered\.com|steamcommunity\.com)\/app\/(\d{1,9})/i.exec(q) || /^(\d{1,9})$/.exec(q);
  if (link) {
    const input = JSON.stringify({
      ids: [{ appid: Number(link[1]) }],
      context: { language: "english", country_code: "US" },
      data_request: { include_assets: true },
    });
    const r = await fetch(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(input)}`)
      .then((r) => r.json()).catch(() => ({}));
    const it = ((r.response || {}).store_items || [])[0];
    if (it && it.name) {
      const as = it.assets || {};
      const file = as.small_capsule || as.header;
      const image = as.asset_url_format && file ? ASSET_BASE + as.asset_url_format.replace("${FILENAME}", file) : "";
      return json({ items: [{ id: link[1], name: it.name, image }] });
    }
    if (!/^\d+$/.test(q)) return json({ items: [] });
  }
  q = q.slice(0, 100);
  const r = await fetch(
    `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&cc=us&l=en`,
    { headers: { "User-Agent": "Mozilla/5.0" } }
  );
  const data = await r.json().catch(() => ({}));
  return json({
    items: (data.items || []).slice(0, 8).map((i) => ({ id: String(i.id), name: i.name, image: i.tiny_image })),
  });
}

// Small pre-resized covers (192x288 JPEG) made by make-thumbs.py on the Mac.
async function thumb(file, env) {
  const m = /^(\d{1,9})\.jpg$/.exec(file);
  if (!m) return new Response("Not found", { status: 404 });
  const value = await env.GAMES_KV.get(`thumb:${m[1]}`, { type: "arrayBuffer", cacheTtl: 86400 });
  if (!value) return new Response("Not found", { status: 404 });
  return new Response(value, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=2592000, immutable" },
  });
}

async function image(name, env) {
  if (!/^[\w.-]+$/.test(name)) return new Response("Not found", { status: 404 });
  const { value, metadata } = await env.GAMES_KV.getWithMetadata(`img:${name}`, "arrayBuffer");
  if (!value) return new Response("Not found", { status: 404 });
  return new Response(value, {
    headers: {
      "Content-Type": (metadata && metadata.type) || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
