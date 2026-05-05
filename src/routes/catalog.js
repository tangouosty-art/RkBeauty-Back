// back/src/routes/catalog.js
const router = require("express").Router();

const {
  requireAdmin,
  listPublicFormations,
  listAdminFormations,
  createAdminFormation,
  updateAdminFormation,
  deleteAdminFormation,
  listPublicServices,
  listAdminServices,
  createAdminService,
  updateAdminService,
  deleteAdminService,
} = require("../controllers/catalogController");

// Public
router.get("/formations", listPublicFormations);
router.get("/services", listPublicServices);

// Admin catalogue formations
router.get("/admin/formations", requireAdmin, listAdminFormations);
router.post("/admin/formations", requireAdmin, createAdminFormation);
router.patch("/admin/formations/:id", requireAdmin, updateAdminFormation);
router.delete("/admin/formations/:id", requireAdmin, deleteAdminFormation);

// Admin prestations/services
router.get("/admin/services", requireAdmin, listAdminServices);
router.post("/admin/services", requireAdmin, createAdminService);
router.patch("/admin/services/:id", requireAdmin, updateAdminService);
router.delete("/admin/services/:id", requireAdmin, deleteAdminService);

module.exports = router;
