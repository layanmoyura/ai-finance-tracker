-- ============================================================================
-- Apex LifeOS: Add transport_mode column to device_location_pings
-- Ensures backward-compatibility for databases created prior to transport_mode
-- ============================================================================

-- 1. Add transport_mode column if missing on pre-existing tables
ALTER TABLE public.device_location_pings 
ADD COLUMN IF NOT EXISTS transport_mode TEXT DEFAULT 'unknown';

-- 2. Backfill NULL values on existing rows with default classification
UPDATE public.device_location_pings 
SET transport_mode = 'unknown' 
WHERE transport_mode IS NULL;

-- 3. Re-grant schema and table privileges to ensure all roles have access to the column
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.device_location_pings TO anon, authenticated, service_role;

-- 4. Reload PostgREST schema cache immediately so new columns are recognized without project restarts
NOTIFY pgrst, 'reload schema';
