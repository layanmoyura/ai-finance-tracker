-- ============================================================================
-- Apex LifeOS: Fix Device Location Pings Permissions & RLS for Mobile Companion
-- ============================================================================

-- 1. Ensure schema usage and table privileges are explicitly granted to all roles
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.device_location_pings TO anon, authenticated, service_role;

-- 2. Ensure RLS is active
ALTER TABLE public.device_location_pings ENABLE ROW LEVEL SECURITY;

-- 3. Policy: Allow device location ping insertion
-- Allows authenticated users inserting their own pings,
-- or companion daemons using the public anon key with a valid assigned user_id
DROP POLICY IF EXISTS "Allow device location ping insertion" ON public.device_location_pings;
DROP POLICY IF EXISTS "Users can insert own location pings" ON public.device_location_pings;

CREATE POLICY "Allow device location ping insertion"
    ON public.device_location_pings FOR INSERT
    WITH CHECK (
        (auth.uid() = user_id) OR 
        (auth.role() = 'anon' AND user_id IS NOT NULL)
    );

-- 4. Policy: Allow viewing location pings
DROP POLICY IF EXISTS "Users can view own location pings" ON public.device_location_pings;
CREATE POLICY "Users can view own location pings"
    ON public.device_location_pings FOR SELECT
    USING (
        (auth.uid() = user_id) OR
        (auth.role() = 'anon')
    );

-- 5. Policy: Allow deleting location pings
DROP POLICY IF EXISTS "Users can delete own location pings" ON public.device_location_pings;
CREATE POLICY "Users can delete own location pings"
    ON public.device_location_pings FOR DELETE
    USING (auth.uid() = user_id);
