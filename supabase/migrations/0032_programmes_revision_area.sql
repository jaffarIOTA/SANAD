-- 0032 — trade programmes and their anchors become configuration under four eyes (Wasl W5b).
--
-- A programme's limit, its anchor and the account the institution pays that
-- anchor at are changed in Admin as a PROGRAMMES revision: proposed by one
-- administrator, in force from its stated moment only once a different one
-- approves it (config.revision_four_eyes, unchanged). The checked-in file
-- remains the fallback when no revision has been approved. The board's goods
-- register is already a BOARD_POSITIONS revision (0021).
--
-- core.programme mirrors the limit in force when a transaction or facility next
-- refers to it; it is informational, the facility's own rows bind (0004, 0031).
--
-- Portable PostgreSQL. Idempotent.

alter table config.revision drop constraint if exists revision_area_check;
alter table config.revision add constraint revision_area_check check (area in (
  'PRODUCTS', 'RAILS', 'STAFF_IDENTITY', 'PARTNERS', 'CREDIT_POLICY', 'ORIGINATION_POLICY',
  'STRUCTURES', 'BOARD_POSITIONS', 'CONCENTRATION', 'PROGRAMMES'
));
