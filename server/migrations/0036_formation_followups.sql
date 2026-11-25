-- T144 D10 follow-ups (dispatcher review of #32), applied with or after 0034.
-- orders.sunbiz_filing_date: the date Sunbiz filed the Articles, supplied by the
-- operator with proof of filing (or to POST /api/ops/operating-agreement). The
-- Operating Agreement's "Filed" date, never the day the proof was recorded.
-- operating_agreement_status.deal_sync_error: Deal-write failures kept apart
-- from the generation error, so alerts do not repeat.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sunbiz_filing_date date;
ALTER TABLE operating_agreement_status ADD COLUMN IF NOT EXISTS deal_sync_error text;
