package com.vaultlet.android.data

import android.content.Context
import android.net.Uri
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
 * written to the cache first and then synced in the background to where the vault came from
 * ([VaultSource]): a WebDAV server, or a `.kdbx` picked through the document picker. Sync state
 * (ETag, unsent changes) survives restarts through [Prefs].
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
    private val resolver = context.applicationContext.contentResolver
    private val cache = File(context.filesDir, "vault.kdbx")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val syncLock = Mutex()

    private val _state = MutableStateFlow<State>(if (prefs.source == null) State.NotConfigured else State.Locked)
    val state: StateFlow<State> = _state.asStateFlow()

    private val _sync = MutableStateFlow<SyncStatus>(SyncStatus.Idle)
    val sync: StateFlow<SyncStatus> = _sync.asStateFlow()

    /** Bumped whenever the items may have changed (edit, sync, unlock). */
    private val _revision = MutableStateFlow(0)
    val revision: StateFlow<Int> = _revision.asStateFlow()

    val vault: Vault? get() = (state.value as? State.Unlocked)?.vault

    /** First run, WebDAV: download the vault and open it with the master password. */
    suspend fun setUp(config: WebDavConfig, masterPassword: String) = withContext(Dispatchers.IO) {
        val download = webdavFetch(config)
        val vault = openVault(download.bytes, masterPassword)
        writeCache(download.bytes)
        prefs.file = null
        prefs.webdav = config
        prefs.etag = download.etag
        prefs.pendingUpload = false
        vault.setSyncState(download.etag, false)
        opened(vault)
    }

    /**
     * First run, file: open the picked `.kdbx` and keep a persistable grant on it. `uri` comes
     * from `ActivityResultContracts.OpenDocument`, whose grant is persistable.
     */
    suspend fun setUpFile(uri: Uri, masterPassword: String) = withContext(Dispatchers.IO) {
        val bytes = VaultFile.read(resolver, uri)
        val vault = openVault(bytes, masterPassword)
        runCatching { resolver.takePersistableUriPermission(uri, VaultFile.PERMISSIONS) }
        writeCache(bytes)
        prefs.webdav = null
        prefs.file = VaultSource.File(uri, VaultFile.displayName(resolver, uri))
        prefs.etag = null
        prefs.pendingUpload = false
        vault.setSyncState(null, false)
        opened(vault)
    }

    /** Unlock from the local cache (offline), or fetch the vault first if there is none yet. */
    suspend fun unlock(masterPassword: String) = withContext(Dispatchers.IO) {
        val source = prefs.source ?: throw IllegalStateException("not configured")
        val bytes = if (cache.exists()) cache.readBytes() else when (source) {
            is VaultSource.WebDav -> webdavFetch(source.config).also { prefs.etag = it.etag }.bytes
            is VaultSource.File -> VaultFile.read(resolver, source.uri)
        }
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

    /** Forget the vault on this phone (the file / server copy is untouched). */
    fun signOut() {
        lock()
        cache.delete()
        prefs.file?.let { runCatching { resolver.releasePersistableUriPermission(it.uri, VaultFile.PERMISSIONS) } }
        prefs.clear()
        SecretBox.deleteBiometricKey()
        _sync.value = SyncStatus.Idle
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

    /** Pull and push; never holds the vault while waiting on the network or the provider. */
    suspend fun syncNow() = withContext(Dispatchers.IO) {
        syncLock.withLock {
            val v = vault ?: return@withLock
            val source = prefs.source ?: return@withLock
            _sync.value = SyncStatus.Syncing
            try {
                when (source) {
                    is VaultSource.WebDav -> {
                        val r = v.syncWebdav(source.config)
                        if (vault !== v) return@withLock // locked meanwhile
                        writeCache(r.vaultBytes)
                        prefs.etag = r.etag
                        prefs.pendingUpload = r.pendingUpload
                        if (r.changedLocally) _revision.value++
                    }
                    is VaultSource.File -> {
                        val r = VaultFile.sync(resolver, source.uri, v)
                        if (vault !== v) return@withLock
                        r.cacheBytes?.let { writeCache(it) }
                        prefs.pendingUpload = v.pendingUpload()
                        if (r.changedLocally) _revision.value++
                    }
                }
                _sync.value = SyncStatus.Idle
            } catch (e: Exception) {
                if (vault === v) prefs.pendingUpload = v.pendingUpload()
                _sync.value = SyncStatus.Failed(e.vaultMessage())
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

/** Short user-facing text for errors from the Rust core and the file provider. */
fun Throwable.vaultMessage(): String = when (this) {
    is VaultException.Failed -> when (code) {
        "invalid-key" -> "Wrong master password"
        "webdav-auth" -> "The WebDAV server rejected the username or app password"
        "not-found" -> "The vault file was not found"
        else -> detail
    }
    is VaultFile.Gone -> message ?: "The vault file is no longer accessible"
    else -> message ?: toString()
}
