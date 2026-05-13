// back/src/routes/adminSchedule.js
const router = require("express").Router();
const db = require("../../db");

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

const DEFAULTS = {
  morning:       { open: true, quota: 3 },
  afternoon:     { open: true, quota: 3 },
  early_morning: { open: true, quota: 8 },
};

const SERVICE_HOURS = ["09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00","22:00"];

function assertType(type) {
  return type === "service" || type === "formation";
}

// GET /admin/schedule?date=YYYY-MM-DD&type=service|formation&session_id=N
router.get("/schedule", requireAdmin, async (req, res) => {
  const { date, type, session_id } = req.query;
  if (!date) return res.status(400).json({ message: "date manquante" });
  if (!assertType(type)) return res.status(400).json({ message: "type invalide" });

  try {
    let rows;
    if (type === "formation" && session_id) {
      [rows] = await db.query(
        "SELECT slot, time_slot, `open`, quota FROM schedule_overrides WHERE date=? AND type=? AND formation_session_id=?",
        [date, type, Number(session_id)]
      );
      if (!rows.length) {
        [rows] = await db.query(
          "SELECT slot, time_slot, `open`, quota FROM schedule_overrides WHERE date=? AND type=? AND formation_session_id IS NULL",
          [date, type]
        );
      }
    } else {
      [rows] = await db.query(
        "SELECT slot, time_slot, `open`, quota FROM schedule_overrides WHERE date=? AND type=? AND formation_session_id IS NULL",
        [date, type]
      );
    }

    if (type === "service") {
      const overrideMap = {};
      for (const r of rows) {
        const key = r.time_slot || r.slot;
        overrideMap[key] = { open: !!r.open, quota: r.quota != null ? Number(r.quota) : 3 };
      }
      const morning = SERVICE_HOURS.filter(h => parseInt(h) < 14).map(h => ({
        time: h, open: overrideMap[h] ? overrideMap[h].open : true, quota: overrideMap[h] ? overrideMap[h].quota : 3,
      }));
      const afternoon = SERVICE_HOURS.filter(h => parseInt(h) >= 14).map(h => ({
        time: h, open: overrideMap[h] ? overrideMap[h].open : true, quota: overrideMap[h] ? overrideMap[h].quota : 3,
      }));
      return res.json({ date, type, mode: "hourly", slots: { morning, afternoon } });
    }

    const out = {
      date, type, session_id: session_id || null,
      morning:       { ...DEFAULTS.morning },
      afternoon:     { ...DEFAULTS.afternoon },
      early_morning: { ...DEFAULTS.early_morning },
    };
    for (const r of rows) {
      if (!r.time_slot && r.slot === "morning")       { out.morning.open = !!r.open; out.morning.quota = Number(r.quota ?? 8); }
      if (!r.time_slot && r.slot === "afternoon")     { out.afternoon.open = !!r.open; out.afternoon.quota = Number(r.quota ?? 8); }
      if (!r.time_slot && r.slot === "early_morning") { out.early_morning.open = !!r.open; out.early_morning.quota = Number(r.quota ?? 8); }
    }
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Erreur admin schedule GET", details: e?.message });
  }
});

// PUT /admin/schedule?date=YYYY-MM-DD&type=service|formation&session_id=N
router.put("/schedule", requireAdmin, async (req, res) => {
  const { date, type, session_id } = req.query;
  const body = req.body || {};
  if (!date) return res.status(400).json({ message: "date manquante" });
  if (!assertType(type)) return res.status(400).json({ message: "type invalide" });

  const sessionIdVal = session_id ? Number(session_id) : null;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    if (type === "service") {
      const hours = body.hours || {};
      for (const [hour, config] of Object.entries(hours)) {
        if (!SERVICE_HOURS.includes(hour)) continue;
        const slotName = parseInt(hour) < 14 ? "morning" : "afternoon";
        await conn.query(
          `INSERT INTO schedule_overrides(date, type, formation_session_id, slot, time_slot, \`open\`, quota)
           VALUES(?, ?, NULL, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE \`open\`=VALUES(\`open\`), quota=VALUES(quota)`,
          [date, type, slotName, hour, (config.open ?? true) ? 1 : 0, Number(config.quota ?? 3)]
        );
      }
    } else {
      const slots = {
        morning:       body.morning       || {},
        afternoon:     body.afternoon     || {},
        early_morning: body.early_morning || {},
      };
      for (const [slotName, config] of Object.entries(slots)) {
        await conn.query(
          `INSERT INTO schedule_overrides(date, type, formation_session_id, slot, time_slot, \`open\`, quota)
           VALUES(?, ?, ?, ?, NULL, ?, ?)
           ON DUPLICATE KEY UPDATE \`open\`=VALUES(\`open\`), quota=VALUES(quota)`,
          [date, type, sessionIdVal, slotName, (config.open ?? true) ? 1 : 0, Number(config.quota ?? 8)]
        );
      }
    }

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    return res.status(500).json({ message: "Erreur admin schedule PUT", details: e?.code || e?.message });
  } finally {
    conn.release();
  }
});

// DELETE /admin/schedule?date=YYYY-MM-DD&type=service|formation&session_id=N
router.delete("/schedule", requireAdmin, async (req, res) => {
  const { date, type, session_id } = req.query;
  if (!date) return res.status(400).json({ message: "date manquante" });
  if (!assertType(type)) return res.status(400).json({ message: "type invalide" });
  try {
    if (session_id) {
      await db.query("DELETE FROM schedule_overrides WHERE date=? AND type=? AND formation_session_id=?", [date, type, Number(session_id)]);
    } else {
      await db.query("DELETE FROM schedule_overrides WHERE date=? AND type=? AND formation_session_id IS NULL", [date, type]);
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Erreur admin schedule DELETE" });
  }
});

module.exports = router;