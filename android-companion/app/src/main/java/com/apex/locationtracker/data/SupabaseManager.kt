package com.apex.locationtracker.data

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.util.Base64
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.google.gson.Gson
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

class SupabaseManager private constructor(context: Context) {
    private val appContext = context.applicationContext

    // Hardware-backed AES-256 encrypted storage with resilient standard fallback
    private val prefs: SharedPreferences = try {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            appContext,
            "apex_tracker_encrypted_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: Exception) {
        Log.w(TAG, "EncryptedSharedPreferences unavailable, falling back to standard: ${e.message}")
        appContext.getSharedPreferences("apex_tracker_prefs", Context.MODE_PRIVATE)
    }

    // Standard unencrypted fallback preferences handle (to check for legacy paired tokens)
    private val standardPrefs: SharedPreferences = appContext.getSharedPreferences("apex_tracker_prefs", Context.MODE_PRIVATE)

    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private val database = AppDatabase.getInstance(appContext)
    private val dao = database.locationDao()

    // In-memory cached credential state for instant inter-component synchronization
    @Volatile private var cachedUrl: String = ""
    @Volatile private var cachedAnonKey: String = ""
    @Volatile private var cachedUserId: String = ""
    @Volatile private var cachedDeviceId: String = ""
    @Volatile private var cachedDeviceName: String = ""

    init {
        loadCredentials()
    }

    private fun loadCredentials() {
        // Read from encrypted prefs first, falling back to standard prefs if empty
        var url = prefs.getString(KEY_URL, "") ?: ""
        var key = prefs.getString(KEY_ANON_KEY, "") ?: ""
        var uid = prefs.getString(KEY_USER_ID, "") ?: ""

        if (url.isBlank() && standardPrefs.contains(KEY_URL)) {
            url = standardPrefs.getString(KEY_URL, "") ?: ""
            key = standardPrefs.getString(KEY_ANON_KEY, "") ?: ""
            uid = standardPrefs.getString(KEY_USER_ID, "") ?: ""
        }

        cachedUrl = url
        cachedAnonKey = key
        cachedUserId = uid

        var devId = prefs.getString(KEY_DEVICE_ID, null)
            ?: standardPrefs.getString(KEY_DEVICE_ID, null)
        if (devId.isNullOrBlank()) {
            devId = "phone-apk-${UUID.randomUUID().toString().take(8)}"
            prefs.edit().putString(KEY_DEVICE_ID, devId).apply()
        }
        cachedDeviceId = devId

        var devName = prefs.getString(KEY_DEVICE_NAME, null)
            ?: standardPrefs.getString(KEY_DEVICE_NAME, null)
        if (devName.isNullOrBlank()) {
            val manufacturer = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
            val model = Build.MODEL
            devName = "$manufacturer $model (Apex APK)"
            prefs.edit().putString(KEY_DEVICE_NAME, devName).apply()
        }
        cachedDeviceName = devName
    }

    companion object {
        private const val TAG = "SupabaseManager"
        private const val KEY_URL = "supabase_url"
        private const val KEY_ANON_KEY = "supabase_anon_key"
        private const val KEY_USER_ID = "supabase_user_id"
        private const val KEY_DEVICE_ID = "apex_device_id"
        private const val KEY_DEVICE_NAME = "apex_device_name"
        const val TOKEN_PREFIX = "apex_pair_v1_"

        @Volatile
        private var INSTANCE: SupabaseManager? = null

        fun getInstance(context: Context): SupabaseManager {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: SupabaseManager(context.applicationContext).also { INSTANCE = it }
            }
        }
    }

    var supabaseUrl: String
        get() = cachedUrl
        set(value) {
            val sanitized = value.trim().removeSuffix("/")
            cachedUrl = sanitized
            prefs.edit().putString(KEY_URL, sanitized).apply()
            standardPrefs.edit().putString(KEY_URL, sanitized).apply()
        }

    var anonKey: String
        get() = cachedAnonKey
        set(value) {
            val sanitized = value.trim()
            cachedAnonKey = sanitized
            prefs.edit().putString(KEY_ANON_KEY, sanitized).apply()
            standardPrefs.edit().putString(KEY_ANON_KEY, sanitized).apply()
        }

    var userId: String
        get() = cachedUserId
        set(value) {
            val sanitized = value.trim()
            cachedUserId = sanitized
            prefs.edit().putString(KEY_USER_ID, sanitized).apply()
            standardPrefs.edit().putString(KEY_USER_ID, sanitized).apply()
        }

    val isConfigured: Boolean
        get() = supabaseUrl.isNotBlank() && anonKey.isNotBlank() && userId.isNotBlank()

    val deviceId: String
        get() = cachedDeviceId

    val deviceName: String
        get() = cachedDeviceName

    /**
     * Imports an opaque single-string pairing token (e.g. apex_pair_v1_...)
     * Eliminates the need to ever view or type raw URLs and API keys on mobile.
     */
    fun importPairingToken(token: String): Boolean {
        try {
            val trimmed = token.trim()
            val base64Payload = if (trimmed.startsWith(TOKEN_PREFIX)) {
                trimmed.removePrefix(TOKEN_PREFIX)
            } else {
                trimmed
            }
            val decodedBytes = Base64.decode(
                base64Payload,
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.DEFAULT
            )
            val jsonString = String(decodedBytes, Charsets.UTF_8)
            val jsonObj = JsonParser.parseString(jsonString).asJsonObject

            val url = jsonObj.get("u")?.asString ?: return false
            val key = jsonObj.get("k")?.asString ?: return false
            val uid = jsonObj.get("uid")?.asString ?: return false

            if (url.isNotBlank() && key.isNotBlank() && uid.isNotBlank()) {
                supabaseUrl = url
                anonKey = key
                userId = uid
                Log.i(TAG, "Pairing token imported successfully. Configured user: ${getMaskedUserId()}")
                return true
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to decode pairing token: ${e.message}")
        }
        return false
    }

    /**
     * Clears stored Supabase credentials
     */
    fun clearCredentials() {
        cachedUrl = ""
        cachedAnonKey = ""
        cachedUserId = ""
        prefs.edit()
            .remove(KEY_URL)
            .remove(KEY_ANON_KEY)
            .remove(KEY_USER_ID)
            .apply()
        standardPrefs.edit()
            .remove(KEY_URL)
            .remove(KEY_ANON_KEY)
            .remove(KEY_USER_ID)
            .apply()
    }

    /**
     * Safely returns masked project URL for UI rendering
     */
    fun getMaskedUrl(): String {
        val url = supabaseUrl
        if (url.isBlank()) return "Not Configured"
        return try {
            val uri = Uri.parse(url)
            val host = uri.host ?: url
            val parts = host.split(".")
            if (parts.size >= 3) {
                val prefix = parts[0].take(4)
                "${uri.scheme}://${prefix}••••.${parts.drop(1).joinToString(".")}"
            } else {
                "${uri.scheme}://••••••••"
            }
        } catch (e: Exception) {
            "https://••••••••.supabase.co"
        }
    }

    /**
     * Safely returns masked anon key for UI rendering
     */
    fun getMaskedKey(): String {
        val key = anonKey
        if (key.isBlank()) return "Not Configured"
        if (key.length <= 12) return "••••••••••••"
        return "${key.take(6)}••••••••••••••••••••${key.takeLast(4)}"
    }

    /**
     * Safely returns masked user ID for UI rendering
     */
    fun getMaskedUserId(): String {
        val id = userId
        if (id.isBlank()) return "Not Configured"
        if (id.length <= 8) return "••••••••"
        return "${id.take(4)}••••-••••-••••-••••••••${id.takeLast(4)}"
    }

    /**
     * Performs a lightweight HTTP connection check against Supabase
     */
    suspend fun testConnection(): Result<Boolean> = withContext(Dispatchers.IO) {
        if (!isConfigured) return@withContext Result.failure(IllegalStateException("Supabase not configured"))
        val endpoint = "$supabaseUrl/rest/v1/device_location_pings?select=id&limit=1"
        val request = Request.Builder()
            .url(endpoint)
            .addHeader("apikey", anonKey)
            .addHeader("Authorization", "Bearer $anonKey")
            .get()
            .build()

        try {
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    Result.success(true)
                } else {
                    val code = response.code
                    val msg = response.body?.string() ?: response.message
                    Result.failure(IOException("HTTP $code: $msg"))
                }
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Sends a single ping to Supabase.
     * If network fails or server is temporarily unavailable, queues into Room database.
     * Unconfigured or permanent client format errors (4xx) are NOT cached as poison pills.
     */
    suspend fun dispatchPing(ping: LocationPingEntity): Result<Int> = withContext(Dispatchers.IO) {
        if (!isConfigured) {
            Log.w(TAG, "Supabase not configured. Refusing to queue unconfigured ping.")
            return@withContext Result.failure(IllegalStateException("Not Configured: Pair companion app first"))
        }

        // Guarantee user_id is populated from active credentials
        val effectivePing = if (ping.userId.isBlank()) {
            ping.copy(userId = userId)
        } else {
            ping
        }

        val jsonPayload = gson.toJson(effectivePing)
        val endpoint = "$supabaseUrl/rest/v1/device_location_pings"
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val body = jsonPayload.toRequestBody(mediaType)

        val request = Request.Builder()
            .url(endpoint)
            .addHeader("apikey", anonKey)
            .addHeader("Authorization", "Bearer $anonKey")
            .addHeader("Content-Type", "application/json")
            .addHeader("Prefer", "return=minimal, resolution=ignore-duplicates")
            .post(body)
            .build()

        try {
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    Log.d(TAG, "Ping transmitted successfully. HTTP ${response.code}")
                    // Drain any pending offline pings on successful connection
                    flushOfflineQueue()
                    return@withContext Result.success(response.code)
                } else {
                    val code = response.code
                    val err = response.body?.string() ?: "Empty body"
                    Log.w(TAG, "Supabase rejected ping: HTTP $code - $err")

                    // Only cache in Room if server-side transient failure (5xx or 429 rate limit)
                    // Do NOT poison Room database with 4xx client authentication or schema errors
                    if (code >= 500 || code == 429) {
                        dao.insertPing(effectivePing)
                        Log.i(TAG, "Cached ping locally due to server error HTTP $code")
                    }

                    return@withContext Result.failure(IOException("HTTP $code: $err"))
                }
            }
        } catch (e: Exception) {
            // Genuine network failure (airplane mode, tunnel, offline) -> cache locally in Room
            Log.w(TAG, "Network failure sending ping (${e.message}). Caching locally to Room.")
            dao.insertPing(effectivePing)
            return@withContext Result.failure(e)
        }
    }

    /**
     * Flushes offline cached pings in batches of up to 50.
     * Automatically sanitizes blank user IDs, ignores duplicates, and purges poison pills.
     */
    suspend fun flushOfflineQueue(): Result<Int> = withContext(Dispatchers.IO) {
        if (!isConfigured) return@withContext Result.failure(IllegalStateException("Supabase not configured"))

        val pending = dao.getPendingPings(limit = 50)
        if (pending.isEmpty()) return@withContext Result.success(0)

        // Sanitize: ensure valid userId and valid coordinates
        val validPings = pending.map { ping ->
            if (ping.userId.isBlank()) ping.copy(userId = userId) else ping
        }.filter { it.latitude != 0.0 || it.longitude != 0.0 }

        if (validPings.isEmpty()) {
            Log.w(TAG, "Purging ${pending.size} empty or zero-coordinate cached pings.")
            dao.deletePings(pending)
            return@withContext Result.success(0)
        }

        Log.i(TAG, "Attempting to flush ${validPings.size} cached pings to Supabase...")
        val jsonPayload = gson.toJson(validPings)
        val endpoint = "$supabaseUrl/rest/v1/device_location_pings"
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val body = jsonPayload.toRequestBody(mediaType)

        val request = Request.Builder()
            .url(endpoint)
            .addHeader("apikey", anonKey)
            .addHeader("Authorization", "Bearer $anonKey")
            .addHeader("Content-Type", "application/json")
            .addHeader("Prefer", "return=minimal, resolution=ignore-duplicates")
            .post(body)
            .build()

        try {
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    dao.deletePings(pending)
                    Log.i(TAG, "Successfully flushed ${validPings.size} offline pings.")

                    // If more pings remain, continue draining recursively
                    val remaining = dao.getPendingCount()
                    if (remaining > 0) {
                        flushOfflineQueue()
                    }
                    return@withContext Result.success(validPings.size)
                } else {
                    val code = response.code
                    val err = response.body?.string() ?: ""
                    Log.w(TAG, "Failed to flush offline queue: HTTP $code - $err")

                    // If permanent client error (e.g. 400 Bad Request), purge the poison pills
                    if (code in 400..499 && code != 429) {
                        Log.e(TAG, "Purging ${pending.size} cached pings rejected by Supabase with HTTP $code.")
                        dao.deletePings(pending)
                    }
                    return@withContext Result.failure(IOException("HTTP $code: $err"))
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to flush offline queue (offline): ${e.message}")
            return@withContext Result.failure(e)
        }
    }

    suspend fun getOfflineCount(): Int = withContext(Dispatchers.IO) {
        dao.getPendingCount()
    }

    suspend fun clearOfflineQueue(): Int = withContext(Dispatchers.IO) {
        val count = dao.getPendingCount()
        dao.clearAllPings()
        Log.i(TAG, "Cleared $count offline cached pings.")
        count
    }
}
