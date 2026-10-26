package com.vaultlet.android.data

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import uniffi.vault_ffi.ItemInput
import uniffi.vault_ffi.Vault
import uniffi.vault_ffi.VaultException
import uniffi.vault_ffi.WebDavConfig
import uniffi.vault_ffi.openVault
import uniffi.vault_ffi.webdavFetch
import java.io.File

/**
 * The open vault and everything around it, shared by the UI and the autofill service.
 *
 * The encrypted vault is cached in app storage, so unlocking works offline; every change is
 * written to the cache first and then synced to WebDAV in the background. Sync state (ETag,
 * unsent changes) survives restarts through [Prefs].
 */
class VaultStore(context: Context) {
    sealed interface State {
        data object NotConfigured : State
        data object Locked : State
        data class Unlocked(val vault: Vault) : State
    }

    sealed interface SyncStatus {
        data object Idle : SyncStatus
        data object Syncing : SyncStatus
        data class Failed(val message: String) : SyncStatus
    }

    val prefs = Prefs(context)
    private val cache = File(context.filesDir, "vault.kdbx")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val syncLock = Mutex()

    private val _state = MutableStateFlow<State>(if (prefs.webdav == null) State.NotConfigured else State.Locked)
    val state: StateFlow<State> = _state.asStateFlow()

    private val _sync = MutableStateFlow<SyncStatus>(SyncStatus.Idle)
    val sync: StateFlow<SyncStatus> = _sync.asStateFlow()

    /** Bumped whenever the items may have changed (edit, sync, unlock). */
    private val _revision = MutableStateFlow(0)
    val revision: StateFlow<Int> = _revision.asStateFlow()

    val vault: Vault? get() = (state.value as? State.Unlocked)?.vault

    /** First run: download the vault from WebDAV and open it with the master password. */
    suspend fun setUp(config: WebDavConfig, masterPassword: String) = withContext(Dispatchers.IO) {
        val download = webdavFetch(config)
        val vault = openVault(download.bytes, masterPassword)
        writeCache(download.bytes)
        prefs.webdav = config
        prefs.etag = download.etag
        prefs.pendingUpload = false
        vault.setSyncState(download.etag, false)
        opened(vault)
    }

    /** Unlock from the local cache (offline), or download it first if there is none yet. */
    suspend fun unlock(masterPassword: String) = withContext(Dispatchers.IO) {
        val config = prefs.webdav ?: throw IllegalStateException("not configured")
        val bytes = if (cache.exists()) cache.readBytes() else webdavFetch(config).also { prefs.etag = it.etag }.bytes
        val vault = openVault(bytes, masterPassword)
        if (!cache.exists()) writeCache(bytes)
        vault.setSyncState(prefs.etag, prefs.pendingUpload)
        opened(vault)
        syncInBackground()
    }

    private fun opened(vault: Vault) {
        _state.value = State.Unlocked(vault)
        _revision.value++
    }

    fun lock() {
        val v = vault ?: return
        _state.value = State.Locked
        v.destroy() // drops the decrypted vault in Rust right away
    }

    /** Forget the vault on this phone (the server copy is untouched). */
    fun signOut() {
        lock()
        cache.delete()
        prefs.clear()
        SecretBox.deleteBiometricKey()
        _state.value = State.NotConfigured
    }

    suspend fun saveItem(input: ItemInput): String = change { it.saveItem(input) }

    suspend fun trashItem(id: String) = change { it.trashItem(id) }

    private suspend fun <T> change(f: (Vault) -> T): T = withContext(Dispatchers.IO) {
        val v = vault ?: throw IllegalStateException("locked")
        val out = f(v)
        prefs.pendingUpload = true
        writeCache(v.serialize())
        _revision.value++
        syncInBackground()
        out
    }

    fun syncInBackground() {
        scope.launch { runCatching { syncNow() } }
    }

    /** Pull and push; never holds the vault while waiting on the network. */
    suspend fun syncNow() = withContext(Dispatchers.IO) {
        syncLock.withLock {
            val v = vault ?: return@withLock
            val config = prefs.webdav ?: return@withLock
            _sync.value = SyncStatus.Syncing
            try {
                val r = v.syncWebdav(config)
                if (vault !== v) return@withLock // locked meanwhile
                writeCache(r.vaultBytes)
                prefs.etag = r.etag
                prefs.pendingUpload = r.pendingUpload
                if (r.changedLocally) _revision.value++
                _sync.value = SyncStatus.Idle
            } catch (e: VaultException) {
                prefs.pendingUpload = v.pendingUpload()
                _sync.value = SyncStatus.Failed(e.message ?: "sync failed")
            }
        }
    }

    private fun writeCache(bytes: ByteArray) {
        val tmp = File(cache.parentFile, "vault.kdbx.tmp")
        tmp.writeBytes(bytes)
        if (!tmp.renameTo(cache)) {
            cache.delete()
            tmp.renameTo(cache)
        }
    }
}

/** Short user-facing text for errors from the Rust core. */
fun Throwable.vaultMessage(): String = when (this) {
    is VaultException.Failed -> when (code) {
        "invalid-key" -> "Wrong master password"
        "webdav-auth" -> "The WebDAV server rejected the username or app password"
        else -> detail
    }
    else -> message ?: toString()
}
