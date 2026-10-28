package com.apex.locationtracker

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.apex.locationtracker.data.SupabaseManager
import com.apex.locationtracker.service.LocationTrackingService
import kotlinx.coroutines.launch
import java.util.Locale

class MainActivity : ComponentActivity() {
    private lateinit var supabaseManager: SupabaseManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        supabaseManager = SupabaseManager.getInstance(this)

        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Color(0xFF10B981), // Emerald
                    background = Color(0xFF020617), // Slate 950
                    surface = Color(0xFF0F172A), // Slate 900
                    onPrimary = Color.Black,
                    onBackground = Color(0xFFF8FAFC),
                    onSurface = Color(0xFFF1F5F9)
                )
            ) {
                TrackerAppScreen(
                    supabaseManager = supabaseManager,
                    onStartService = { startLocationService() },
                    onStopService = { stopLocationService() },
                    onStartJourney = { startJourneyService() },
                    onEndJourney = { endJourneyService() },
                    onClearCompletedJourney = { clearCompletedJourney() },
                    onRequestBatteryWhitelist = { requestIgnoreBatteryOptimization() }
                )
            }
        }
    }

    private fun startLocationService() {
        val intent = Intent(this, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun stopLocationService() {
        val intent = Intent(this, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_STOP
        }
        startService(intent)
    }

    private fun startJourneyService() {
        val intent = Intent(this, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_START_JOURNEY
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun endJourneyService() {
        val intent = Intent(this, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_END_JOURNEY
        }
        startService(intent)
    }

    private fun clearCompletedJourney() {
        val intent = Intent(this, LocationTrackingService::class.java).apply {
            action = LocationTrackingService.ACTION_CLEAR_COMPLETED_JOURNEY
        }
        startService(intent)
    }

    @SuppressLint("BatteryLife")
    private fun requestIgnoreBatteryOptimization() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
        } else {
            Toast.makeText(this, "Battery optimization already disabled!", Toast.LENGTH_SHORT).show()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrackerAppScreen(
    supabaseManager: SupabaseManager,
    onStartService: () -> Unit,
    onStopService: () -> Unit,
    onStartJourney: () -> Unit,
    onEndJourney: () -> Unit,
    onClearCompletedJourney: () -> Unit,
    onRequestBatteryWhitelist: () -> Unit
) {
    val liveState by LocationTrackingService.liveState.collectAsState()
    val context = androidx.compose.ui.platform.LocalContext.current
    val coroutineScope = rememberCoroutineScope()

    var showConfigModal by remember { mutableStateOf(!supabaseManager.isConfigured) }
    var offlineCount by remember { mutableIntStateOf(0) }
    var isSyncing by remember { mutableStateOf(false) }

    // Commute expense state
    var isSubmittingExpense by remember { mutableStateOf(false) }
    var isEditingExpense by remember { mutableStateOf(false) }
    var editedAmount by remember { mutableStateOf("") }
    var editedNotes by remember { mutableStateOf("") }
    var isBusinessTrip by remember { mutableStateOf(false) }

    LaunchedEffect(liveState.totalPingsTransmitted, liveState.lastHttpStatus, liveState.pendingOfflineCount) {
        offlineCount = supabaseManager.getOfflineCount()
    }

    // Permission Launchers
    val locationPermissionsLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val fineGranted = permissions[Manifest.permission.ACCESS_FINE_LOCATION] ?: false
        if (fineGranted) {
            Toast.makeText(context, "Location & telemetry access granted", Toast.LENGTH_SHORT).show()
            if (supabaseManager.isConfigured) {
                onStartService()
            }
        } else {
            Toast.makeText(context, "Precise location is required for timeline journey tracking", Toast.LENGTH_LONG).show()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "🛰️ Apex Tracker",
                            fontWeight = FontWeight.Bold,
                            fontSize = 20.sp
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { showConfigModal = true }) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings", tint = Color.LightGray)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color(0xFF020617)
                )
            )
        },
        containerColor = Color(0xFF020617)
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Connection Status Banner
            Card(
                colors = CardDefaults.cardColors(
                    containerColor = if (supabaseManager.isConfigured) Color(0xFF064E3B) else Color(0xFF7F1D1D)
                ),
                shape = RoundedCornerShape(12.dp)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(14.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = if (supabaseManager.isConfigured) "🟢 Secure Endpoint Active" else "🔴 Pairing Required",
                            fontWeight = FontWeight.Bold,
                            color = Color.White,
                            fontSize = 14.sp
                        )
                        Text(
                            text = if (supabaseManager.isConfigured) "${supabaseManager.deviceName} • ${supabaseManager.getMaskedUrl()}" else "Scan QR or paste pairing token from web app",
                            color = Color(0xFFCBD5E1),
                            fontSize = 12.sp
                        )
                    }
                    if (!supabaseManager.isConfigured) {
                        Button(
                            onClick = { showConfigModal = true },
                            colors = ButtonDefaults.buttonColors(containerColor = Color.White)
                        ) {
                            Text("Pair App", color = Color.Black, fontSize = 12.sp)
                        }
                    }
                }
            }

            // Timeline Mode Information Card
            Card(
                colors = CardDefaults.cardColors(containerColor = Color(0xFF0F172A)),
                shape = RoundedCornerShape(12.dp)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Icon(
                        Icons.Default.Timeline,
                        contentDescription = null,
                        tint = Color(0xFF38BDF8),
                        modifier = Modifier.size(24.dp)
                    )
                    Column {
                        Text(
                            text = "Timeline Pin Tracking",
                            fontWeight = FontWeight.Bold,
                            color = Color.White,
                            fontSize = 13.sp
                        )
                        Text(
                            text = "Start Pin sent on departure. End Pin sent on arrival. Speed is computed strictly from ΔT between start and end.",
                            color = Color(0xFF94A3B8),
                            fontSize = 11.sp
                        )
                    }
                }
            }

            // Active Journey Card (when journey is in progress)
            if (liveState.isJourneyActive) {
                Card(
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF064E3B)),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "🚀 ACTIVE JOURNEY",
                                fontWeight = FontWeight.ExtraBold,
                                color = Color(0xFF34D399),
                                fontSize = 13.sp
                            )
                            val sec = liveState.journeyDurationSeconds
                            val hh = sec / 3600
                            val mm = (sec % 3600) / 60
                            val ss = sec % 60
                            val timerStr = if (hh > 0) String.format(Locale.US, "%02d:%02d:%02d", hh, mm, ss) else String.format(Locale.US, "%02d:%02d", mm, ss)
                            Text(
                                text = "⏱️ $timerStr",
                                fontWeight = FontWeight.Bold,
                                color = Color.White,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 15.sp
                            )
                        }

                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(1.dp)
                                .background(Color(0xFF047857))
                        )

                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Column {
                                Text("Distance", color = Color(0xFFA7F3D0), fontSize = 11.sp)
                                Text(
                                    text = String.format(Locale.US, "%.2f km", liveState.journeyDistanceKm),
                                    fontWeight = FontWeight.Bold,
                                    color = Color.White,
                                    fontSize = 18.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text("Calculated Speed", color = Color(0xFFA7F3D0), fontSize = 11.sp)
                                Text(
                                    text = String.format(Locale.US, "%.1f km/h", liveState.journeyAvgSpeedKmh),
                                    fontWeight = FontWeight.Bold,
                                    color = Color(0xFF38BDF8),
                                    fontSize = 18.sp,
                                    fontFamily = FontFamily.Monospace
                                )
                            }
                        }

                        if (liveState.journeyStartLat != 0.0) {
                            Text(
                                text = "🟢 Start Pin: ${String.format(Locale.US, "%.4f", liveState.journeyStartLat)}°, ${String.format(Locale.US, "%.4f", liveState.journeyStartLng)}°",
                                color = Color(0xFFD1FAE5),
                                fontSize = 11.sp
                            )
                        }
                        if (liveState.latitude != 0.0) {
                            Text(
                                text = "📍 Current: ${String.format(Locale.US, "%.4f", liveState.latitude)}°, ${String.format(Locale.US, "%.4f", liveState.longitude)}°",
                                color = Color(0xFFA7F3D0),
                                fontSize = 11.sp
                            )
                        }
                    }
                }
            }

            // Hardware Telemetry & GPS Details
            Card(
                colors = CardDefaults.cardColors(containerColor = Color(0xFF0F172A)),
                shape = RoundedCornerShape(16.dp)
            ) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        text = "DEVICE TELEMETRY & GPS FIX",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        color = Color(0xFF94A3B8)
                    )

                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Coordinates:", color = Color(0xFF94A3B8), fontSize = 13.sp)
                        Text(
                            text = if (liveState.latitude != 0.0) "${String.format(Locale.US, "%.4f", liveState.latitude)}°, ${String.format(Locale.US, "%.4f", liveState.longitude)}°" else "Awaiting fix...",
                            color = Color.White,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 13.sp
                        )
                    }

                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("GPS Accuracy:", color = Color(0xFF94A3B8), fontSize = 13.sp)
                        Text(
                            text = if (liveState.accuracyMeters > 0) "±${String.format(Locale.US, "%.1f", liveState.accuracyMeters)} m" else "N/A",
                            color = Color(0xFF10B981),
                            fontSize = 13.sp
                        )
                    }

                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Battery Status:", color = Color(0xFF94A3B8), fontSize = 13.sp)
                        Text(
                            text = "${liveState.batteryLevel.toInt()}% ${if (liveState.isCharging) "⚡ Charging" else ""}",
                            color = Color.White,
                            fontSize = 13.sp
                        )
                    }

                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Transmitted Pings:", color = Color(0xFF94A3B8), fontSize = 13.sp)
                        Text(
                            text = "${liveState.totalPingsTransmitted} (${liveState.lastHttpStatus})",
                            color = Color(0xFF38BDF8),
                            fontSize = 13.sp
                        )
                    }

                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Offline Queue:", color = Color(0xFF94A3B8), fontSize = 13.sp)
                        Text(
                            text = if (offlineCount > 0) "$offlineCount pings cached" else "All synced (0 cached)",
                            color = if (offlineCount > 0) Color(0xFFFBBF24) else Color(0xFF10B981),
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 13.sp
                        )
                    }
                }
            }

            // Offline Queue Management Card (visible when offline backlog exists)
            if (offlineCount > 0) {
                Card(
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(14.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = "📦 $offlineCount Cached Pings Pending",
                                fontWeight = FontWeight.Bold,
                                color = Color(0xFFFBBF24),
                                fontSize = 13.sp
                            )
                            Text(
                                text = "Pings queued while offline or during server pause.",
                                color = Color(0xFF94A3B8),
                                fontSize = 11.sp
                            )
                        }
                        Button(
                            onClick = {
                                coroutineScope.launch {
                                    isSyncing = true
                                    val res = supabaseManager.flushOfflineQueue()
                                    offlineCount = supabaseManager.getOfflineCount()
                                    isSyncing = false
                                    if (res.isSuccess) {
                                        Toast.makeText(context, "✅ Flushed ${res.getOrNull()} pings to Supabase!", Toast.LENGTH_SHORT).show()
                                    } else {
                                        Toast.makeText(context, "❌ Flush failed: ${res.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
                                    }
                                }
                            },
                            enabled = !isSyncing && supabaseManager.isConfigured,
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF10B981)),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Text(if (isSyncing) "Syncing..." else "Flush Queue", fontSize = 11.sp, color = Color.Black, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }

            // Dedicated Start & End Journey Controls
            if (liveState.isJourneyActive) {
                // SEPARATE BUTTON TO END JOURNEY
                Button(
                    onClick = { onEndJourney() },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFE11D48)),
                    shape = RoundedCornerShape(14.dp)
                ) {
                    Icon(Icons.Default.Stop, contentDescription = null, tint = Color.White)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "🏁 END JOURNEY (Drop End Pin)",
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp,
                        color = Color.White
                    )
                }
            } else {
                // SEPARATE BUTTON TO START JOURNEY
                Button(
                    onClick = {
                        if (!supabaseManager.isConfigured) {
                            Toast.makeText(context, "⚠️ Please pair companion app before starting journey!", Toast.LENGTH_LONG).show()
                            showConfigModal = true
                            return@Button
                        }
                        val hasFine = ContextCompat.checkSelfPermission(
                            context,
                            Manifest.permission.ACCESS_FINE_LOCATION
                        ) == PackageManager.PERMISSION_GRANTED
                        val hasNotification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            ContextCompat.checkSelfPermission(
                                context,
                                Manifest.permission.POST_NOTIFICATIONS
                            ) == PackageManager.PERMISSION_GRANTED
                        } else {
                            true
                        }

                        if (!hasFine || !hasNotification) {
                            val perms = mutableListOf(
                                Manifest.permission.ACCESS_FINE_LOCATION,
                                Manifest.permission.ACCESS_COARSE_LOCATION
                            )
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                perms.add(Manifest.permission.POST_NOTIFICATIONS)
                            }
                            locationPermissionsLauncher.launch(perms.toTypedArray())
                        } else {
                            onStartJourney()
                        }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF10B981)),
                    shape = RoundedCornerShape(14.dp)
                ) {
                    Icon(Icons.Default.PlayArrow, contentDescription = null, tint = Color.White)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "🚀 START JOURNEY (Drop Start Pin)",
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp,
                        color = Color.White
                    )
                }
            }

            // Battery Whitelist Exemption Banner
            OutlinedButton(
                onClick = onRequestBatteryWhitelist,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp)
            ) {
                Icon(Icons.Default.BatteryChargingFull, contentDescription = null, tint = Color(0xFFFBBF24))
                Spacer(modifier = Modifier.width(8.dp))
                Text("Disable Battery Optimization (Recommended)", fontSize = 13.sp, color = Color(0xFFFBBF24))
            }

            Spacer(modifier = Modifier.height(20.dp))
        }
    }

    // Secure Settings & Pairing Modal
    if (showConfigModal) {
        var tokenInput by remember { mutableStateOf("") }
        var isTestingConnection by remember { mutableStateOf(false) }

        AlertDialog(
            onDismissRequest = { if (supabaseManager.isConfigured) showConfigModal = false },
            title = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Lock, contentDescription = null, tint = Color(0xFF10B981), modifier = Modifier.size(20.dp))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Secure Companion Pairing", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                }
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    // Active Device Status (if configured)
                    if (supabaseManager.isConfigured) {
                        Card(
                            colors = CardDefaults.cardColors(containerColor = Color(0xFF064E3B)),
                            shape = RoundedCornerShape(10.dp)
                        ) {
                            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(
                                    "🟢 Device Active & Encrypted",
                                    fontWeight = FontWeight.Bold,
                                    color = Color.White,
                                    fontSize = 13.sp
                                )
                                Text(
                                    "Endpoint: ${supabaseManager.getMaskedUrl()}",
                                    color = Color(0xFFCBD5E1),
                                    fontSize = 11.sp
                                )
                                Text(
                                    "Device: ${supabaseManager.deviceName}",
                                    color = Color(0xFF94A3B8),
                                    fontSize = 11.sp
                                )
                                Spacer(modifier = Modifier.height(4.dp))

                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedButton(
                                        onClick = {
                                            coroutineScope.launch {
                                                isTestingConnection = true
                                                val res = supabaseManager.testConnection()
                                                isTestingConnection = false
                                                if (res.isSuccess) {
                                                    Toast.makeText(context, "✅ Supabase connection verified!", Toast.LENGTH_SHORT).show()
                                                } else {
                                                    Toast.makeText(context, "❌ Connection error: ${res.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
                                                }
                                            }
                                        },
                                        enabled = !isTestingConnection,
                                        modifier = Modifier.weight(1f),
                                        shape = RoundedCornerShape(8.dp)
                                    ) {
                                        Text(if (isTestingConnection) "Testing..." else "Test Link", fontSize = 10.sp, color = Color.White)
                                    }

                                    OutlinedButton(
                                        onClick = {
                                            supabaseManager.clearCredentials()
                                            Toast.makeText(context, "Pairing removed.", Toast.LENGTH_SHORT).show()
                                        },
                                        colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFFCA5A5)),
                                        modifier = Modifier.weight(1f),
                                        shape = RoundedCornerShape(8.dp)
                                    ) {
                                        Text("Unpair", fontSize = 10.sp, fontWeight = FontWeight.Bold)
                                    }
                                }

                                if (offlineCount > 0) {
                                    OutlinedButton(
                                        onClick = {
                                            coroutineScope.launch {
                                                val count = supabaseManager.clearOfflineQueue()
                                                offlineCount = supabaseManager.getOfflineCount()
                                                Toast.makeText(context, "Purged $count cached pings", Toast.LENGTH_SHORT).show()
                                            }
                                        },
                                        modifier = Modifier.fillMaxWidth(),
                                        shape = RoundedCornerShape(8.dp)
                                    ) {
                                        Text("Clear Offline Queue ($offlineCount)", fontSize = 10.sp, color = Color(0xFFFBBF24))
                                    }
                                }
                            }
                        }
                    }

                    // 1-Tap Pairing Token Section
                    Card(
                        colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)),
                        shape = RoundedCornerShape(10.dp)
                    ) {
                        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                if (supabaseManager.isConfigured) "⚡ Re-Pair / Switch Account" else "⚡ 1-Tap Pairing Token",
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold,
                                color = Color(0xFF38BDF8)
                            )
                            Text(
                                "Paste the pairing token generated by your web dashboard (No raw URLs, keys, or UUIDs needed):",
                                fontSize = 11.sp,
                                color = Color(0xFF94A3B8)
                            )
                            OutlinedTextField(
                                value = tokenInput,
                                onValueChange = { tokenInput = it },
                                placeholder = { Text("Paste apex_pair_v1_... token", fontSize = 12.sp) },
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = true
                            )
                            Button(
                                onClick = {
                                    if (tokenInput.isNotBlank()) {
                                        val success = supabaseManager.importPairingToken(tokenInput)
                                        if (success) {
                                            showConfigModal = false
                                            Toast.makeText(context, "✅ Paired successfully! Keys encrypted in Keystore.", Toast.LENGTH_SHORT).show()
                                            coroutineScope.launch {
                                                val check = supabaseManager.testConnection()
                                                if (check.isSuccess) {
                                                    supabaseManager.flushOfflineQueue()
                                                    offlineCount = supabaseManager.getOfflineCount()
                                                }
                                            }
                                        } else {
                                            Toast.makeText(context, "❌ Invalid pairing token.", Toast.LENGTH_SHORT).show()
                                        }
                                    }
                                },
                                modifier = Modifier.fillMaxWidth(),
                                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF0284C7)),
                                shape = RoundedCornerShape(8.dp)
                            ) {
                                Text("Import & Connect", fontWeight = FontWeight.Bold, fontSize = 12.sp)
                            }
                        }
                    }

                    Text(
                        "🛡️ Credentials are authenticated via single-token exchange and saved into hardware-backed Android Keystore (AES-256 GCM).",
                        fontSize = 10.sp,
                        color = Color(0xFF64748B)
                    )
                }
            },
            confirmButton = {
                if (supabaseManager.isConfigured) {
                    Button(onClick = { showConfigModal = false }) {
                        Text("Done")
                    }
                }
            },
            dismissButton = {
                if (!supabaseManager.isConfigured) {
                    TextButton(onClick = { showConfigModal = false }) {
                        Text("Cancel")
                    }
                }
            }
        )
    }

    // Post-Journey Completed Dialog & Dual Submission Workflow
    liveState.completedJourney?.let { summary ->
        AlertDialog(
            onDismissRequest = {
                isEditingExpense = false
                onClearCompletedJourney()
            },
            title = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("🏁 Journey Completed", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = Color.White)
                }
            },
            text = {
                Column(
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.verticalScroll(rememberScrollState())
                ) {
                    Card(
                        colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("Travel Time:", color = Color(0xFF94A3B8), fontSize = 12.sp)
                                val m = summary.durationSeconds / 60
                                val s = summary.durationSeconds % 60
                                Text("${m}m ${s}s", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                            }
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("Average Speed:", color = Color(0xFF94A3B8), fontSize = 12.sp)
                                Text(String.format(Locale.US, "%.1f km/h", summary.avgSpeedKmh), color = Color(0xFF38BDF8), fontWeight = FontWeight.Bold, fontSize = 12.sp)
                            }
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("Distance:", color = Color(0xFF94A3B8), fontSize = 12.sp)
                                Text(String.format(Locale.US, "%.2f km", summary.distanceKm), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                            }
                            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("Calculated Cost:", color = Color(0xFF94A3B8), fontSize = 12.sp)
                                Text(String.format(Locale.US, "$%.2f", summary.estimatedCost), color = Color(0xFF10B981), fontWeight = FontWeight.ExtraBold, fontSize = 14.sp)
                            }
                            if (summary.startLat != 0.0) {
                                Text("🟢 Origin: ${String.format(Locale.US, "%.4f, %.4f", summary.startLat, summary.startLng)}", color = Color(0xFF64748B), fontSize = 10.sp)
                            }
                            if (summary.endLat != 0.0) {
                                Text("🏁 Destination: ${String.format(Locale.US, "%.4f, %.4f", summary.endLat, summary.endLng)}", color = Color(0xFF64748B), fontSize = 10.sp)
                            }
                        }
                    }

                    if (!isEditingExpense) {
                        Text(
                            text = "Record this commute expenditure directly into your ledger balance sheet:",
                            fontSize = 12.sp,
                            color = Color(0xFF94A3B8)
                        )

                        // Mode A: Straight Away Submit (1-Click)
                        Button(
                            onClick = {
                                coroutineScope.launch {
                                    isSubmittingExpense = true
                                    val desc = "Commute: ${String.format(Locale.US, "%.1f", summary.distanceKm)}km (${summary.durationSeconds / 60}m, avg ${String.format(Locale.US, "%.1f", summary.avgSpeedKmh)} km/h)"
                                    val res = supabaseManager.submitJourneyExpense(
                                        journeyId = summary.journeyId,
                                        amount = summary.estimatedCost.toDouble(),
                                        description = desc
                                    )
                                    isSubmittingExpense = false
                                    if (res.isSuccess) {
                                        Toast.makeText(context, "✅ $${String.format(Locale.US, "%.2f", summary.estimatedCost)} recorded to ledger!", Toast.LENGTH_SHORT).show()
                                        onClearCompletedJourney()
                                    } else {
                                        Toast.makeText(context, "❌ Submission failed: ${res.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
                                    }
                                }
                            },
                            enabled = !isSubmittingExpense,
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF10B981)),
                            shape = RoundedCornerShape(10.dp)
                        ) {
                            Text(
                                text = if (isSubmittingExpense) "Submitting..." else "⚡ Straight Away Submit ($${String.format(Locale.US, "%.2f", summary.estimatedCost)})",
                                fontWeight = FontWeight.Bold,
                                color = Color.Black
                            )
                        }

                        // Mode B: Trigger Edit and Submit
                        OutlinedButton(
                            onClick = {
                                editedAmount = String.format(Locale.US, "%.2f", summary.estimatedCost)
                                isEditingExpense = true
                            },
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(10.dp)
                        ) {
                            Text("✏️ Edit & Submit", color = Color.White)
                        }
                    } else {
                        // Editable Form
                        Text("Customize & record commute expense:", fontSize = 12.sp, color = Color(0xFF94A3B8))

                        OutlinedTextField(
                            value = editedAmount,
                            onValueChange = { editedAmount = it },
                            label = { Text("Expense Amount ($)") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Color(0xFF10B981),
                                unfocusedBorderColor = Color(0xFF334155),
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White
                            )
                        )

                        OutlinedTextField(
                            value = editedNotes,
                            onValueChange = { editedNotes = it },
                            label = { Text("Notes / Purpose (Optional)") },
                            modifier = Modifier.fillMaxWidth(),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Color(0xFF10B981),
                                unfocusedBorderColor = Color(0xFF334155),
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White
                            )
                        )

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text("💼 Business Commute", color = Color.White, fontSize = 13.sp)
                            Switch(
                                checked = isBusinessTrip,
                                onCheckedChange = { isBusinessTrip = it }
                            )
                        }

                        Button(
                            onClick = {
                                val amt = editedAmount.toDoubleOrNull() ?: summary.estimatedCost.toDouble()
                                coroutineScope.launch {
                                    isSubmittingExpense = true
                                    val desc = "Commute: ${String.format(Locale.US, "%.1f", summary.distanceKm)}km (${summary.durationSeconds / 60}m) ${if (editedNotes.isNotBlank()) "- $editedNotes" else ""}"
                                    val res = supabaseManager.submitJourneyExpense(
                                        journeyId = summary.journeyId,
                                        amount = amt,
                                        description = desc,
                                        isBusiness = isBusinessTrip
                                    )
                                    isSubmittingExpense = false
                                    if (res.isSuccess) {
                                        Toast.makeText(context, "✅ $${String.format(Locale.US, "%.2f", amt)} logged to ledger!", Toast.LENGTH_SHORT).show()
                                        isEditingExpense = false
                                        onClearCompletedJourney()
                                    } else {
                                        Toast.makeText(context, "❌ Failed: ${res.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
                                    }
                                }
                            },
                            enabled = !isSubmittingExpense,
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF10B981)),
                            shape = RoundedCornerShape(10.dp)
                        ) {
                            Text(
                                text = if (isSubmittingExpense) "Recording..." else "Deduct & Record to Ledger",
                                fontWeight = FontWeight.Bold,
                                color = Color.Black
                            )
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = {
                    isEditingExpense = false
                    onClearCompletedJourney()
                }) {
                    Text("Dismiss", color = Color(0xFF94A3B8))
                }
            }
        )
    }
}
