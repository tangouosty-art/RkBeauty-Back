-- Données de démonstration optionnelles
-- À exécuter après reservations_db.sql si vous voulez voir des sessions directement.

USE reservations_db;

INSERT IGNORE INTO formation_sessions
  (formation_code, formation_label, price_eur, days_count, start_date, slot_policy, status, capacity, note)
VALUES
  ('F2J-100', 'Formation Auto-Maquillage — 2 jours', 100, 2, DATE_ADD(CURDATE(), INTERVAL 7 DAY), 'both', 'published', 6, 'Session démo'),
  ('F2J-150', 'Formation Perfectionnement Maquilleuse — 2 jours', 150, 2, DATE_ADD(CURDATE(), INTERVAL 14 DAY), 'both', 'published', 6, 'Session démo'),
  ('F4J-200', 'Formation Auto-Maquillage — 4 jours', 200, 4, DATE_ADD(CURDATE(), INTERVAL 21 DAY), 'both', 'published', 6, 'Session démo'),
  ('F4J-250', 'Formation Perfectionnement Pro — 4 jours', 250, 4, DATE_ADD(CURDATE(), INTERVAL 28 DAY), 'both', 'published', 6, 'Session démo'),
  ('F7J-300', 'Formation Auto-Maquillage Pro — 7 jours', 300, 7, DATE_ADD(CURDATE(), INTERVAL 35 DAY), 'both', 'published', 6, 'Session démo'),
  ('F7J-350', 'Formation Perfectionnement Pro — 7 jours', 350, 7, DATE_ADD(CURDATE(), INTERVAL 42 DAY), 'both', 'published', 6, 'Session démo'),
  ('F2S-600', 'Formation Auto-Maquillage — 2 semaines', 600, 14, DATE_ADD(CURDATE(), INTERVAL 49 DAY), 'both', 'published', 6, 'Session démo'),
  ('F2S-650', 'Formation Perfectionnement — 2 semaines', 650, 14, DATE_ADD(CURDATE(), INTERVAL 56 DAY), 'both', 'published', 6, 'Session démo'),
  ('F4S-1300', 'Formation Professionnelle — 1 mois', 1300, 28, DATE_ADD(CURDATE(), INTERVAL 63 DAY), 'both', 'published', 6, 'Session démo'),
  ('I7J-650', 'Formation Maquillage Intensif — 7 jours avec kit', 650, 7, DATE_ADD(CURDATE(), INTERVAL 70 DAY), 'both', 'published', 6, 'Session démo'),
  ('I14J-900', 'Formation Maquillage Intensif — 14 jours avec kit', 900, 14, DATE_ADD(CURDATE(), INTERVAL 77 DAY), 'both', 'published', 6, 'Session démo'),
  ('P7J-250', 'Promo spéciale — 7 jours', 250, 7, DATE_ADD(CURDATE(), INTERVAL 84 DAY), 'both', 'published', 6, 'Session démo'),
  ('P2S-350', 'Promo spéciale — 14 jours', 350, 14, DATE_ADD(CURDATE(), INTERVAL 91 DAY), 'both', 'published', 6, 'Session démo');

-- Générer les dates pour chaque session insérée ci-dessus.
-- MySQL 8+ : utilise CTE récursive.
WITH RECURSIVE seq(n) AS (
  SELECT 0
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 60
)
INSERT IGNORE INTO formation_session_dates (session_id, session_date)
SELECT fs.id, DATE_ADD(fs.start_date, INTERVAL seq.n DAY)
FROM formation_sessions fs
JOIN seq ON seq.n < fs.days_count
WHERE fs.note = 'Session démo';
