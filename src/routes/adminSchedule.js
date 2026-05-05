// back/src/routes/adminSchedule.js
const router = require("express").Router();
const db = require("../../db"); // adapte si votre db.js est ailleurs

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
}

// Helpers
const DEFAULTS = {
  morning: { open: true, quota: 6 },
  afternoon: { open: true, quota: 6 }
};

function assertType(type) {
  return type === "service" || type === "formation";
}

// GET /admin/schedule?date=YYYY-MM-DD&type=service|formation
router.get("/schedule", requireAdmin, async (req, res) => {
  const { date, type } = req.query;

  if (!date) return res.status(400).json({ message: "date manquante" });
  if (!assertType(type)) return res.status(400).json({ message: "type invalide (service|formation)" });

  try {
    const [rows] = await db.query(
      "SELECT slot, `open`, quota FROM schedule_overrides WHERE date=? AND type=?",
      [date, type]
    );

    const out = {
      date,
      type,
      morning: { ...DEFAULTS.morning },
      afternoon: { ...DEFAULTS.afternoon }
    };

    for (const r of rows) {
      if (r.slot === "morning") {
        out.morning.open = !!r.open;
        out.morning.quota = Number(r.quota);
      } else if (r.slot === "afternoon") {
        out.afternoon.open = !!r.open;
        out.afternoon.quota = Number(r.quota);
      }
    }

    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Erreur admin schedule GET" });
  }
});

// PUT /admin/schedule?date=YYYY-MM-DD&type=service|formation
// body: { morning:{open,quota}, afternoon:{open,quota} }
router.put("/schedule", requireAdmin, async (req, res) => {
  const { date, type } = req.query;
  const body = req.body || {};

  if (!date) return res.status(400).json({ message: "date manquante" });
  if (!assertType(type)) return res.status(400).json({ message: "type invalide (service|formation)" });

  const morning = body.morning || {};
  const afternoon = body.afternoon || {};

  const mOpen = morning.open ?? DEFAULTS.morning.open;
  const aOpen = afternoon.open ?? DEFAULTS.afternoon.open;

  const mQuota = Number(morning.quota ?? DEFAULTS.morning.quota);
  const aQuota = Number(afternoon.quota ?? DEFAULTS.afternoon.quota);

  if (!Number.isFinite(mQuota) || mQuota < 0) return res.status(400).json({ message: "quota matin invalide" });
  if (!Number.isFinite(aQuota) || aQuota < 0) return res.status(400).json({ message: "quota après-midi invalide" });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Upsert morning
    await conn.query(
      `INSERT INTO schedule_overrides(date, type, slot, \`open\`, quota)
       VALUES(?, ?, 'morning', ?, ?)
       ON DUPLICATE KEY UPDATE \`open\`=VALUES(\`open\`), quota=VALUES(quota)`,
      [date, type, mOpen ? 1 : 0, mQuota]
    );

    // Upsert afternoon
    await conn.query(
      `INSERT INTO schedule_overrides(date, type, slot, \`open\`, quota)
       VALUES(?, ?, 'afternoon', ?, ?)
       ON DUPLICATE KEY UPDATE \`open\`=VALUES(\`open\`), quota=VALUES(quota)`,
      [date, type, aOpen ? 1 : 0, aQuota]
    );

    await conn.commit();
    return res.json({ ok: true });
    } catch (e) {
  await conn.rollback();
  console.error(e);
  return res.status(500).json({
    message: "Erreur admin schedule PUT",
    details: e?.code || e?.message
  });
  }finally {
    conn.release();
  }
});

// DELETE /admin/schedule?date=YYYY-MM-DD&type=service|formation
// = reset (supprime les overrides)
router.delete("/schedule", requireAdmin, async (req, res) => {
  const { date, type } = req.query;

  if (!date) return res.status(400).json({ message: "date manquante" });
  if (!assertType(type)) return res.status(400).json({ message: "type invalide (service|formation)" });

  try {
    await db.query("DELETE FROM schedule_overrides WHERE date=? AND type=?", [date, type]);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Erreur admin schedule DELETE" });
  }
});

module.exports = router;
