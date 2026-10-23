import { describe, it, expect } from 'vitest';
import {
  calculateDistanceMeters,
  calculateDistanceKm,
  MobilityClassifier,
} from './locationMobilityService';

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
});
