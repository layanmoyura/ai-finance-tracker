package com.apex.locationtracker.service

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import com.apex.locationtracker.MainActivity
import com.apex.locationtracker.data.LocationPingEntity
import com.apex.locationtracker.data.SupabaseManager
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlin.math.sqrt

data class CompletedJourneySummary(
    val journeyId: String,
    val startTime: String,
    val endTime: String,
    val startLat: Double,
    val startLng: Double,
    val endLat: Double,
    val endLng: Double,
    val durationSeconds: Long,
    val distanceKm: Float,
    val avgSpeedKmh: Float,
    val maxSpeedKmh: Float,
    val estimatedCost: Float,
    val primaryMode: String
)

data class LiveTrackerState(
    val isTracking: Boolean = false,
    val latitude: Double = 0.0,
    val longitude: Double = 0.0,
    val speedKmh: Float = 0.0f,
    val accuracyMeters: Float = 0.0f,
    val transportMode: String = "stationary",
    val speedSensingMethod: String = "Awaiting Fix",
    val batteryLevel: Float = 0.0f,
    val isCharging: Boolean = false,
    val lastPingTimestamp: String = "",
    val totalPingsTransmitted: Int = 0,
    val pendingOfflineCount: Int = 0,
    val lastHttpStatus: String = "Idle",
    val statusMessage: String = "Service ready",
    // Journey Lifecycle State
    val isJourneyActive: Boolean = false,
    val activeJourneyId: String? = null,
    val journeyStartTimeMs: Long = 0L,
    val journeyDurationSeconds: Long = 0L,
    val journeyDistanceKm: Float = 0.0f,
    val journeyAvgSpeedKmh: Float = 0.0f,
    val journeyStartLat: Double = 0.0,
    val journeyStartLng: Double = 0.0,
    val journeyMaxSpeedKmh: Float = 0.0f,
    val completedJourney: CompletedJourneySummary? = null
)

class LocationTrackingService : Service(), SensorEventListener {
    private val serviceScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var locationCallback: LocationCallback
    private lateinit var supabaseManager: SupabaseManager
    private lateinit var notificationManager: NotificationManager
    private lateinit var sensorManager: SensorManager

    // Kinetic Hardware Sensors
    private var linearAccelSensor: Sensor? = null
    private var accelerometerSensor: Sensor? = null
    private var stepDetectorSensor: Sensor? = null
    private var isUsingFallbackAccelerometer: Boolean = false

    // Kinetic Acceleration & Cadence State
    private var kineticEnergy: Float = 0.0f
    private val gravityFilter = FloatArray(3)
    private val stepTimestamps = mutableListOf<Long>()
    private var lastKineticEventTimestampMs: Long = 0L

    private var lastRecordedLocation: Location? = null
    private var lastDispatchedLocation: Location? = null
    private var lastDispatchedTimestampMs: Long = 0L
    private var lastReportedMode: String = "stationary"
    private var smoothedSpeedKmh: Float = 0.0f
    private var pingCounter: Int = 0
    private var consecutiveDispatches: Int = 0

    // Active Journey Session Variables
    private var isJourneyActive: Boolean = false
    private var activeJourneyId: String? = null
    private var journeyStartTimeMs: Long = 0L
    private var journeyStartIsoTime: String = ""
    private var journeyStartLocation: Location? = null
    private var journeyDistanceMeters: Float = 0.0f
    private var journeyMaxSpeedKmh: Float = 0.0f
    private var journeyTickerJob: Job? = null

    companion object {
        private const val TAG = "LocationTrackingService"
        private const val CHANNEL_ID = "apex_location_tracker_channel"
        private const val NOTIFICATION_ID = 40401

        const val ACTION_START = "com.apex.locationtracker.START"
        const val ACTION_STOP = "com.apex.locationtracker.STOP"
        const val ACTION_START_JOURNEY = "com.apex.locationtracker.START_JOURNEY"
        const val ACTION_END_JOURNEY = "com.apex.locationtracker.END_JOURNEY"
        const val ACTION_CLEAR_COMPLETED_JOURNEY = "com.apex.locationtracker.CLEAR_COMPLETED_JOURNEY"

        private val _liveState = MutableStateFlow(LiveTrackerState())
        val liveState: StateFlow<LiveTrackerState> = _liveState.asStateFlow()
    }

    override fun onCreate() {
        super.onCreate()
        supabaseManager = SupabaseManager.getInstance(this)
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager

        createNotificationChannel()
        setupLocationCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                if (isJourneyActive) {
                    endJourneySession()
                }
                stopTracking()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            ACTION_START -> {
                startTrackingInForeground()
            }
            ACTION_START_JOURNEY -> {
                startTrackingInForeground()
                startJourneySession()
            }
            ACTION_END_JOURNEY -> {
                endJourneySession()
            }
            ACTION_CLEAR_COMPLETED_JOURNEY -> {
                _liveState.value = _liveState.value.copy(completedJourney = null)
            }
            null -> {
                startTrackingInForeground()
            }
        }
        return START_STICKY
    }

    private fun startTrackingInForeground() {
        val notification = buildNotification("Initializing kinetic sensor tracking...")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        registerKineticSensors()
        requestLocationUpdates()

        _liveState.value = _liveState.value.copy(
            isTracking = true,
            statusMessage = "Kinetic sensor tracking active (Foreground Service)"
        )
    }

    private fun registerKineticSensors() {
        linearAccelSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
        if (linearAccelSensor != null) {
            sensorManager.registerListener(this, linearAccelSensor, SensorManager.SENSOR_DELAY_UI)
            isUsingFallbackAccelerometer = false
            Log.i(TAG, "Registered hardware TYPE_LINEAR_ACCELERATION sensor")
        } else {
            accelerometerSensor = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
            if (accelerometerSensor != null) {
                sensorManager.registerListener(this, accelerometerSensor, SensorManager.SENSOR_DELAY_UI)
                isUsingFallbackAccelerometer = true
                Log.i(TAG, "Registered fallback TYPE_ACCELEROMETER sensor with gravity subtraction")
            }
        }

        stepDetectorSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR)
        if (stepDetectorSensor != null) {
            sensorManager.registerListener(this, stepDetectorSensor, SensorManager.SENSOR_DELAY_UI)
            Log.i(TAG, "Registered hardware TYPE_STEP_DETECTOR sensor")
        }
    }

    private fun unregisterKineticSensors() {
        try {
            sensorManager.unregisterListener(this)
        } catch (e: Exception) {
            Log.w(TAG, "Error unregistering kinetic sensors: ${e.message}")
        }
    }

    override fun onSensorChanged(event: SensorEvent) {
        val now = SystemClock.elapsedRealtime()
        lastKineticEventTimestampMs = now

        when (event.sensor.type) {
            Sensor.TYPE_STEP_DETECTOR -> {
                synchronized(stepTimestamps) {
                    stepTimestamps.add(now)
                    stepTimestamps.removeAll { now - it > 5000L }
                }
            }
            Sensor.TYPE_LINEAR_ACCELERATION -> {
                val ax = event.values[0]
                val ay = event.values[1]
                val az = event.values[2]
                val mag = sqrt(ax * ax + ay * ay + az * az)
                kineticEnergy = 0.85f * kineticEnergy + 0.15f * mag
            }
            Sensor.TYPE_ACCELEROMETER -> {
                if (isUsingFallbackAccelerometer) {
                    gravityFilter[0] = 0.8f * gravityFilter[0] + 0.2f * event.values[0]
                    gravityFilter[1] = 0.8f * gravityFilter[1] + 0.2f * event.values[1]
                    gravityFilter[2] = 0.8f * gravityFilter[2] + 0.2f * event.values[2]

                    val ax = event.values[0] - gravityFilter[0]
                    val ay = event.values[1] - gravityFilter[1]
                    val az = event.values[2] - gravityFilter[2]
                    val mag = sqrt(ax * ax + ay * ay + az * az)
                    kineticEnergy = 0.85f * kineticEnergy + 0.15f * mag
                }
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        // No-op for inertial kinetic sensors
    }

    @SuppressLint("MissingPermission")
    private fun requestLocationUpdates() {
        fusedLocationClient.removeLocationUpdates(locationCallback)

        // Continuous high-accuracy location sensing:
        // Update interval 2.5s, fastest 1.2s, displacement 0.0m for immediate responsiveness
        val locationRequest = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2500L)
            .setMinUpdateIntervalMillis(1200L)
            .setMinUpdateDistanceMeters(0.0f)
            .setWaitForAccurateLocation(false)
            .build()

        fusedLocationClient.requestLocationUpdates(
            locationRequest,
            locationCallback,
            Looper.getMainLooper()
        )

        // Immediately query last known location to broadcast instantaneous initial fix
        fusedLocationClient.lastLocation.addOnSuccessListener { loc ->
            if (loc != null) {
                processLocationUpdate(loc)
            }
        }
    }

    private fun setupLocationCallback() {
        locationCallback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val location = result.lastLocation ?: return
                processLocationUpdate(location)
            }
        }
    }

    private data class SpeedMeasurement(
        val speedKmh: Float,
        val method: String
    )

    /**
     * Pure Kinetic Velocity Engine:
     * - GPS Doppler speed is completely removed.
     * - Velocity and movement detection rely exclusively on device kinetic sensors.
     * - Rejects GPS multipath jitter and wander when physical kinetic energy indicates the phone is at rest.
     * - Computes real-time walking speed from kinetic step cadence.
     * - Computes transit speed from kinetic-validated kinematic displacement and kinetic acceleration profile.
     */
    private fun calculateSpeed(location: Location): SpeedMeasurement {
        val now = SystemClock.elapsedRealtime()

        // 1. Evaluate Step Sensor Cadence
        val recentSteps: Int
        val stepCadence: Float
        synchronized(stepTimestamps) {
            stepTimestamps.removeAll { now - it > 5000L }
            recentSteps = stepTimestamps.size
            stepCadence = if (recentSteps >= 2) {
                val timeSpanSec = (stepTimestamps.last() - stepTimestamps.first()) / 1000.0f
                if (timeSpanSec > 0.4f) (recentSteps - 1) / timeSpanSec else 0.0f
            } else if (recentSteps == 1) {
                1.4f
            } else {
                0.0f
            }
        }

        val lastStepMs = synchronized(stepTimestamps) { stepTimestamps.lastOrNull() ?: 0L }
        val isStepActive = recentSteps > 0 && (now - lastStepMs) < 2500L
        val isStationaryKinetic = kineticEnergy < 0.22f && !isStepActive

        // 2. Device Kinetic Stationary Lock
        // When device kinetic sensors indicate zero physical acceleration (< 0.22 m/s²),
        // the phone is physically at rest. Clamps velocity to strictly 0.0 km/h.
        if (isStationaryKinetic) {
            smoothedSpeedKmh = 0.0f
            return SpeedMeasurement(0.0f, "Kinetic Stationary Lock")
        }

        // 3. Pedestrian Walking Velocity via Biometric Kinetic Cadence
        // Speed = cadence (steps/sec) * stride (0.74m) * 3.6 km/h
        if (isStepActive && stepCadence >= 0.4f) {
            val biometricWalkingSpeedKmh = (stepCadence * 0.74f * 3.6f).coerceIn(2.5f, 7.5f)
            smoothedSpeedKmh = if (smoothedSpeedKmh < 1.0f) {
                biometricWalkingSpeedKmh
            } else {
                0.75f * biometricWalkingSpeedKmh + 0.25f * smoothedSpeedKmh
            }
            return SpeedMeasurement(smoothedSpeedKmh, "Kinetic Step Cadence (Walking)")
        }

        // 4. Transit & Vehicular Kinetic Sensing (Vehicle / High-Speed Transit)
        // Kinetic acceleration confirmed active (> 0.22 m/s² from motor/road vibration).
        // Derive velocity from kinematic displacement over monotonic elapsed time.
        val prev = lastRecordedLocation
        if (prev != null) {
            val deltaMeters = prev.distanceTo(location)
            val deltaTimeSec = (location.elapsedRealtimeNanos - prev.elapsedRealtimeNanos) / 1_000_000_000.0

            if (deltaTimeSec in 0.5..60.0 && deltaMeters >= 1.5f) {
                val derivedSpeedKmh = ((deltaMeters / deltaTimeSec) * 3.6).toFloat()
                if (derivedSpeedKmh in 1.5f..260.0f) {
                    smoothedSpeedKmh = if (smoothedSpeedKmh < 1.0f) {
                        derivedSpeedKmh
                    } else {
                        0.70f * derivedSpeedKmh + 0.30f * smoothedSpeedKmh
                    }
                    val method = if (smoothedSpeedKmh >= 80.0f) {
                        "Kinetic High-Speed Transit"
                    } else {
                        "Kinetic Transit Sensor (Vehicle)"
                    }
                    return SpeedMeasurement(smoothedSpeedKmh, method)
                }
            }
        }

        // 5. Kinetic Transition / Dynamic Fallback
        val finalSpeed = if (smoothedSpeedKmh >= 1.2f) smoothedSpeedKmh else 0.0f
        val method = if (finalSpeed > 0.0f) "Kinetic Motion Sensor" else "Kinetic Stationary Lock"
        return SpeedMeasurement(finalSpeed, method)
    }

    private fun processLocationUpdate(location: Location) {
        val (speedKmh, sensingMethod) = calculateSpeed(location)
        val mode = classifyTransportMode(speedKmh)
        val now = System.currentTimeMillis()

        // Accumulate active journey distance
        if (isJourneyActive && lastRecordedLocation != null) {
            val deltaMeters = lastRecordedLocation!!.distanceTo(location)
            if (deltaMeters in 0.5f..500.0f) {
                journeyDistanceMeters += deltaMeters
                if (speedKmh > journeyMaxSpeedKmh) {
                    journeyMaxSpeedKmh = speedKmh
                }
            }
        }

        // Read battery information
        val (batteryLevel, isCharging) = getBatteryInfo()

        val isoTimestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date(location.time))

        // IMMEDIATELY update local state flow so phone UI is zero-latency
        _liveState.value = _liveState.value.copy(
            latitude = location.latitude,
            longitude = location.longitude,
            speedKmh = speedKmh,
            accuracyMeters = location.accuracy,
            transportMode = mode,
            speedSensingMethod = sensingMethod,
            batteryLevel = batteryLevel,
            isCharging = isCharging,
            lastPingTimestamp = isoTimestamp,
            statusMessage = "Last fix: ${String.format(Locale.US, "%.1f", speedKmh)} km/h • $mode ($sensingMethod)"
        )

        // Evaluate whether to dispatch a telemetry ping to Supabase
        val prevDispatched = lastDispatchedLocation
        val modeChanged = mode != lastReportedMode
        val distanceMovedSinceDispatch = prevDispatched?.distanceTo(location) ?: 999.0f
        val timeSinceLastDispatch = now - lastDispatchedTimestampMs
        val isStationary = mode == "stationary"

        val shouldDispatch = when {
            prevDispatched == null -> true // First fix dispatched immediately
            consecutiveDispatches < 5 && timeSinceLastDispatch >= 2000L -> true // Quick initial synchronization burst
            modeChanged -> true // Immediate dispatch on stop or move transition
            !isStationary && (timeSinceLastDispatch >= 2500L || distanceMovedSinceDispatch >= 4.0f) -> true
            isStationary && timeSinceLastDispatch >= 10000L -> true // Periodic 10s heartbeat (down from 60s)
            else -> false
        }

        lastRecordedLocation = location

        if (shouldDispatch) {
            lastDispatchedLocation = location
            lastDispatchedTimestampMs = now
            lastReportedMode = mode
            consecutiveDispatches++

            val currentPinType = if (isJourneyActive) "in_travel" else "ambient"
            val ping = LocationPingEntity(
                userId = supabaseManager.userId,
                deviceId = supabaseManager.deviceId,
                deviceName = supabaseManager.deviceName,
                latitude = location.latitude,
                longitude = location.longitude,
                altitude = if (location.hasAltitude()) location.altitude else null,
                accuracyMeters = if (location.hasAccuracy()) location.accuracy else null,
                speedKmh = speedKmh,
                heading = if (location.hasBearing()) location.bearing else null,
                batteryLevel = batteryLevel,
                isCharging = isCharging,
                transportMode = mode,
                recordedAt = isoTimestamp,
                journeyId = if (isJourneyActive) activeJourneyId else null,
                pinType = currentPinType
            )

            serviceScope.launch {
                val result = supabaseManager.dispatchPing(ping)
                val currentOffline = supabaseManager.getOfflineCount()

                val statusText: String
                if (result.isSuccess) {
                    pingCounter++
                    statusText = if (currentOffline > 0) {
                        "HTTP ${result.getOrNull()} (Flushing: $currentOffline left)"
                    } else {
                        "HTTP ${result.getOrNull()}"
                    }
                } else {
                    val ex = result.exceptionOrNull()
                    val msg = ex?.message ?: "Error"
                    val detail = msg.substringAfter(": ").trim().take(35)
                    statusText = when {
                        msg.contains("Not Configured", ignoreCase = true) -> "Not Paired"
                        msg.contains("HTTP 401", ignoreCase = true) -> if (detail.isNotBlank() && !detail.startsWith("HTTP")) "HTTP 401 ($detail)" else "HTTP 401 (Auth Failed)"
                        msg.contains("HTTP 403", ignoreCase = true) -> if (detail.isNotBlank() && !detail.startsWith("HTTP")) "HTTP 403 ($detail)" else "HTTP 403 (Perm Denied)"
                        msg.contains("HTTP 400", ignoreCase = true) -> if (detail.isNotBlank() && !detail.startsWith("HTTP")) "HTTP 400 ($detail)" else "HTTP 400 (Bad Request)"
                        msg.contains("HTTP 409", ignoreCase = true) -> "HTTP 409 ($detail)"
                        else -> "Offline Cached ($currentOffline queued)"
                    }
                }

                _liveState.value = _liveState.value.copy(
                    totalPingsTransmitted = pingCounter,
                    pendingOfflineCount = currentOffline,
                    lastHttpStatus = statusText
                )

                val summaryText = "${String.format(Locale.US, "%.0f", speedKmh)} km/h ($mode) • $statusText • $pingCounter sent"
                notificationManager.notify(NOTIFICATION_ID, buildNotification(summaryText))
            }
        } else {
            // Update ongoing notification even if database dispatch was throttled
            serviceScope.launch {
                val currentOffline = supabaseManager.getOfflineCount()
                _liveState.value = _liveState.value.copy(pendingOfflineCount = currentOffline)
                val summaryText = "${String.format(Locale.US, "%.0f", speedKmh)} km/h ($mode) • ${_liveState.value.lastHttpStatus} • $pingCounter sent"
                notificationManager.notify(NOTIFICATION_ID, buildNotification(summaryText))
            }
        }
    }

    private fun classifyTransportMode(speedKmh: Float): String {
        return when {
            speedKmh < 1.5f -> "stationary"
            speedKmh < 12.0f -> "walking"
            speedKmh < 28.0f -> "cycling"
            speedKmh >= 80.0f -> "high_speed_transit"
            else -> "vehicle"
        }
    }

    private fun getBatteryInfo(): Pair<Float, Boolean> {
        val intentFilter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val batteryStatus = registerReceiver(null, intentFilter)
        val level = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val batteryPct = if (level >= 0 && scale > 0) (level * 100f / scale) else 0.0f

        val status = batteryStatus?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL

        return Pair(batteryPct, isCharging)
    }

    private fun stopTracking() {
        if (isJourneyActive) {
            endJourneySession()
        }
        unregisterKineticSensors()
        fusedLocationClient.removeLocationUpdates(locationCallback)
        smoothedSpeedKmh = 0.0f
        kineticEnergy = 0.0f
        synchronized(stepTimestamps) {
            stepTimestamps.clear()
        }
        lastRecordedLocation = null
        lastDispatchedLocation = null
        lastReportedMode = "stationary"
        consecutiveDispatches = 0

        _liveState.value = _liveState.value.copy(
            isTracking = false,
            speedKmh = 0.0f,
            transportMode = "stationary",
            speedSensingMethod = "Stopped",
            statusMessage = "Tracking paused"
        )
    }

    private fun startJourneySession() {
        val journeyId = UUID.randomUUID().toString()
        val nowMs = SystemClock.elapsedRealtime()
        val isoTimestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date())

        isJourneyActive = true
        activeJourneyId = journeyId
        journeyStartTimeMs = nowMs
        journeyStartIsoTime = isoTimestamp
        journeyDistanceMeters = 0.0f
        journeyMaxSpeedKmh = 0.0f

        val loc = lastRecordedLocation
        journeyStartLocation = loc
        val startLat = loc?.latitude ?: 0.0
        val startLng = loc?.longitude ?: 0.0

        supabaseManager.setActiveJourney(journeyId, isoTimestamp, startLat, startLng)

        serviceScope.launch {
            supabaseManager.createJourneyRecord(
                journeyId = journeyId,
                startTime = isoTimestamp,
                startLat = startLat,
                startLng = startLng,
                primaryMode = lastReportedMode
            )

            // Immediately send Start Pin if location is available
            if (loc != null) {
                val (batLevel, isChg) = getBatteryInfo()
                val startPing = LocationPingEntity(
                    userId = supabaseManager.userId,
                    deviceId = supabaseManager.deviceId,
                    deviceName = supabaseManager.deviceName,
                    latitude = loc.latitude,
                    longitude = loc.longitude,
                    altitude = if (loc.hasAltitude()) loc.altitude else null,
                    accuracyMeters = if (loc.hasAccuracy()) loc.accuracy else null,
                    speedKmh = smoothedSpeedKmh,
                    heading = if (loc.hasBearing()) loc.bearing else null,
                    batteryLevel = batLevel,
                    isCharging = isChg,
                    transportMode = lastReportedMode,
                    recordedAt = isoTimestamp,
                    journeyId = journeyId,
                    pinType = "start"
                )
                supabaseManager.dispatchPing(startPing)
            }
        }

        journeyTickerJob?.cancel()
        journeyTickerJob = serviceScope.launch {
            while (isJourneyActive) {
                val elapsedSec = maxOf(0L, (SystemClock.elapsedRealtime() - journeyStartTimeMs) / 1000L)
                val distKm = journeyDistanceMeters / 1000.0f
                val avgSpeed = if (elapsedSec > 0) (distKm / (elapsedSec / 3600.0f)) else 0.0f
                _liveState.value = _liveState.value.copy(
                    isJourneyActive = true,
                    activeJourneyId = journeyId,
                    journeyStartTimeMs = journeyStartTimeMs,
                    journeyDurationSeconds = elapsedSec,
                    journeyDistanceKm = distKm,
                    journeyAvgSpeedKmh = avgSpeed,
                    journeyStartLat = startLat,
                    journeyStartLng = startLng,
                    journeyMaxSpeedKmh = journeyMaxSpeedKmh
                )
                delay(1000L)
            }
        }
        Log.i(TAG, "Started journey session $journeyId")
    }

    private fun endJourneySession() {
        if (!isJourneyActive) return
        val journeyId = activeJourneyId ?: return
        val endMs = SystemClock.elapsedRealtime()
        val durationSec = maxOf(1L, (endMs - journeyStartTimeMs) / 1000L)
        val distKm = journeyDistanceMeters / 1000.0f
        val avgSpeed = if (durationSec > 0) (distKm / (durationSec / 3600.0f)) else 0.0f
        val maxSpeed = journeyMaxSpeedKmh
        val primaryMode = lastReportedMode
        val estimatedCost = calculateEstimatedCost(distKm, primaryMode)

        val endLoc = lastRecordedLocation
        val endLat = endLoc?.latitude ?: 0.0
        val endLng = endLoc?.longitude ?: 0.0
        val isoEndTime = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date())

        isJourneyActive = false
        journeyTickerJob?.cancel()
        journeyTickerJob = null
        supabaseManager.setActiveJourney(null)

        val summary = CompletedJourneySummary(
            journeyId = journeyId,
            startTime = journeyStartIsoTime,
            endTime = isoEndTime,
            startLat = journeyStartLocation?.latitude ?: 0.0,
            startLng = journeyStartLocation?.longitude ?: 0.0,
            endLat = endLat,
            endLng = endLng,
            durationSeconds = durationSec,
            distanceKm = distKm,
            avgSpeedKmh = avgSpeed,
            maxSpeedKmh = maxSpeed,
            estimatedCost = estimatedCost,
            primaryMode = primaryMode
        )

        _liveState.value = _liveState.value.copy(
            isJourneyActive = false,
            activeJourneyId = null,
            completedJourney = summary
        )

        serviceScope.launch {
            if (endLoc != null) {
                val (batLevel, isChg) = getBatteryInfo()
                val endPing = LocationPingEntity(
                    userId = supabaseManager.userId,
                    deviceId = supabaseManager.deviceId,
                    deviceName = supabaseManager.deviceName,
                    latitude = endLoc.latitude,
                    longitude = endLoc.longitude,
                    altitude = if (endLoc.hasAltitude()) endLoc.altitude else null,
                    accuracyMeters = if (endLoc.hasAccuracy()) endLoc.accuracy else null,
                    speedKmh = smoothedSpeedKmh,
                    heading = if (endLoc.hasBearing()) endLoc.bearing else null,
                    batteryLevel = batLevel,
                    isCharging = isChg,
                    transportMode = primaryMode,
                    recordedAt = isoEndTime,
                    journeyId = journeyId,
                    pinType = "end"
                )
                supabaseManager.dispatchPing(endPing)
            }

            supabaseManager.completeJourneyRecord(
                journeyId = journeyId,
                endTime = isoEndTime,
                endLat = endLat,
                endLng = endLng,
                distanceKm = distKm,
                durationSeconds = durationSec,
                avgSpeedKmh = avgSpeed,
                maxSpeedKmh = maxSpeed,
                estimatedCost = estimatedCost,
                primaryMode = primaryMode
            )
        }
        Log.i(TAG, "Completed journey $journeyId: ${distKm}km, ${durationSec}s, avg ${avgSpeed}km/h")
    }

    private fun calculateEstimatedCost(distKm: Float, mode: String): Float {
        return when (mode) {
            "walking", "cycling" -> 0.0f
            "high_speed_transit" -> (distKm * 0.08f).coerceAtLeast(1.5f)
            else -> (distKm * 0.18f).coerceAtLeast(2.5f)
        }
    }

    private fun buildNotification(contentText: String): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingOpenApp = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, LocationTrackingService::class.java).apply {
            action = if (isJourneyActive) ACTION_END_JOURNEY else ACTION_STOP
        }
        val pendingStop = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val actionLabel = if (isJourneyActive) "End Journey" else "Pause"
        val titleText = if (isJourneyActive) {
            val sec = _liveState.value.journeyDurationSeconds
            val hh = sec / 3600
            val mm = (sec % 3600) / 60
            val ss = sec % 60
            val timeFmt = if (hh > 0) String.format(Locale.US, "%02d:%02d:%02d", hh, mm, ss) else String.format(Locale.US, "%02d:%02d", mm, ss)
            "🚀 Active Journey • $timeFmt"
        } else {
            "🛰️ Apex LifeOS Kinetic Tracker Active"
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(titleText)
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(pendingOpenApp)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(android.R.drawable.ic_media_pause, actionLabel, pendingStop)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Apex Location Telemetry",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Continuous kinetic sensor location tracking for Apex LifeOS"
                setShowBadge(false)
            }
            notificationManager.createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        stopTracking()
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
