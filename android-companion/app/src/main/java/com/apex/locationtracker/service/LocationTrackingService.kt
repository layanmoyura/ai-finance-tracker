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
import android.location.Location
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
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
    val lastHttpStatus: String = "Idle",
    val statusMessage: String = "Service ready"
)

class LocationTrackingService : Service() {
    private val serviceScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var locationCallback: LocationCallback
    private lateinit var supabaseManager: SupabaseManager
    private lateinit var notificationManager: NotificationManager

    private var lastRecordedLocation: Location? = null
    private var lastDispatchedLocation: Location? = null
    private var lastDispatchedTimestampMs: Long = 0L
    private var lastReportedMode: String = "stationary"
    private var smoothedSpeedKmh: Float = 0.0f
    private var pingCounter = 0

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
        supabaseManager = SupabaseManager(this)
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

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
        val notification = buildNotification("Initializing continuous velocity GPS...")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        requestLocationUpdates()
        _liveState.value = _liveState.value.copy(
            isTracking = true,
            statusMessage = "Tracking active (Foreground Service)"
        )
    }

    @SuppressLint("MissingPermission")
    private fun requestLocationUpdates() {
        fusedLocationClient.removeLocationUpdates(locationCallback)

        // Continuous high-accuracy velocity sensing:
        // Update interval 3s, fastest 1.5s, displacement 0.0m to guarantee Doppler velocity calculation
        val locationRequest = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 3000L)
            .setMinUpdateIntervalMillis(1500L)
            .setMinUpdateDistanceMeters(0.0f)
            .setWaitForAccurateLocation(false)
            .build()

        fusedLocationClient.requestLocationUpdates(
            locationRequest,
            locationCallback,
            Looper.getMainLooper()
        )
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
     * Hybrid Speed Sensing Engine:
     * 1. Evaluates direct hardware Doppler velocity reported by GNSS receiver.
     * 2. Fallbacks to kinematic displacement / monotonic elapsed time when hardware speed is missing or 0.
     * 3. Rejects stationary GPS jitter within horizontal accuracy radius.
     * 4. Applies Exponential Moving Average (EMA) smoothing for analog-smooth speedometer rendering.
     */
    private fun calculateSpeed(location: Location): SpeedMeasurement {
        var rawSpeedKmh = 0.0f
        var speedDetermined = false
        var method = "Stationary Lock"

        // 1. Direct Hardware Doppler Speed from GPS receiver
        if (location.hasSpeed() && location.speed >= 0.0f) {
            val isAccurate = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && location.hasSpeedAccuracy()) {
                location.speedAccuracyMetersPerSecond < 4.0f
            } else {
                true
            }
            if (isAccurate) {
                val hwKmh = location.speed * 3.6f
                if (hwKmh >= 1.2f) {
                    rawSpeedKmh = hwKmh
                    speedDetermined = true
                    method = "GPS Doppler"
                }
            }
        }

        // 2. Kinematic Velocity Fallback (delta distance / delta monotonic time)
        val prev = lastRecordedLocation
        if (prev != null) {
            val deltaMeters = prev.distanceTo(location)
            val deltaTimeSec = (location.elapsedRealtimeNanos - prev.elapsedRealtimeNanos) / 1_000_000_000.0

            if (deltaTimeSec in 0.5..60.0) {
                val jitterRadius = (location.accuracy + prev.accuracy) * 0.5f

                if (deltaMeters <= jitterRadius && deltaMeters < 5.0f) {
                    // Fix falls inside horizontal GPS noise radius
                    if (!speedDetermined) {
                        rawSpeedKmh = 0.0f
                        speedDetermined = true
                        method = "Stationary (Noise Gate)"
                    }
                } else if (deltaMeters >= 5.0f) {
                    val derivedSpeedKmh = ((deltaMeters / deltaTimeSec) * 3.6).toFloat()
                    if (!speedDetermined || (rawSpeedKmh == 0.0f && derivedSpeedKmh >= 2.0f)) {
                        // Clamp unrealistic speed jumps (e.g. cellular tower triangulation hopping > 220 km/h)
                        if (derivedSpeedKmh <= 220.0f) {
                            rawSpeedKmh = derivedSpeedKmh
                            speedDetermined = true
                            method = "Kinematic Delta"
                        }
                    }
                }
            }
        }

        // 3. Speed Smoothing via Exponential Moving Average (EMA)
        val finalSpeedKmh: Float
        if (rawSpeedKmh >= 1.2f) {
            smoothedSpeedKmh = if (smoothedSpeedKmh < 1.0f) {
                rawSpeedKmh
            } else {
                0.70f * rawSpeedKmh + 0.30f * smoothedSpeedKmh
            }
            finalSpeedKmh = smoothedSpeedKmh
        } else {
            smoothedSpeedKmh = 0.0f
            finalSpeedKmh = 0.0f
            method = "Stationary / Parked"
        }

        return SpeedMeasurement(finalSpeedKmh, method)
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
            prevDispatched == null -> true
            modeChanged -> true // Immediate dispatch on stop or move
            !isStationary && (timeSinceLastDispatch >= 3000L || distanceMovedSinceDispatch >= 12.0f) -> true
            isStationary && timeSinceLastDispatch >= 60000L -> true // Periodic heartbeat
            else -> false
        }

        lastRecordedLocation = location

        if (shouldDispatch) {
            lastDispatchedLocation = location
            lastDispatchedTimestampMs = now
            lastReportedMode = mode

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
                pingCounter++

                val statusText = if (result.isSuccess) {
                    "HTTP ${result.getOrNull()}"
                } else {
                    "Offline Cached"
                }

                _liveState.value = _liveState.value.copy(
                    totalPingsTransmitted = pingCounter,
                    lastHttpStatus = statusText
                )

                val summaryText = "${String.format(Locale.US, "%.0f", speedKmh)} km/h ($mode) • $statusText • $pingCounter pings"
                notificationManager.notify(NOTIFICATION_ID, buildNotification(summaryText))
            }
        } else {
            // Update ongoing notification even if database dispatch was throttled
            val summaryText = "${String.format(Locale.US, "%.0f", speedKmh)} km/h ($mode) • ${_liveState.value.lastHttpStatus} • $pingCounter pings"
            notificationManager.notify(NOTIFICATION_ID, buildNotification(summaryText))
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
        fusedLocationClient.removeLocationUpdates(locationCallback)
        smoothedSpeedKmh = 0.0f
        lastRecordedLocation = null
        lastDispatchedLocation = null
        lastReportedMode = "stationary"
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
            .setContentTitle("🛰️ Apex LifeOS Tracker Active")
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
                description = "Continuous background location tracking for Apex LifeOS"
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
