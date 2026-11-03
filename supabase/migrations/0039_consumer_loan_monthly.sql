-- 0039_consumer_loan_monthly.sql
-- Sanad — a consumer loan's instalments a number of months apart, as well as a number of days
-- (products/bnpl/terms.ts `intervalMonths`).
--
-- The tenant's term sheet sets one or the other, so the plan disclosed can be the plan the
-- institution's loan system books: some loan systems schedule only on a day of the month. A loan
-- records exactly one of the two, as it was disclosed and accepted.
--
-- Additive: the rows already recorded keep their interval in days. Portable PostgreSQL.

alter table core.consumer_loan alter column interval_days drop not null;

alter table core.consumer_loan
  add column if not exists interval_months integer check (interval_months between 1 and 12);

alter table core.consumer_loan drop constraint if exists consumer_loan_one_interval;
alter table core.consumer_loan
  add constraint consumer_loan_one_interval check ((interval_days is null) <> (interval_months is null));
