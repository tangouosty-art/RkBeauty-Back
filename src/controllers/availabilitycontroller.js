const db = require("../../db");

const DEFAULT_QUOTAS = {
  service:   { morning: 8, afternoon: 8 },
  formation: { morning: 8, afternoon: 8 },
};

async function loadBaseQuotas(type) {
  try {
    const [rows] = await db.query("SELECT * FROM quotas WHERE type=?", [type]);
    let q = { ...DEFAULT_QUOTAS[type] };
    for (const r of rows) {
      if (r.slot === "morning")   q.morning   = Number(r.max_places);
      if (r.slot === "afternoon") q.afternoon = Number(r.max_places);
    }
    return q;
  } catch {
    return DEFAULT_QUOTAS[type];
  }
}

async function loadOverrides(date, type) {
  const [rows] = await db.query(
    "SELECT slot, `open`, quota FROM schedule_overrides WHERE date=? AND type=?",
    [date, type]
  );
  const out = { morning: null, afternoon: null };
  for (const r of rows) {
    if (r.slot === "morning")   out.morning   = { open: !!r.open, quota: r.quota != null ? Number(r.quota) : null };
    if (r.slot === "afternoon") out.afternoon = { open: !!r.open, quota: r.quota != null ? Number(r.quota) : null };
  }
  return out;
}

async function getAvailability(req, res) {
  const date = req.query.date;
  const type = (req.query.type || "service").toLowerCase();

  if (!date) return res.status(400).json({ message: "date requise" });
  if (!["service", "formation"].includes(type)) {
    return res.status(400).json({ message: "type invalide (service|formation)" });
  }

  try {
    await db.query("DELETE FROM reservation_holds WHERE expires_at <= NOW()");

    const base = await loadBaseQuotas(type);
    const ov   = await loadOverrides(date, type);

    const morningOpen  = ov.morning   ? ov.morning.open   : true;
    const afternoonOpen = ov.afternoon ? ov.afternoon.open : true;
    const morningQuota   = ov.morning   && ov.morning.quota   != null ? ov.morning.quota   : base.morning;
    const afternoonQuota = ov.afternoon && ov.afternoon.quota != null ? ov.afternoon.quota : base.afternoon;

    // Une ligne par réservation — COUNT(*) est correct
    // Pour les formations : date_start <= date <= date_end
    // Pour les services   : date_start = date_end = date
    const [[paidMorning]] = await db.query(
      "SELECT COUNT(*) AS total FROM reservations WHERE date_start <= ? AND date_end >= ? AND slot='morning' AND type=? AND status='paid'",
      [date, date, type]
    );
    const [[paidAfternoon]] = await db.query(
      "SELECT COUNT(*) AS total FROM reservations WHERE date_start <= ? AND date_end >= ? AND slot='afternoon' AND type=? AND status='paid'",
      [date, date, type]
    );
    const [[holdMorning]] = await db.query(
      "SELECT COUNT(*) AS total FROM reservation_holds WHERE date_start <= ? AND date_end >= ? AND slot='morning' AND type=? AND expires_at > NOW()",
      [date, date, type]
    );
    const [[holdAfternoon]] = await db.query(
      "SELECT COUNT(*) AS total FROM reservation_holds WHERE date_start <= ? AND date_end >= ? AND slot='afternoon' AND type=? AND expires_at > NOW()",
      [date, date, type]
    );

    const remainingMorning   = morningOpen   ? Math.max(0, morningQuota   - (Number(paidMorning.total)   + Number(holdMorning.total)))   : 0;
    const remainingAfternoon = afternoonOpen ? Math.max(0, afternoonQuota - (Number(paidAfternoon.total) + Number(holdAfternoon.total))) : 0;

    return res.json({
      date,
      type,
      slots: {
        morning: {
          open: morningOpen,
          quota: morningQuota,
          reserved: Number(paidMorning.total),
          holds: Number(holdMorning.total),
          remaining: remainingMorning,
        },
        afternoon: {
          open: afternoonOpen,
          quota: afternoonQuota,
          reserved: Number(paidAfternoon.total),
          holds: Number(holdAfternoon.total),
          remaining: remainingAfternoon,
        },
      },
    });
  } catch (err) {
    console.error("getAvailability error:", err);
    return res.status(500).json({ message: "Erreur disponibilité", details: err?.code || err?.message });
  }
}

module.exports = { getAvailability };