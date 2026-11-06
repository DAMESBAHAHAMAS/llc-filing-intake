-- 0028: stray_capture_pi holds one payment on a hold the order does not use.
-- A second one waits here, so refunding either can't lift the block while the
-- other stands.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS more_stray_capture_pis jsonb NOT NULL DEFAULT '[]'::jsonb;
