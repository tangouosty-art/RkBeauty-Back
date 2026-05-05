const router = require("express").Router();
const { getAvailability } = require("../controllers/availabilitycontroller");

router.get("/", getAvailability);

module.exports = router;
