import React, { useEffect, useRef, useState, useMemo } from 'react';
import type { DeviceLocationPing } from '../types';
import {
  Play,
  Pause,
  RotateCcw,
  Compass,
  Battery,
  BatteryCharging,
  Gauge,
  Clock,
  MapPin,
  Car,
  Bike,
  Footprints,
  Maximize2,
  Layers,
} from 'lucide-react';

interface SriLankaMobilityMapProps {
  pings: DeviceLocationPing[];
  selectedDate: string; // YYYY-MM-DD
  isLoading?: boolean;
}

// Sri Lanka Geography Constants
const SRI_LANKA_CENTER = { lat: 7.8731, lng: 80.7718 };
const SRI_LANKA_BOUNDS = {
  minLat: 5.85,
  maxLat: 9.95,
  minLng: 79.5,
  maxLng: 81.95,
};

// Key Sri Lankan urban anchors for landmark guidance
const SRI_LANKA_LANDMARKS = [
  { name: 'Colombo', lat: 6.9271, lng: 79.8612, isMajor: true },
  { name: 'Kandy', lat: 7.2906, lng: 80.6337, isMajor: true },
  { name: 'Galle', lat: 6.0535, lng: 80.2210, isMajor: true },
  { name: 'Jaffna', lat: 9.6615, lng: 80.0255, isMajor: true },
  { name: 'Negombo', lat: 7.2008, lng: 79.8736, isMajor: false },
  { name: 'Kalutara', lat: 6.5854, lng: 79.9607, isMajor: false },
  { name: 'Matara', lat: 5.9549, lng: 80.5550, isMajor: false },
  { name: 'Anuradhapura', lat: 8.3114, lng: 80.4037, isMajor: true },
  { name: 'Trincomalee', lat: 8.5874, lng: 81.2152, isMajor: true },
  { name: 'Batticaloa', lat: 7.7170, lng: 81.7000, isMajor: false },
  { name: 'Badulla', lat: 6.9934, lng: 81.0550, isMajor: false },
];

export const SriLankaMobilityMap: React.FC<SriLankaMobilityMapProps> = ({
  pings,
  selectedDate,
  isLoading = false,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const routeLayerGroupRef = useRef<any>(null);
  const scrubberMarkerRef = useRef<any>(null);

  // Fallback & view modes
  const [leafletLoaded, setLeafletLoaded] = useState<boolean>(() => typeof (window as any).L !== 'undefined');
  const [mapMode, setMapMode] = useState<'leaflet' | 'vector'>('leaflet');

  // Scrubber & playback states
  const [scrubIndex, setScrubIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1); // 1x, 2x, 5x, 10x

  // Sort pings chronologically
  const sortedPings = useMemo(() => {
    return [...pings].sort(
      (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
    );
  }, [pings]);

  // Reset scrubber when date changes or pings change
  useEffect(() => {
    setIsPlaying(false);
    setScrubIndex(sortedPings.length > 0 ? sortedPings.length - 1 : 0);
  }, [selectedDate, sortedPings.length]);

  // Current active scrubbed ping
  const activePing = sortedPings[scrubIndex] || sortedPings[sortedPings.length - 1] || null;

  // 1. Dynamic Leaflet script & css loader
  useEffect(() => {
    if (typeof (window as any).L !== 'undefined') {
      setLeafletLoaded(true);
      return;
    }

    let isMounted = true;

    // Load Leaflet CSS
    const existingCss = document.getElementById('leaflet-css');
    if (!existingCss) {
      const link = document.createElement('link');
      link.id = 'leaflet-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      link.crossOrigin = '';
      document.head.appendChild(link);
    }

    // Load Leaflet JS
    const existingScript = document.getElementById('leaflet-js');
    if (!existingScript) {
      const script = document.createElement('script');
      script.id = 'leaflet-js';
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.crossOrigin = '';
      script.async = true;

      script.onload = () => {
        if (isMounted) setLeafletLoaded(true);
      };
      script.onerror = () => {
        if (isMounted) {
          console.warn('Leaflet CDN load failed; switching to SVG Vector fallback mode.');
          setMapMode('vector');
        }
      };
      document.body.appendChild(script);
    } else {
      const checkInterval = setInterval(() => {
        if (typeof (window as any).L !== 'undefined') {
          if (isMounted) setLeafletLoaded(true);
          clearInterval(checkInterval);
        }
      }, 100);
      return () => clearInterval(checkInterval);
    }

    return () => {
      isMounted = false;
    };
  }, []);

  // 2. Initialize Leaflet Map Instance
  useEffect(() => {
    if (!leafletLoaded || mapMode !== 'leaflet' || !mapContainerRef.current) return;

    const L = (window as any).L;
    if (!L) return;

    if (!mapInstanceRef.current) {
      try {
        const map = L.map(mapContainerRef.current, {
          center: [SRI_LANKA_CENTER.lat, SRI_LANKA_CENTER.lng],
          zoom: 8,
          minZoom: 6,
          maxZoom: 18,
          zoomControl: false,
        });

        // Add subtle dark tile layer (CartoDB Dark Matter)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; OpenStreetMap',
          subdomains: 'abcd',
          maxZoom: 19,
        }).addTo(map);

        L.control.zoom({ position: 'bottomright' }).addTo(map);

        const routeGroup = L.layerGroup().addTo(map);
        routeLayerGroupRef.current = routeGroup;
        mapInstanceRef.current = map;
      } catch (err) {
        console.warn('Leaflet init error:', err);
        setMapMode('vector');
      }
    }

    return () => {
      // Keep map instance mounted across re-renders to prevent container destruction
    };
  }, [leafletLoaded, mapMode]);

  // 3. Update Polylines, Markers, and Bounds on Map
  useEffect(() => {
    if (mapMode !== 'leaflet' || !mapInstanceRef.current || !routeLayerGroupRef.current) return;
    const L = (window as any).L;
    if (!L) return;

    const routeGroup = routeLayerGroupRef.current;
    routeGroup.clearLayers();
    scrubberMarkerRef.current = null;

    if (sortedPings.length === 0) {
      // Reset view to Sri Lanka default
      mapInstanceRef.current.setView([SRI_LANKA_CENTER.lat, SRI_LANKA_CENTER.lng], 8);
      return;
    }

    const latLngs = sortedPings.map((p) => [p.latitude, p.longitude] as [number, number]);

    // Draw route segments color-coded by transport mode
    for (let i = 0; i < sortedPings.length - 1; i++) {
      const p1 = sortedPings[i];
      const p2 = sortedPings[i + 1];

      let color = '#3b82f6'; // vehicle default
      const mode = p2.transport_mode || 'unknown';
      if (mode === 'walking' || p2.speed_kmh < 6.5) {
        color = '#10b981'; // emerald
      } else if (mode === 'cycling' || (p2.speed_kmh >= 6.5 && p2.speed_kmh < 22)) {
        color = '#06b6d4'; // cyan
      } else if (mode === 'high_speed_transit' || p2.speed_kmh > 70) {
        color = '#a855f7'; // purple
      }

      L.polyline([[p1.latitude, p1.longitude], [p2.latitude, p2.longitude]], {
        color,
        weight: 4,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(routeGroup);
    }

    // Add Start Point Marker (Green Flag/Dot)
    const firstPing = sortedPings[0];
    const startIcon = L.divIcon({
      className: 'start-marker-icon',
      html: `
        <div class="relative flex items-center justify-center">
          <span class="absolute inline-flex h-6 w-6 animate-ping rounded-full bg-emerald-400 opacity-75"></span>
          <span class="relative inline-flex h-5 w-5 rounded-full bg-emerald-500 border-2 border-white shadow-lg items-center justify-center text-[10px] font-bold text-white">S</span>
        </div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    L.marker([firstPing.latitude, firstPing.longitude], { icon: startIcon })
      .addTo(routeGroup)
      .bindPopup(
        `<div class="p-1 text-slate-900 font-sans text-xs">
          <b>🟢 Departure Point</b><br/>
          Time: ${new Date(firstPing.recorded_at).toLocaleTimeString()}<br/>
          Lat: ${firstPing.latitude.toFixed(4)}, Lng: ${firstPing.longitude.toFixed(4)}
        </div>`
      );

    // Add End Point Marker (Red/Checkered Dot)
    const lastPing = sortedPings[sortedPings.length - 1];
    const endIcon = L.divIcon({
      className: 'end-marker-icon',
      html: `
        <div class="relative flex items-center justify-center">
          <span class="relative inline-flex h-5 w-5 rounded-full bg-rose-600 border-2 border-white shadow-lg items-center justify-center text-[10px] font-bold text-white">🏁</span>
        </div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    L.marker([lastPing.latitude, lastPing.longitude], { icon: endIcon })
      .addTo(routeGroup)
      .bindPopup(
        `<div class="p-1 text-slate-900 font-sans text-xs">
          <b>🏁 Final Recorded Ping</b><br/>
          Time: ${new Date(lastPing.recorded_at).toLocaleTimeString()}<br/>
          Lat: ${lastPing.latitude.toFixed(4)}, Lng: ${lastPing.longitude.toFixed(4)}
        </div>`
      );

    // Dwell stops detection and markers
    let dwellCandidate = sortedPings[0];
    for (let i = 1; i < sortedPings.length; i++) {
      const p = sortedPings[i];
      const deltaMs = new Date(p.recorded_at).getTime() - new Date(dwellCandidate.recorded_at).getTime();
      const dist = Math.hypot(p.latitude - dwellCandidate.latitude, p.longitude - dwellCandidate.longitude);

      if (dist < 0.0008 && deltaMs >= 5 * 60 * 1000) {
        // Dwell > 5 mins
        const dwellIcon = L.divIcon({
          className: 'dwell-stop-icon',
          html: `<div class="h-3 w-3 rounded-full bg-amber-400 border border-slate-900 shadow ring-2 ring-amber-500/50"></div>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        });
        L.marker([p.latitude, p.longitude], { icon: dwellIcon })
          .addTo(routeGroup)
          .bindPopup(
            `<div class="p-1 text-slate-900 font-sans text-xs">
              <b>🛑 Dwell Stop (~${Math.round(deltaMs / 60000)} mins)</b><br/>
              Time: ${new Date(dwellCandidate.recorded_at).toLocaleTimeString()} - ${new Date(p.recorded_at).toLocaleTimeString()}
            </div>`
          );
        dwellCandidate = p;
      } else if (dist >= 0.0008) {
        dwellCandidate = p;
      }
    }

    // Dynamic Live Scrubber Radar Marker
    const radarIcon = L.divIcon({
      className: 'radar-scrub-icon',
      html: `
        <div class="relative flex items-center justify-center pointer-events-none">
          <span class="absolute inline-flex h-10 w-10 animate-ping rounded-full bg-amber-400 opacity-60"></span>
          <span class="relative inline-flex h-6 w-6 rounded-full bg-gradient-to-r from-amber-400 to-yellow-500 border-2 border-white shadow-xl items-center justify-center">
            <span class="h-2 w-2 rounded-full bg-slate-950"></span>
          </span>
        </div>
      `,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    const initialScrubPing = sortedPings[scrubIndex] || lastPing;
    const scrubberMarker = L.marker([initialScrubPing.latitude, initialScrubPing.longitude], {
      icon: radarIcon,
      zIndexOffset: 1000,
    }).addTo(routeGroup);
    scrubberMarkerRef.current = scrubberMarker;

    // Fit map bounds to encompass the route
    try {
      const bounds = L.latLngBounds(latLngs);
      mapInstanceRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
    } catch (e) {
      console.warn('Error fitting bounds:', e);
    }
  }, [sortedPings, leafletLoaded, mapMode]);

  // 4. Update Scrubber Marker position when scrubIndex changes
  useEffect(() => {
    if (mapMode !== 'leaflet' || !scrubberMarkerRef.current || !activePing) return;
    scrubberMarkerRef.current.setLatLng([activePing.latitude, activePing.longitude]);
  }, [scrubIndex, activePing, mapMode]);

  // 5. Playback Animation Timer
  useEffect(() => {
    if (!isPlaying || sortedPings.length === 0) return;

    const intervalMs = Math.max(80, 1000 / (playbackSpeed * 3));
    const timer = setInterval(() => {
      setScrubIndex((prev) => {
        if (prev >= sortedPings.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isPlaying, playbackSpeed, sortedPings.length]);

  // Helper action: Fit route bounds
  const handleFitRoute = () => {
    if (mapMode === 'leaflet' && mapInstanceRef.current && sortedPings.length > 0) {
      const L = (window as any).L;
      if (!L) return;
      const latLngs = sortedPings.map((p) => [p.latitude, p.longitude] as [number, number]);
      mapInstanceRef.current.fitBounds(L.latLngBounds(latLngs), { padding: [50, 50], maxZoom: 16 });
    }
  };

  // Helper action: View whole Sri Lanka island
  const handleWholeIslandView = () => {
    if (mapMode === 'leaflet' && mapInstanceRef.current) {
      mapInstanceRef.current.setView([SRI_LANKA_CENTER.lat, SRI_LANKA_CENTER.lng], 8);
    }
  };

  // Map coordinates projection for Standalone SVG Vector Mode
  const projectToSvg = (lat: number, lng: number) => {
    const svgWidth = 420;
    const svgHeight = 650;
    const minLat = SRI_LANKA_BOUNDS.minLat;
    const maxLat = SRI_LANKA_BOUNDS.maxLat;
    const minLng = SRI_LANKA_BOUNDS.minLng;
    const maxLng = SRI_LANKA_BOUNDS.maxLng;

    const x = ((lng - minLng) / (maxLng - minLng)) * svgWidth;
    const y = ((maxLat - lat) / (maxLat - minLat)) * svgHeight;
    return { x: Math.max(10, Math.min(svgWidth - 10, x)), y: Math.max(10, Math.min(svgHeight - 10, y)) };
  };

  // SVG points path string
  const svgPathD = useMemo(() => {
    if (sortedPings.length < 2) return '';
    return sortedPings.reduce((acc, p, idx) => {
      const { x, y } = projectToSvg(p.latitude, p.longitude);
      return idx === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : `${acc} L ${x.toFixed(1)} ${y.toFixed(1)}`;
    }, '');
  }, [sortedPings]);

  // Mode badge helper
  const getModeBadge = (mode?: string, speed = 0) => {
    if (mode === 'walking' || (speed > 0 && speed < 6.5)) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
          <Footprints className="w-3 h-3" /> Walking
        </span>
      );
    }
    if (mode === 'cycling' || (speed >= 6.5 && speed < 22)) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
          <Bike className="w-3 h-3" /> Cycling
        </span>
      );
    }
    if (speed === 0) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-700 text-slate-300 border border-slate-600">
          <MapPin className="w-3 h-3" /> Stationary
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
        <Car className="w-3 h-3" /> In Vehicle
      </span>
    );
  };

  return (
    <div className="relative flex flex-col rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 bg-slate-950/80 border-b border-slate-800/80 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
            <Compass className="w-4 h-4 animate-spin-slow" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold tracking-wide text-white">
                Sri Lanka Mobility & Route Explorer
              </h3>
              <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                🇱🇰 Island Track
              </span>
            </div>
            <p className="text-xs text-slate-400">
              {sortedPings.length > 0 ? (
                <>
                  <span className="text-indigo-300 font-semibold">{sortedPings.length}</span> coordinate pings recorded on{' '}
                  <span className="text-slate-200 font-medium">{selectedDate}</span>
                </>
              ) : (
                <>No tracking pings found for {selectedDate}</>
              )}
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleFitRoute}
            disabled={sortedPings.length === 0}
            title="Fit zoom to recorded journey"
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-40 transition-colors"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            <span>Fit Route</span>
          </button>

          <button
            onClick={handleWholeIslandView}
            title="Reset map view to whole Sri Lanka"
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
          >
            <span>🇱🇰 Sri Lanka</span>
          </button>

          <button
            onClick={() => setMapMode((prev) => (prev === 'leaflet' ? 'vector' : 'leaflet'))}
            title="Switch between Leaflet Tile Map and SVG Vector Map"
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
          >
            <Layers className="w-3.5 h-3.5" />
            <span className="capitalize">{mapMode === 'leaflet' ? 'Vector' : 'Tiles'}</span>
          </button>
        </div>
      </div>

      {/* Main Map Canvas Area */}
      <div className="relative w-full h-[420px] sm:h-[480px] bg-slate-950 overflow-hidden">
        {/* Mode A: Leaflet Tile Map */}
        <div
          ref={mapContainerRef}
          className={`w-full h-full z-0 transition-opacity duration-300 ${
            mapMode === 'leaflet' ? 'opacity-100' : 'opacity-0 pointer-events-none absolute inset-0'
          }`}
        />

        {/* Mode B: High-Precision Standalone SVG Vector Map of Sri Lanka */}
        {mapMode === 'vector' && (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 p-4">
            <svg
              viewBox="0 0 420 650"
              className="w-full h-full max-h-[460px] drop-shadow-2xl select-none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <defs>
                <linearGradient id="islandGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#1e293b" />
                  <stop offset="50%" stopColor="#0f172a" />
                  <stop offset="100%" stopColor="#1e293b" />
                </linearGradient>
                <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feComposite in="SourceGraphic" in2="blur" operator="over" />
                </filter>
              </defs>

              {/* Sri Lanka Coastline Stylized Polyline Path */}
              <path
                d="M 120 40 
                   Q 150 30 180 50 
                   Q 220 70 250 110 
                   Q 270 140 290 190 
                   Q 310 240 315 310 
                   Q 315 380 295 440 
                   Q 270 510 230 570 
                   Q 190 610 160 610 
                   Q 130 600 110 570 
                   Q 90 530 85 460 
                   Q 80 400 90 350 
                   Q 95 300 90 240 
                   Q 80 180 85 130 
                   Q 95 80 120 40 Z"
                fill="url(#islandGrad)"
                stroke="#334155"
                strokeWidth="2.5"
                strokeDasharray="4 2"
              />

              {/* Major Cities / Anchor Nodes */}
              {SRI_LANKA_LANDMARKS.map((city) => {
                const { x, y } = projectToSvg(city.lat, city.lng);
                return (
                  <g key={city.name} className="opacity-70 hover:opacity-100 transition-opacity">
                    <circle
                      cx={x}
                      cy={y}
                      r={city.isMajor ? 4 : 2.5}
                      fill={city.isMajor ? '#60a5fa' : '#94a3b8'}
                      stroke="#0f172a"
                      strokeWidth="1.5"
                    />
                    <text
                      x={x + 7}
                      y={y + 3}
                      fill="#cbd5e1"
                      fontSize="9"
                      fontWeight={city.isMajor ? '600' : 'normal'}
                      fontFamily="system-ui, sans-serif"
                    >
                      {city.name}
                    </text>
                  </g>
                );
              })}

              {/* Travelled Route Polyline */}
              {svgPathD && (
                <path
                  d={svgPathD}
                  fill="none"
                  stroke="#38bdf8"
                  strokeWidth="3.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  filter="url(#glow)"
                />
              )}

              {/* Start & End Marker in Vector */}
              {sortedPings.length > 0 && (() => {
                const startPos = projectToSvg(sortedPings[0].latitude, sortedPings[0].longitude);
                const endPos = projectToSvg(
                  sortedPings[sortedPings.length - 1].latitude,
                  sortedPings[sortedPings.length - 1].longitude
                );
                return (
                  <>
                    <circle cx={startPos.x} cy={startPos.y} r="5" fill="#10b981" stroke="#ffffff" strokeWidth="1.5" />
                    <circle cx={endPos.x} cy={endPos.y} r="5" fill="#f43f5e" stroke="#ffffff" strokeWidth="1.5" />
                  </>
                );
              })()}

              {/* Active Scrubber Radar Marker */}
              {activePing && (() => {
                const { x, y } = projectToSvg(activePing.latitude, activePing.longitude);
                return (
                  <g>
                    <circle cx={x} cy={y} r="10" fill="#f59e0b" opacity="0.4" className="animate-ping" />
                    <circle cx={x} cy={y} r="6" fill="#f59e0b" stroke="#ffffff" strokeWidth="2" />
                  </g>
                );
              })()}
            </svg>
          </div>
        )}

        {/* Live HUD Floating Overlay (Bottom Left) */}
        {activePing && (
          <div className="absolute top-4 left-4 z-10 max-w-xs sm:max-w-sm rounded-xl bg-slate-900/90 border border-slate-700/80 shadow-2xl backdrop-blur-md p-3.5 text-xs text-slate-200">
            <div className="flex items-center justify-between gap-2 mb-2 pb-2 border-b border-slate-800">
              <div className="flex items-center gap-1.5 font-bold text-white">
                <Clock className="w-3.5 h-3.5 text-indigo-400" />
                <span>{new Date(activePing.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              </div>
              {getModeBadge(activePing.transport_mode, activePing.speed_kmh)}
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="flex items-center gap-1.5 text-slate-300">
                <Gauge className="w-3.5 h-3.5 text-cyan-400" />
                <span>Speed: <strong className="text-white">{(activePing.speed_kmh || 0).toFixed(1)} km/h</strong></span>
              </div>

              <div className="flex items-center gap-1.5 text-slate-300">
                {activePing.is_charging ? (
                  <BatteryCharging className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Battery className="w-3.5 h-3.5 text-amber-400" />
                )}
                <span>
                  Battery: <strong className="text-white">{activePing.battery_level != null ? `${Math.round(activePing.battery_level)}%` : 'N/A'}</strong>
                </span>
              </div>

              <div className="col-span-2 flex items-center gap-1 text-[10px] text-slate-400 pt-1 font-mono">
                <MapPin className="w-3 h-3 text-rose-400 shrink-0" />
                <span>
                  {activePing.latitude.toFixed(5)}, {activePing.longitude.toFixed(5)}
                </span>
                <span className="ml-auto text-slate-500">
                  #{scrubIndex + 1}/{sortedPings.length}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Empty State Overlay */}
        {!isLoading && sortedPings.length === 0 && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-950/75 backdrop-blur-xs p-6 text-center">
            <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 mb-3">
              <MapPin className="w-6 h-6 animate-bounce" />
            </div>
            <h4 className="text-sm font-bold text-white mb-1">
              No Travelled Pings for {selectedDate}
            </h4>
            <p className="text-xs text-slate-400 max-w-sm mb-3">
              Pings transmitted from your companion device on this date will be tracked and rendered across Sri Lanka in real-time.
            </p>
            <span className="text-[11px] text-slate-500">
              Select another date using the navigator above or ensure companion tracking is active.
            </span>
          </div>
        )}

        {/* Loading Indicator Overlay */}
        {isLoading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs">
            <div className="flex items-center gap-2.5 px-4 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs text-indigo-300 shadow-xl">
              <Compass className="w-4 h-4 animate-spin" />
              <span>Loading Sri Lanka route coordinates...</span>
            </div>
          </div>
        )}
      </div>

      {/* Scrubber & Playback Controls Bar */}
      {sortedPings.length > 0 && (
        <div className="flex flex-col gap-2.5 px-5 py-3.5 bg-slate-950/90 border-t border-slate-800">
          <div className="flex items-center gap-3">
            {/* Play/Pause Button */}
            <button
              onClick={() => {
                if (scrubIndex >= sortedPings.length - 1) {
                  setScrubIndex(0);
                }
                setIsPlaying(!isPlaying);
              }}
              className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white shadow-md transition-colors"
              title={isPlaying ? 'Pause Playback' : 'Play Journey'}
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
            </button>

            {/* Reset Button */}
            <button
              onClick={() => {
                setIsPlaying(false);
                setScrubIndex(0);
              }}
              className="flex items-center justify-center w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
              title="Rewind to start"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>

            {/* Interactive Timeline Range Scrubber */}
            <div className="flex-1 flex items-center gap-2">
              <span className="text-[10px] font-mono text-slate-400">
                {new Date(sortedPings[0].recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <input
                type="range"
                min="0"
                max={Math.max(0, sortedPings.length - 1)}
                value={scrubIndex}
                onChange={(e) => {
                  setIsPlaying(false);
                  setScrubIndex(Number(e.target.value));
                }}
                className="flex-1 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500 focus:outline-none"
              />
              <span className="text-[10px] font-mono text-slate-400">
                {new Date(sortedPings[sortedPings.length - 1].recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>

            {/* Playback Speed Multiplier */}
            <div className="flex items-center rounded-lg bg-slate-800 p-0.5 border border-slate-700 text-xs">
              {[1, 2, 5].map((speed) => (
                <button
                  key={speed}
                  onClick={() => setPlaybackSpeed(speed)}
                  className={`px-2 py-0.5 rounded-md font-semibold text-[10px] transition-colors ${
                    playbackSpeed === speed
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {speed}x
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
