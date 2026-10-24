package com.vaultlet.android

import android.app.Application
import android.content.Context
import android.os.SystemClock
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.vaultlet.android.data.VaultStore

class VaultletApp : Application() {
    lateinit var store: VaultStore
        private set

    override fun onCreate() {
        super.onCreate()
        store = VaultStore(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(AutoLock(store))
    }
}

val Context.store: VaultStore get() = (applicationContext as VaultletApp).store

/** Lock once the app has been in the background for the configured time. */
private class AutoLock(private val store: VaultStore) : DefaultLifecycleObserver {
    private var backgroundSince = 0L

    override fun onStop(owner: LifecycleOwner) {
        backgroundSince = SystemClock.elapsedRealtime()
    }

    override fun onStart(owner: LifecycleOwner) {
        if (backgroundSince == 0L) return
        val away = SystemClock.elapsedRealtime() - backgroundSince
        if (away >= store.prefs.autoLockMinutes * 60_000L) store.lock()
    }
}
