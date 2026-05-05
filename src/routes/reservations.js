const router = require("express").Router();
const {
  requireAdmin,
  listAdminReservations,
  dashboardStats,
  lookupReservations,
} = require("../controllers/reservationsController");

router.get("/admin/dashboard", requireAdmin, dashboardStats);
router.get("/admin/reservations", requireAdmin, listAdminReservations);
router.post("/reservations/lookup", lookupReservations);

module.exports = router;
