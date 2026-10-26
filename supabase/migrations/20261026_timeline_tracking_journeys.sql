-- ============================================================================
-- Apex LifeOS: Timeline Tracking, Journeys & Three-Tier Pin Classification
-- Migration: 20261026_timeline_tracking_journeys.sql
-- ============================================================================

-- 1. Extend device_location_pings with journey partitioning and pin_type
ALTER TABLE public.device_location_pings 
  ADD COLUMN IF NOT EXISTS journey_id UUID DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS pin_type TEXT DEFAULT 'in_travel';

-- Add check constraint if not already present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'check_pin_type' AND conrelid = 'public.device_location_pings'::regclass
    ) THEN
        ALTER TABLE public.device_location_pings 
        ADD CONSTRAINT check_pin_type 
        CHECK (pin_type IN ('start', 'in_travel', 'end', 'ambient'));
    END IF;
END $$;

-- Backfill NULL pin_types to 'in_travel'
UPDATE public.device_location_pings 
SET pin_type = 'in_travel' 
WHERE pin_type IS NULL;

-- Index for instant querying of all pings in a journey
CREATE INDEX IF NOT EXISTS idx_device_pings_journey 
  ON public.device_location_pings(journey_id, recorded_at ASC) 
  WHERE journey_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_device_pings_pin_type 
  ON public.device_location_pings(user_id, pin_type, recorded_at DESC);


-- 2. Extend mobility_timeline_events with journey metrics and start/end coordinates
ALTER TABLE public.mobility_timeline_events
  ADD COLUMN IF NOT EXISTS journey_id UUID DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS start_latitude DOUBLE PRECISION DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS start_longitude DOUBLE PRECISION DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS end_latitude DOUBLE PRECISION DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS end_longitude DOUBLE PRECISION DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS start_address TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS end_address TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS related_transaction_id UUID DEFAULT NULL REFERENCES public.transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mobility_events_journey 
  ON public.mobility_timeline_events(journey_id) 
  WHERE journey_id IS NOT NULL;


-- 3. Dedicated mobility_journeys Table for Full Journey Lifecycle & Analytics
CREATE TABLE IF NOT EXISTS public.mobility_journeys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT,
    title TEXT NOT NULL DEFAULT 'Active Journey',
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'cancelled')),
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    start_latitude DOUBLE PRECISION NOT NULL,
    start_longitude DOUBLE PRECISION NOT NULL,
    start_address TEXT,
    end_latitude DOUBLE PRECISION,
    end_longitude DOUBLE PRECISION,
    end_address TEXT,
    total_distance_km NUMERIC(8, 2) DEFAULT 0,
    travel_time_seconds INTEGER DEFAULT 0,
    avg_speed_kmh NUMERIC(6, 1) DEFAULT 0,
    max_speed_kmh NUMERIC(6, 1) DEFAULT 0,
    estimated_cost NUMERIC(10, 2) DEFAULT 0,
    is_cost_logged BOOLEAN DEFAULT FALSE,
    logged_transit_cost NUMERIC(10, 2) DEFAULT 0,
    primary_transport_mode TEXT DEFAULT 'vehicle',
    is_business_trip BOOLEAN DEFAULT FALSE,
    tax_deduction_amount NUMERIC(10, 2) DEFAULT 0,
    related_transaction_id UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for mobility_journeys
CREATE INDEX IF NOT EXISTS idx_mobility_journeys_user_time 
  ON public.mobility_journeys(user_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_mobility_journeys_device 
  ON public.mobility_journeys(user_id, device_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_mobility_journeys_status 
  ON public.mobility_journeys(status);

-- 4. Enable Row Level Security (RLS) on mobility_journeys
ALTER TABLE public.mobility_journeys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own journeys" 
  ON public.mobility_journeys FOR ALL 
  USING (auth.uid() = user_id);

CREATE POLICY "Allow companion APK insert journey" 
  ON public.mobility_journeys FOR INSERT WITH CHECK (
    (auth.uid() = user_id) OR 
    (auth.role() = 'anon' AND user_id IS NOT NULL)
  );

CREATE POLICY "Allow companion APK update journey" 
  ON public.mobility_journeys FOR UPDATE USING (
    (auth.uid() = user_id) OR 
    (auth.role() = 'anon' AND user_id IS NOT NULL)
  );

-- 5. Add to Supabase Realtime Publication
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables 
            WHERE pubname = 'supabase_realtime' 
              AND schemaname = 'public' 
              AND tablename = 'mobility_journeys'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.mobility_journeys;
        END IF;
    END IF;
END $$;

-- 6. Grant schema privileges
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.mobility_journeys TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.device_location_pings TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.mobility_timeline_events TO anon, authenticated, service_role;

-- 7. Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
