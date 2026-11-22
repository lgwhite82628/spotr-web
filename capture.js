// Photo → resize (which also strips location and other metadata) → upload → Claude names the car.
// The server enforces the daily limits; this page just shows its answer.

/** Downscales to at most 1600px on the long edge and re-encodes as JPEG (no EXIF/GPS survives). */
async function prepare(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  return { blob, phash: dHash(bitmap) };
}

/** 64-bit difference hash, hex — the server uses it to catch the same photo uploaded twice. */
function dHash(bitmap) {
  const c = document.createElement("canvas");
  c.width = 9; c.height = 8;
  const g = c.getContext("2d");
  g.drawImage(bitmap, 0, 0, 9, 8);
  const px = g.getImageData(0, 0, 9, 8).data;
  const lum = (x, y) => { const i = (y * 9 + x) * 4; return px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114; };
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (lum(x, y) > lum(x + 1, y) ? 1n : 0n);
  return bits.toString(16).padStart(16, "0");
}

/** Reason-specific help, since "location failed" alone leaves people stuck. */
function locationHelp(err) {
  const iphone = /iPhone|iPad/.test(navigator.userAgent);
  if (!window.isSecureContext) return "Location needs the https:// link. Open SPOTR from the link you were sent.";
  if (err?.code === 1) {
    return iphone
      ? "Location is blocked. On your iPhone: Settings → Privacy & Security → Location Services → turn it on, and set Safari Websites to \"While Using\". Then tap aA in Safari's address bar → Website Settings → Location → Allow, and try again."
      : "Location is blocked for this site. Allow it in your browser's site settings (the icon next to the address), then try again.";
  }
  if (err?.code === 3) return "Finding your location took too long. Step outside or near a window and try again.";
  return "Couldn't find your location. Check Location Services is on and try again.";
}

/** Quick, approximate fix first (good enough for the area); a slow precise fix only if that fails. */
function locate() {
  const ask = (opts) => new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, opts));
  if (!navigator.geolocation) return Promise.reject(new Error("This browser can't share a location. Try Safari or Chrome."));
  return ask({ enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60000 })
    .catch((first) => first.code === 1 ? Promise.reject(first) : ask({ enableHighAccuracy: true, timeout: 25000, maximumAge: 0 }))
    .catch((err) => Promise.reject(new Error(locationHelp(err))));
}

/** Ask as soon as the Spot tab opens, so the permission prompt isn't a surprise mid-upload. */
let warmed = false;
function warmLocation() {
  if (warmed || !navigator.geolocation) return;
  warmed = true;
  locate().catch((e) => status(e.message));
}

function status(text) {
  $("result").replaceChildren(el("div", { class: "card center" }, el("p", { class: "big" }, text)));
}

function reveal(r) {
  const card = el("div", { class: "card stack reveal center" },
    el("p", { class: "hint" }, "YOU SPOTTED"),
    el("p", { class: "car big" }, carName(r.vehicle)),
    tierBadge(r.tier),
    el("span", { class: "points", style: `color:${TIER_COLORS[r.tier]}` }, `${r.points} pts`),
    r.localStory ? el("p", { class: "hint" }, r.localStory) : null,
    el("ul", { class: "breakdown" }, (r.breakdown || []).map((b) =>
      el("li", {}, el("span", {}, b.label), el("span", {}, `×${Number(b.factor).toFixed(2)}`)))),
    r.verification === "pending_review" ? el("p", { class: "hint" }, "Held for a quick review before friends see it.") : null,
    el("button", { class: "ghost", onclick: () => showTab("feed") }, "See it in your feed"));
  $("result").replaceChildren(card);
}

function choose(r) {
  const box = el("div", { class: "card stack" }, el("p", { class: "big" }, "Which one is it?"));
  for (const c of r.candidates) {
    const b = el("button", { class: "ghost" }, `${[c.make, c.model, c.generation].filter(Boolean).join(" ")} (${c.year_start}${c.year_end ? "–" + c.year_end : "+"})`);
    b.addEventListener("click", () => send({ action: "choose", spotId: r.spotId, vehicleId: c.vehicleId }));
    box.append(b);
  }
  $("result").replaceChildren(box);
}

async function send(body) {
  status("Identifying…");
  const { data, error } = await db.functions.invoke("identify-spot", { body });
  if (error) {
    let detail = "";
    try { detail = (await error.context.json()).message || ""; } catch {}
    throw new Error(detail.includes("rate") ? "Too many tries. Wait a minute." : "Couldn't identify that. Try again.");
  }
  handle(data);
}

function handle(r) {
  switch (r.status) {
    case "scored": return reveal(r);
    case "needs_choice": return r.candidates?.length ? choose(r) : status("Couldn't tell which car that is. Try a clearer photo.");
    case "not_a_car": return status("That doesn't look like a car. Try again.");
    case "limited": return status(r.message);
    case "community_id": return status("Sent to the community to identify.");
    default: return status("Something went wrong. Try again.");
  }
}

document.querySelector('.tabs button[data-tab="spot"]').addEventListener("click", warmLocation);

$("photo").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    status("Getting your location…");
    const [pos, prepared] = await Promise.all([locate(), prepare(file)]);
    status("Uploading…");
    const path = `${me.id}/${crypto.randomUUID()}.jpg`;
    const { error: upErr } = await db.storage.from("spot-uploads").upload(path, prepared.blob, { contentType: "image/jpeg" });
    if (upErr) throw upErr;
    await send({
      action: "identify", photoPath: path, phash: prepared.phash,
      capture: {
        lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: Math.round(pos.coords.accuracy || 50),
        capturedAt: new Date().toISOString(), deviceSpeedMps: 0, passengerConfirmed: true, targetMoving: false,
        source: "live",
      },
    });
  } catch (e) {
    status(message(e));
  }
});
start();
