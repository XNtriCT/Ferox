package com.ferox.browser

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Keeps the process alive (and audio playing) while Ferox is in the background.
 *
 * Chromium WebView pauses nothing on its own when the app is not visible, but
 * without a foreground service Android is free to freeze or kill the process,
 * which is why background playback stopped. This service is started while any
 * WebView reports active playback and stopped when playback pauses.
 */
class PlaybackService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private var isPlaying = true

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
        try {
            val powerManager = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "Ferox::PlaybackWakeLock"
            ).apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {
            wakeLock = null
        }
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {}
        wakeLock = null
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_TOGGLE -> {
                // Ask the activity to pause/resume the WebView playback.
                toggleCallback?.invoke()
                return START_STICKY
            }
        }
        startForeground(NOTIFICATION_ID, buildNotification())
        return START_STICKY
    }

    /** Refreshes the notification icon/label when playback state changes. */
    fun setPlaying(playing: Boolean) {
        if (isPlaying == playing) return
        isPlaying = playing
        try {
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            manager.notify(NOTIFICATION_ID, buildNotification())
        } catch (_: Exception) {}
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopForegroundCompat()
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val toggleIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, PlaybackService::class.java).setAction(ACTION_TOGGLE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(if (isPlaying) "Ferox is playing audio" else "Ferox playback paused")
            .setContentText("Tap to return to the video")
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setColor(0xFFFB542B.toInt())
            .setPriority(NotificationCompat.PRIORITY_LOW)
        if (isPlaying) {
            builder.addAction(android.R.drawable.ic_media_pause, "Pause", toggleIntent)
        } else {
            builder.addAction(android.R.drawable.ic_media_play, "Play", toggleIntent)
        }
        return builder.build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Playback",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps audio playing in the background"
                setShowBadge(false)
            }
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    companion object {
        const val CHANNEL_ID = "ferox_playback"
        const val NOTIFICATION_ID = 1001
        const val ACTION_STOP = "com.ferox.browser.action.STOP_PLAYBACK"
        const val ACTION_TOGGLE = "com.ferox.browser.action.TOGGLE_PLAYBACK"

        /** Live service instance so the activity can refresh the notification. */
        @Volatile
        var instance: PlaybackService? = null
            private set

        /** Invoked when the notification Pause/Play action is tapped. */
        @Volatile
        var toggleCallback: (() -> Unit)? = null
    }
}
