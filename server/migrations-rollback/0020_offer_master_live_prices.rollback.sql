-- Rollback for 0020. Only for a row that was never sold.
DELETE FROM offers WHERE offer_code = 'DIY_PACKAGE' AND offer_version = 'v1' AND status = 'draft';
