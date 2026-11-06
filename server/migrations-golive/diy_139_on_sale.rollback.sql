-- Stops the $139 sale. Restore the offers named in the row list saved before
-- the go-live script ran (see docs/LIVE-139-RUNBOOK.md, step 6).
UPDATE offers SET status = 'draft', updated_at = now()
 WHERE offer_code = 'DIY_PACKAGE' AND offer_version = 'v1' AND status = 'active';
