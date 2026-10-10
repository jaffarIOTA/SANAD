-- 0021_shariah_revision_areas.sql
-- Sanad — Shariah parameters change only under four eyes (SR-025).
--
-- Structure definitions and the board's standing positions (risk-holding floor,
-- excluded goods, approved document templates) become configuration revision
-- areas. A change is proposed by one person and is not effective until a
-- different person approves it — `config.revision_four_eyes`, unchanged — and
-- `config.effective_revision` returns it only from its effective moment. The
-- checked-in files remain the fallback when no revision has been approved.
--
-- Portable PostgreSQL. Idempotent.

alter table config.revision drop constraint if exists revision_area_check;
alter table config.revision add constraint revision_area_check check (area in (
  'PRODUCTS', 'RAILS', 'STAFF_IDENTITY', 'PARTNERS', 'CREDIT_POLICY', 'ORIGINATION_POLICY',
  'STRUCTURES', 'BOARD_POSITIONS'
));
