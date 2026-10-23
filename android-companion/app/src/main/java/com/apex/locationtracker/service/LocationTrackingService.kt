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
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.sqrt

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
    val statusMessage: String = "Service ready"
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

    companion object {
        private const val TAG = "LocationTrackingService"
        private const val CHANNEL_ID = "apex_location_tracker_channel"
        private const val NOTIFICATION_ID = 40401

        const val ACTION_START = "com.apex.locationtracker.START"
        const val ACTION_STOP = "com.apex.locationtracker.STOP"

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
                stopTracking()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            ACTION_START, null -> {
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
                recordedAt = isoTimestamp
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
            action = ACTION_STOP
        }
        val pendingStop = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("🛰️ Apex LifeOS Kinetic Tracker Active")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(pendingOpenApp)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(android.R.drawable.ic_media_pause, "Pause", pendingStop)
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
