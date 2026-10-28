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
    val speedSensingMethod: String = "Calculated (Distance / Time)",
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

class LocationTrackingService : Service() {
    private val serviceScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var locationCallback: LocationCallback
    private lateinit var supabaseManager: SupabaseManager
    private lateinit var notificationManager: NotificationManager

    private var lastRecordedLocation: Location? = null
    private var pingCounter: Int = 0

    // Active Journey Session Variables
    private var isJourneyActive: Boolean = false
    private var activeJourneyId: String? = null
    private var journeyStartTimeMs: Long = 0L
    private var journeyStartIsoTime: String = ""
    private var journeyStartLocation: Location? = null
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
        val notification = buildNotification("Timeline location tracking active...")
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
            statusMessage = "Timeline location tracking active"
        )
    }

    @SuppressLint("MissingPermission")
    private fun requestLocationUpdates() {
        fusedLocationClient.removeLocationUpdates(locationCallback)

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

    /**
     * Process location update from GPS provider:
     * - In-between pings along the way are COMPLETELY DROPPED (no telemetry pings sent during travel).
     * - Only Start Pin is sent on start, and End Pin is sent on end.
     * - Live speed is calculated strictly as straight-line distance from Start Point divided by elapsed time.
     */
    private fun processLocationUpdate(location: Location) {
        lastRecordedLocation = location
        val (batteryLevel, isCharging) = getBatteryInfo()
        val isoTimestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date(location.time))

        if (isJourneyActive && journeyStartLocation != null) {
            val startLoc = journeyStartLocation!!
            val distMeters = startLoc.distanceTo(location)
            val distKm = distMeters / 1000.0f
            val elapsedSec = maxOf(1L, (SystemClock.elapsedRealtime() - journeyStartTimeMs) / 1000L)
            val hours = elapsedSec / 3600.0f
            val calculatedSpeedKmh = if (hours > 0) distKm / hours else 0.0f
            val mode = classifyTransportMode(calculatedSpeedKmh)

            _liveState.value = _liveState.value.copy(
                latitude = location.latitude,
                longitude = location.longitude,
                speedKmh = calculatedSpeedKmh,
                accuracyMeters = location.accuracy,
                transportMode = mode,
                batteryLevel = batteryLevel,
                isCharging = isCharging,
                lastPingTimestamp = isoTimestamp,
                journeyDistanceKm = distKm,
                journeyAvgSpeedKmh = calculatedSpeedKmh,
                journeyDurationSeconds = elapsedSec,
                statusMessage = "Journey active: ${String.format(Locale.US, "%.2f", distKm)} km • ${String.format(Locale.US, "%.1f", calculatedSpeedKmh)} km/h"
            )

            val summaryText = "${String.format(Locale.US, "%.2f", distKm)} km • ${String.format(Locale.US, "%.1f", calculatedSpeedKmh)} km/h ($mode)"
            notificationManager.notify(NOTIFICATION_ID, buildNotification(summaryText))
        } else {
            _liveState.value = _liveState.value.copy(
                latitude = location.latitude,
                longitude = location.longitude,
                speedKmh = 0.0f,
                accuracyMeters = location.accuracy,
                transportMode = "stationary",
                batteryLevel = batteryLevel,
                isCharging = isCharging,
                lastPingTimestamp = isoTimestamp,
                statusMessage = "Ready • Lat: ${String.format(Locale.US, "%.4f", location.latitude)}, Lng: ${String.format(Locale.US, "%.4f", location.longitude)}"
            )
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
        fusedLocationClient.removeLocationUpdates(locationCallback)
        lastRecordedLocation = null

        _liveState.value = _liveState.value.copy(
            isTracking = false,
            speedKmh = 0.0f,
            transportMode = "stationary",
            statusMessage = "Tracking paused"
        )
    }

    @SuppressLint("MissingPermission")
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
                primaryMode = "vehicle"
            )

            // Send Departure Start Pin
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
                    speedKmh = 0.0f,
                    heading = if (loc.hasBearing()) loc.bearing else null,
                    batteryLevel = batLevel,
                    isCharging = isChg,
                    transportMode = "stationary",
                    recordedAt = isoTimestamp,
                    journeyId = journeyId,
                    pinType = "start"
                )
                val result = supabaseManager.dispatchPing(startPing)
                if (result.isSuccess) {
                    pingCounter++
                    _liveState.value = _liveState.value.copy(
                        totalPingsTransmitted = pingCounter,
                        lastHttpStatus = "HTTP ${result.getOrNull()} (Start Pin)"
                    )
                }
            }
        }

        journeyTickerJob?.cancel()
        journeyTickerJob = serviceScope.launch {
            while (isJourneyActive) {
                val elapsedSec = maxOf(0L, (SystemClock.elapsedRealtime() - journeyStartTimeMs) / 1000L)
                val start = journeyStartLocation
                val curr = lastRecordedLocation
                val distMeters = if (start != null && curr != null) start.distanceTo(curr) else 0.0f
                val distKm = distMeters / 1000.0f
                val hours = elapsedSec / 3600.0f
                val calcSpeed = if (hours > 0) distKm / hours else 0.0f

                _liveState.value = _liveState.value.copy(
                    isJourneyActive = true,
                    activeJourneyId = journeyId,
                    journeyStartTimeMs = journeyStartTimeMs,
                    journeyDurationSeconds = elapsedSec,
                    journeyDistanceKm = distKm,
                    journeyAvgSpeedKmh = calcSpeed,
                    journeyStartLat = startLat,
                    journeyStartLng = startLng,
                    journeyMaxSpeedKmh = calcSpeed
                )
                delay(1000L)
            }
        }
        Log.i(TAG, "Started journey session $journeyId with Start Pin")
    }

    private fun endJourneySession() {
        if (!isJourneyActive) return
        val journeyId = activeJourneyId ?: return
        val endMs = SystemClock.elapsedRealtime()
        val durationSec = maxOf(1L, (endMs - journeyStartTimeMs) / 1000L)
        val isoEndTime = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date())

        val startLoc = journeyStartLocation
        val endLoc = lastRecordedLocation
        val endLat = endLoc?.latitude ?: 0.0
        val endLng = endLoc?.longitude ?: 0.0
        val startLat = startLoc?.latitude ?: 0.0
        val startLng = startLoc?.longitude ?: 0.0

        // Distance strictly calculated between Start Point and End Point
        val distMeters = if (startLoc != null && endLoc != null) startLoc.distanceTo(endLoc) else 0.0f
        val distKm = distMeters / 1000.0f

        // Speed calculated strictly based on start point and end point times:
        // Speed = Distance(start, end) / Delta_T
        val hours = durationSec / 3600.0f
        val calculatedSpeedKmh = if (hours > 0) distKm / hours else 0.0f
        val primaryMode = classifyTransportMode(calculatedSpeedKmh)
        val estimatedCost = calculateEstimatedCost(distKm, primaryMode)

        isJourneyActive = false
        journeyTickerJob?.cancel()
        journeyTickerJob = null
        supabaseManager.setActiveJourney(null)

        val summary = CompletedJourneySummary(
            journeyId = journeyId,
            startTime = journeyStartIsoTime,
            endTime = isoEndTime,
            startLat = startLat,
            startLng = startLng,
            endLat = endLat,
            endLng = endLng,
            durationSeconds = durationSec,
            distanceKm = distKm,
            avgSpeedKmh = calculatedSpeedKmh,
            maxSpeedKmh = calculatedSpeedKmh,
            estimatedCost = estimatedCost,
            primaryMode = primaryMode
        )

        _liveState.value = _liveState.value.copy(
            isJourneyActive = false,
            activeJourneyId = null,
            completedJourney = summary
        )

        serviceScope.launch {
            // Send Arrival End Pin
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
                    speedKmh = calculatedSpeedKmh,
                    heading = if (endLoc.hasBearing()) endLoc.bearing else null,
                    batteryLevel = batLevel,
                    isCharging = isChg,
                    transportMode = primaryMode,
                    recordedAt = isoEndTime,
                    journeyId = journeyId,
                    pinType = "end"
                )
                val result = supabaseManager.dispatchPing(endPing)
                if (result.isSuccess) {
                    pingCounter++
                    _liveState.value = _liveState.value.copy(
                        totalPingsTransmitted = pingCounter,
                        lastHttpStatus = "HTTP ${result.getOrNull()} (End Pin)"
                    )
                }
            }

            supabaseManager.completeJourneyRecord(
                journeyId = journeyId,
                endTime = isoEndTime,
                endLat = endLat,
                endLng = endLng,
                distanceKm = distKm,
                durationSeconds = durationSec,
                avgSpeedKmh = calculatedSpeedKmh,
                maxSpeedKmh = calculatedSpeedKmh,
                estimatedCost = estimatedCost,
                primaryMode = primaryMode
            )
        }
        Log.i(TAG, "Completed journey $journeyId: ${distKm}km, ${durationSec}s, speed based on start/end: ${calculatedSpeedKmh}km/h")
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
            "🚀 Journey In Progress • $timeFmt"
        } else {
            "🛰️ Apex LifeOS Tracker Ready"
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
                description = "Timeline location tracking for Apex LifeOS"
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
