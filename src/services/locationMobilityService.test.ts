import { describe, it, expect } from 'vitest';
import {
  calculateDistanceMeters,
  calculateDistanceKm,
  MobilityClassifier,
  computeDailyStatsFromPings,
  computeJourneyTelemetry,
} from './locationMobilityService';
import type { DeviceLocationPing } from '../types';

describe('Location & Mobility Calculations', () => {
  it('should calculate geodesic distance between two GPS coordinates correctly', () => {
    // New York (Empire State Building) to Times Square (~1 km)
    const lat1 = 40.748817;
    const lon1 = -73.985428;
    const lat2 = 40.758896;
    const lon2 = -73.985130;

    const meters = calculateDistanceMeters(lat1, lon1, lat2, lon2);
    const km = calculateDistanceKm(lat1, lon1, lat2, lon2);

    expect(meters).toBeGreaterThan(1000);
    expect(meters).toBeLessThan(1200);
    expect(km).toBeCloseTo(meters / 1000, 3);
  });

  it('should return 0 meters for identical coordinates', () => {
    const lat = 6.9271;
    const lon = 79.8612;
    expect(calculateDistanceMeters(lat, lon, lat, lon)).toBe(0);
  });

  it('should classify stationary state when speed is 0', () => {
    const classifier = new MobilityClassifier();
    const state = classifier.evaluate(0);

    expect(state.mode).toBe('stationary');
    expect(state.statusLabel).toContain('Stationary');
  });

  it('should classify vehicle mode when moving at driving speed', () => {
    const classifier = new MobilityClassifier();
    const state = classifier.evaluate(60);

    expect(state.mode).toBe('vehicle');
    expect(state.statusLabel).toContain('Vehicle');
  });

  it('should classify high speed transit when moving over 80 km/h', () => {
    const classifier = new MobilityClassifier();
    const state = classifier.evaluate(95);

    expect(state.mode).toBe('high_speed_transit');
    expect(state.statusLabel).toContain('High-Speed');
  });

  it('should compute daily mobility stats correctly from sequential pings', () => {
    // Pings along Colombo - Galle road (Western Province, Sri Lanka)
    const mockPings: DeviceLocationPing[] = [
      {
        id: 'p1',
        user_id: 'usr-1',
        device_id: 'dev-1',
        latitude: 6.9271,
        longitude: 79.8612,
        speed_kmh: 0,
        recorded_at: '2026-10-25T08:00:00.000Z',
      },
      {
        id: 'p2',
        user_id: 'usr-1',
        device_id: 'dev-1',
        latitude: 6.9000,
        longitude: 79.8550,
        speed_kmh: 35,
        transport_mode: 'vehicle',
        recorded_at: '2026-10-25T08:10:00.000Z',
      },
      {
        id: 'p3',
        user_id: 'usr-1',
        device_id: 'dev-1',
        latitude: 6.8700,
        longitude: 79.8600,
        speed_kmh: 40,
        transport_mode: 'vehicle',
        recorded_at: '2026-10-25T08:20:00.000Z',
      },
      {
        id: 'p4',
        user_id: 'usr-1',
        device_id: 'dev-1',
        latitude: 6.8680,
        longitude: 79.8605,
        speed_kmh: 3.5,
        transport_mode: 'walking',
        recorded_at: '2026-10-25T08:30:00.000Z',
      },
    ];

    const stats = computeDailyStatsFromPings(mockPings, '2026-10-25', 'usr-1', 'dev-1');

    expect(stats.user_id).toBe('usr-1');
    expect(stats.stat_date).toBe('2026-10-25');
    expect(stats.total_distance_km).toBeGreaterThan(5);
    expect(stats.vehicle_km).toBeGreaterThan(4);
    expect(stats.walking_km).toBeGreaterThan(0.1);
    expect(stats.top_speed_kmh).toBe(40);
    expect(stats.transit_time_minutes).toBe(30);
    expect(stats.estimated_transit_cost).toBeGreaterThan(0);
  });

  it('should compute journey telemetry strictly from Start Pin and End Pin with time-based speed', () => {
    const journeyPings: DeviceLocationPing[] = [
      {
        id: 'start-1',
        user_id: 'usr-1',
        device_id: 'dev-1',
        journey_id: 'jrn-123',
        pin_type: 'start',
        latitude: 6.9271,
        longitude: 79.8612,
        speed_kmh: 0,
        transport_mode: 'stationary',
        recorded_at: '2026-10-25T09:00:00.000Z',
      },
      {
        id: 'end-1',
        user_id: 'usr-1',
        device_id: 'dev-1',
        journey_id: 'jrn-123',
        pin_type: 'end',
        latitude: 6.8700,
        longitude: 79.8600,
        speed_kmh: 0,
        transport_mode: 'stationary',
        recorded_at: '2026-10-25T09:10:00.000Z',
      },
    ];

    const metrics = computeJourneyTelemetry(journeyPings);
    expect(metrics).not.toBeNull();
    if (!metrics) return;

    expect(metrics.journeyId).toBe('jrn-123');
    expect(metrics.startPing?.id).toBe('start-1');
    expect(metrics.endPing?.id).toBe('end-1');
    expect(metrics.inTravelPings.length).toBe(0);
    expect(metrics.travelTimeSeconds).toBe(600); // 10 minutes
    expect(metrics.totalDistanceKm).toBeGreaterThan(6);
    expect(metrics.avgSpeedKmh).toBeGreaterThan(35);
    expect(metrics.maxSpeedKmh).toBe(metrics.avgSpeedKmh);
    expect(metrics.estimatedCost).toBeGreaterThan(0);
    expect(metrics.primaryTransportMode).toBe('vehicle');
  });

  it('should compute journey telemetry with 10s intermediate waypoints tracking the route', () => {
    const journeyPings: DeviceLocationPing[] = [
      {
        id: 'start-1',
        user_id: 'usr-1',
        device_id: 'dev-1',
        journey_id: 'jrn-456',
        pin_type: 'start',
        latitude: 6.9271,
        longitude: 79.8612,
        speed_kmh: 0,
        transport_mode: 'stationary',
        recorded_at: '2026-10-25T10:00:00.000Z',
      },
      {
        id: 'wp-10s-1',
        user_id: 'usr-1',
        device_id: 'dev-1',
        journey_id: 'jrn-456',
        pin_type: 'in_travel',
        latitude: 6.9100,
        longitude: 79.8580,
        speed_kmh: 36,
        transport_mode: 'vehicle',
        recorded_at: '2026-10-25T10:00:10.000Z',
      },
      {
        id: 'wp-10s-2',
        user_id: 'usr-1',
        device_id: 'dev-1',
        journey_id: 'jrn-456',
        pin_type: 'in_travel',
        latitude: 6.8900,
        longitude: 79.8560,
        speed_kmh: 38,
        transport_mode: 'vehicle',
        recorded_at: '2026-10-25T10:00:20.000Z',
      },
      {
        id: 'end-1',
        user_id: 'usr-1',
        device_id: 'dev-1',
        journey_id: 'jrn-456',
        pin_type: 'end',
        latitude: 6.8700,
        longitude: 79.8600,
        speed_kmh: 37,
        transport_mode: 'vehicle',
        recorded_at: '2026-10-25T10:00:30.000Z',
      },
    ];

    const metrics = computeJourneyTelemetry(journeyPings);
    expect(metrics).not.toBeNull();
    if (!metrics) return;

    expect(metrics.journeyId).toBe('jrn-456');
    expect(metrics.startPing?.id).toBe('start-1');
    expect(metrics.endPing?.id).toBe('end-1');
    expect(metrics.inTravelPings.length).toBe(2);
    expect(metrics.inTravelPings[0].id).toBe('wp-10s-1');
    expect(metrics.inTravelPings[1].id).toBe('wp-10s-2');
    expect(metrics.travelTimeSeconds).toBe(30);
    expect(metrics.totalDistanceKm).toBeGreaterThan(6);
    expect(metrics.estimatedCost).toBeGreaterThan(0);
  });
});
