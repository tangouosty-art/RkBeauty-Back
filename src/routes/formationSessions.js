// back/src/routes/formationSessions.js
const router = require("express").Router();

const {
  requireAdmin,
  listPublicSessions,
  getPublicSessionById,
  listAdminSessions,
  createAdminSession,
  updateAdminSession,
  deleteAdminSession,
} = require("../controllers/formationSessionsController");

// ─── PUBLIC (sans authentification) ───────────────────────

// Sessions d'une formation par code
router.get("/formation-sessions", listPublicSessions);

// Détail d'une session par id
router.get("/formation-sessions/:id", getPublicSessionById);

// ─── ADMIN (token x-admin-token requis) ───────────────────

router.get("/admin/formation-sessions",         requireAdmin, listAdminSessions);
router.post("/admin/formation-sessions",        requireAdmin, createAdminSession);
router.patch("/admin/formation-sessions/:id",   requireAdmin, updateAdminSession);
router.delete("/admin/formation-sessions/:id",  requireAdmin, deleteAdminSession);

module.exports = router;