const db = require("../../db");

const DEFAULT_QUOTAS = {
  service:   { morning: 3, afternoon: 3 },
  formation: { morning: 8, afternoon: 8, early_morning: 8 },
};

// Créneaux horaires service
const MORNING_HOURS   = ["09:00","10:00","11:00","12:00","13:00"];
const AFTERNOON_HOURS = ["14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00","22:00"];

async function loadBaseQuotas(type) {
  try {
    const [rows] = await db.query("SELECT * FROM quotas WHERE type=?", [type]);
    let q = { ...DEFAULT_QUOTAS[type] };
    for (const r of rows) {
      if (r.slot === "morning")       q.morning       = Number(r.max_places);
      if (r.slot === "afternoon")     q.afternoon     = Number(r.max_places);
      if (r.slot === "early_morning") q.early_morning = Number(r.max_places);
    }
    return q;
  } catch {
    return DEFAULT_QUOTAS[type];
  }
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

    // Bloquer les dimanches automatiquement
    const dayOfWeek = new Date(date).getDay(); // 0 = dimanche
    if (dayOfWeek === 0) {
      if (type === "service") {
        return res.json({
          date, type, mode: "hourly", quota_per_hour: 0,
          slots: { morning: [], afternoon: [] },
          closed: true, reason: "Fermé le dimanche",
        });
      } else {
        return res.json({
          date, type, mode: "slot", closed: true, reason: "Fermé le dimanche",
          slots: {
            early_morning: { open: false, quota: 0, reserved: 0, holds: 0, remaining: 0 },
            morning:       { open: false, quota: 0, reserved: 0, holds: 0, remaining: 0 },
            afternoon:     { open: false, quota: 0, reserved: 0, holds: 0, remaining: 0 },
          },
        });
      }
    }

    // ── SERVICE : disponibilité par heure ────────────────────────────────
    if (type === "service") {
      const quota = base.morning; // même quota pour matin et après-midi (3/h)

      // Récupérer toutes les réservations payées du jour
      const [paidRows] = await db.query(
        "SELECT time_slot, COUNT(*) AS total FROM reservations WHERE date_start=? AND type='service' AND status='paid' GROUP BY time_slot",
        [date]
      );
      const [holdRows] = await db.query(
        "SELECT time_slot, COUNT(*) AS total FROM reservation_holds WHERE date_start=? AND type='service' AND expires_at > NOW() GROUP BY time_slot",
        [date]
      );

      const paidMap = {};
      for (const r of paidRows) paidMap[r.time_slot] = Number(r.total);
      const holdMap = {};
      for (const r of holdRows) holdMap[r.time_slot] = Number(r.total);

      // Récupérer les overrides (blocages horaires)
      const [overrides] = await db.query(
        "SELECT time_slot, slot, `open`, quota FROM schedule_overrides WHERE date=? AND type='service'",
        [date]
      );
      const overrideMap = {};
      for (const r of overrides) {
        const key = r.time_slot || r.slot;
        overrideMap[key] = { open: !!r.open, quota: r.quota != null ? Number(r.quota) : null };
      }

      function buildHourSlots(hours, slotName) {
        return hours.map(h => {
          const ov = overrideMap[h] || overrideMap[slotName] || null;
          const open  = ov ? ov.open : true;
          const q     = ov && ov.quota != null ? ov.quota : quota;
          const reserved = paidMap[h] || 0;
          const holds    = holdMap[h] || 0;
          const remaining = open ? Math.max(0, q - reserved - holds) : 0;
          return { time: h, open, quota: q, reserved, holds, remaining };
        });
      }

      return res.json({
        date,
        type,
        mode: "hourly",
        quota_per_hour: quota,
        slots: {
          morning:   buildHourSlots(MORNING_HOURS,   "morning"),
          afternoon: buildHourSlots(AFTERNOON_HOURS, "afternoon"),
        },
      });
    }

    // ── FORMATION : disponibilité par créneau (early_morning/morning/afternoon) ──
    const [ovRows] = await db.query(
      "SELECT slot, `open`, quota FROM schedule_overrides WHERE date=? AND type='formation' AND (time_slot IS NULL OR time_slot='')",
      [date]
    );
    const ov = { morning: null, afternoon: null, early_morning: null };
    for (const r of ovRows) {
      if (r.slot === "morning")       ov.morning       = { open: !!r.open, quota: r.quota != null ? Number(r.quota) : null };
      if (r.slot === "afternoon")     ov.afternoon     = { open: !!r.open, quota: r.quota != null ? Number(r.quota) : null };
      if (r.slot === "early_morning") ov.early_morning = { open: !!r.open, quota: r.quota != null ? Number(r.quota) : null };
    }

    async function formationSlot(slotName, baseQuota) {
      const ovSlot = ov[slotName];
      const open  = ovSlot ? ovSlot.open : true;
      const quota = ovSlot && ovSlot.quota != null ? ovSlot.quota : baseQuota;
      const [[paid]] = await db.query(
        "SELECT COUNT(*) AS total FROM reservations WHERE date_start <= ? AND date_end >= ? AND slot=? AND type='formation' AND status='paid'",
        [date, date, slotName]
      );
      const [[holds]] = await db.query(
        "SELECT COUNT(*) AS total FROM reservation_holds WHERE date_start <= ? AND date_end >= ? AND slot=? AND type='formation' AND expires_at > NOW()",
        [date, date, slotName]
      );
      const remaining = open ? Math.max(0, quota - Number(paid.total) - Number(holds.total)) : 0;
      return { open, quota, reserved: Number(paid.total), holds: Number(holds.total), remaining };
    }

    return res.json({
      date,
      type,
      mode: "slot",
      slots: {
        early_morning: await formationSlot("early_morning", base.early_morning || 8),
        morning:       await formationSlot("morning",       base.morning),
        afternoon:     await formationSlot("afternoon",     base.afternoon),
      },
    });

  } catch (err) {
    console.error("getAvailability error:", err);
    return res.status(500).json({ message: "Erreur disponibilité", details: err?.code || err?.message });
  }
}

module.exports = { getAvailability };