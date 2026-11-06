-- Stops the $139 sale and restores what the go-live retired.
BEGIN;
UPDATE offers SET status = 'draft', updated_at = now()
 WHERE offer_code = 'DIY_PACKAGE' AND offer_version = 'v1' AND status = 'active';
UPDATE offers SET status = 'active', notes = replace(notes, ' [retired for diy_139 go-live]', ''), updated_at = now()
 WHERE status = 'retired' AND notes LIKE '%[retired for diy_139 go-live]%';
COMMIT;
