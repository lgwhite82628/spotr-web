// SPOTR on the web: pick a username, photograph cars, see your friends' spots.
// Talks to the same Supabase backend as the iPhone app. The key below is the public "anon" key:
// it's meant to be in web pages; what anyone can do is decided by the database's rules.
const SUPABASE_URL = "https://sixgtmorawrvjnojjdie.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNpeGd0bW9yYXdydmpub2pqZGllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzMDc1NzUsImV4cCI6MjExMDg4MzU3NX0.CDfs_aaeNqJO8f_AmkHnWkRl0f_gtKoI3NiLoQVbohk";

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
const $ = (id) => document.getElementById(id);
const TIER_COLORS = { common: "var(--common)", uncommon: "var(--uncommon)", rare: "var(--rare)",
  epic: "var(--epic)", legendary: "var(--legendary)", unicorn: "var(--unicorn)" };
let me = null;
let feedCursor = null;

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

/** Database errors look like "spotr:validation:<message for people>". */
function message(error) {
  const m = String(error?.message || error || "Something went wrong.");
  const match = m.match(/spotr:validation:(.*)/);
  if (match) return match[1];
  if (m.includes("spotr:blocked")) return "You can't do that with this person.";
  if (/fetch|network/i.test(m)) return "No connection. Try again.";
  return m.replace(/^spotr:/, "");
}

async function rpc(name, args = {}) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}

function avatar(user) {
  return el("span", { class: "avatar" }, (user.displayName || user.handle || "?").slice(0, 1).toUpperCase());
}

function tierBadge(tier) {
  return el("span", { class: "tier", style: `background:${TIER_COLORS[tier] || "var(--common)"}` }, tier);
}

function carName(v) {
  return [v.make, v.model, v.generation].filter(Boolean).join(" ");
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---------- sign-up ----------

async function start() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return showJoin();
  try {
    const profile = await rpc("profile", { p_handle: null });
    if (profile.user.handle.startsWith("spotter_")) return showJoin();   // never finished picking a name
    me = profile.user;
    showApp();
  } catch (e) {
    showJoin();
  }
}

function showJoin() {
  $("app").hidden = true;
  $("join").hidden = false;
}

$("join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const error = $("join-error");
  error.hidden = true;
  button.disabled = true;
  try {
    const handle = $("join-handle").value.trim().toLowerCase().replace(/^@/, "");
    const name = $("join-name").value.trim();
    const { data: { session } } = await db.auth.getSession();
    if (!session) {
      const { error: signErr } = await db.auth.signInAnonymously();
      if (signErr) throw signErr;
    }
    if (!(await rpc("handle_available", { p_handle: handle }))) throw new Error(`spotr:validation:@${handle} is taken.`);
    const profile = await rpc("update_profile", { p_display_name: name, p_handle: handle, p_bio: "" });
    me = profile.user;
    showApp();
  } catch (e) {
    error.textContent = message(e);
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});

// ---------- tabs ----------

function showApp() {
  $("join").hidden = true;
  $("app").hidden = false;
  $("me").textContent = `@${me.handle}`;
  showTab("feed");
}

function showTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("active", b.dataset.tab === name);
  for (const t of ["feed", "spot", "friends"]) $(`tab-${t}`).hidden = t !== name;
  if (name === "feed") loadFeed(true);
  if (name === "friends") loadFriends();
  window.scrollTo(0, 0);
}
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));

// ---------- feed ----------

function spotCard(s) {
  return el("article", { class: "card spot" },
    s.photo ? el("img", { src: s.photo, alt: carName(s.vehicle), loading: "lazy" }) : null,
    el("div", { class: "body" },
      el("div", { class: "who" }, avatar(s.author), el("b", {}, s.author.displayName), `@${s.author.handle}`),
      el("p", { class: "car" }, carName(s.vehicle)),
      el("div", { class: "meta" }, tierBadge(s.tier), el("span", { class: "points" }, `${s.points} pts`),
        el("span", {}, [s.area, timeAgo(s.capturedAt)].filter(Boolean).join(" · ")))));
}

async function loadFeed(reset) {
  const feed = $("feed");
  if (reset) { feedCursor = null; feed.replaceChildren(el("p", { class: "empty" }, "Loading…")); }
  try {
    const page = await rpc("feed_page", { p_kind: "following", p_cursor: feedCursor });
    if (reset) feed.replaceChildren();
    for (const s of page.items) feed.append(spotCard(s));
    feedCursor = page.nextCursor;
    $("feed-more").hidden = !feedCursor;
    if (reset && page.items.length === 0) {
      feed.append(el("div", { class: "card empty" },
        el("p", { class: "big" }, "Nothing here yet"),
        el("p", {}, "Spot a car, and add friends to see theirs."),
        el("button", { class: "primary", onclick: () => showTab("friends") }, "Find friends")));
    }
  } catch (e) {
    feed.replaceChildren(el("p", { class: "empty" }, message(e)));
  }
}
$("feed-more").addEventListener("click", () => loadFeed(false));

// ---------- friends ----------

function personRow(user, action) {
  return el("div", { class: "card person" }, avatar(user),
    el("div", { class: "name" }, el("b", {}, user.displayName), el("small", {}, `@${user.handle} · Level ${user.level}`)),
    action);
}

async function addFriend(user, button, accepting) {
  button.disabled = true;
  try {
    await rpc("set_following", { p_user_id: user.id, p_following: true });
    toast(accepting ? `You and @${user.handle} are friends` : `Friend request sent to @${user.handle}`);
    button.textContent = accepting ? "Friends" : "Requested";
    loadFriends();
  } catch (e) {
    toast(message(e));
    button.disabled = false;
  }
}

async function loadFriends() {
  try {
    const [requests, friends] = await Promise.all([rpc("friend_requests"), rpc("friends")]);
    $("requests-title").hidden = requests.length === 0;
    $("requests").replaceChildren(...requests.map((u) => {
      const b = el("button", { class: "primary small-btn" }, "Accept");
      b.addEventListener("click", () => addFriend(u, b, true));
      return personRow(u, b);
    }));
    $("friends").replaceChildren(...(friends.length
      ? friends.map((u) => personRow(u, null))
      : [el("p", { class: "hint" }, "No friends yet. Search for a username, or share SPOTR. You're friends once you've both added each other.")]));
  } catch (e) {
    $("friends").replaceChildren(el("p", { class: "error" }, message(e)));
  }
}

$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const q = $("search").value.trim().replace(/^@/, "");
  const box = $("search-results");
  if (q.length < 2) return box.replaceChildren(el("p", { class: "hint" }, "Type at least 2 letters."));
  try {
    const results = await rpc("search_all", { p_query: q });
    const people = (results.users || []).filter((u) => u.id !== me.id);
    box.replaceChildren(...(people.length ? people.map((u) => {
      const b = el("button", { class: "primary small-btn" }, "Add");
      b.addEventListener("click", () => addFriend(u, b, false));
      return personRow(u, b);
    }) : [el("p", { class: "hint" }, `No one called "${q}" yet.`)]));
  } catch (e) {
    box.replaceChildren(el("p", { class: "error" }, message(e)));
  }
});

$("invite").addEventListener("click", async () => {
  const text = `Spot cars with me on SPOTR. My username is @${me.handle}`;
  const url = location.href.split("#")[0];
  if (navigator.share) { try { await navigator.share({ title: "SPOTR", text, url }); } catch {} }
  else { await navigator.clipboard.writeText(`${text}: ${url}`); toast("Link copied"); }
});
