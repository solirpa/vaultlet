package com.vaultlet.android.data

import android.content.Context
import android.net.Uri
import androidx.core.content.edit
import uniffi.vault_ffi.WebDavConfig

/** Where the vault comes from. */
sealed interface VaultSource {
    data class WebDav(val config: WebDavConfig) : VaultSource

    /** A `.kdbx` picked with the system document picker (Storage Access Framework). */
    data class File(val uri: Uri, val name: String) : VaultSource

    /** Short label for the unlock screen. */
    val label: String
        get() = when (this) {
            is WebDav -> config.remotePath.substringAfterLast('/')
            is File -> name
        }
}

/** Where the vault lives and what the app remembers about it. Secrets are sealed by [SecretBox]. */
class Prefs(context: Context) {
    private val p = context.getSharedPreferences("vaultlet", Context.MODE_PRIVATE)

    val source: VaultSource?
        get() = file ?: webdav?.let { VaultSource.WebDav(it) }

    var webdav: WebDavConfig?
        get() {
            val url = p.getString("webdav_url", null) ?: return null
            val sealed = p.getString("webdav_password", null) ?: return null
            return WebDavConfig(
                url = url,
                username = p.getString("webdav_user", "") ?: "",
                password = runCatching { SecretBox.open(sealed) }.getOrDefault(""),
                remotePath = p.getString("webdav_path", "") ?: "",
            )
        }
        set(value) = p.edit {
            if (value == null) {
                remove("webdav_url"); remove("webdav_user"); remove("webdav_password"); remove("webdav_path")
            } else {
                putString("webdav_url", value.url)
                putString("webdav_user", value.username)
                putString("webdav_password", SecretBox.seal(value.password))
                putString("webdav_path", value.remotePath)
            }
        }

    var file: VaultSource.File?
        get() {
            val uri = p.getString("file_uri", null) ?: return null
            return VaultSource.File(Uri.parse(uri), p.getString("file_name", "") ?: "")
        }
        set(value) = p.edit {
            if (value == null) {
                remove("file_uri"); remove("file_name")
            } else {
                putString("file_uri", value.uri.toString())
                putString("file_name", value.name)
            }
        }

    /** ETag of the remote copy the local cache corresponds to (WebDAV only). */
    var etag: String?
        get() = p.getString("etag", null)
        set(value) = p.edit { putString("etag", value) }

    /** Local changes not in the file / on the server yet. */
    var pendingUpload: Boolean
        get() = p.getBoolean("pending_upload", false)
        set(value) = p.edit { putBoolean("pending_upload", value) }

    /** Master password sealed with the biometric key; null = fingerprint unlock is off. */
    var biometricBlob: String?
        get() = p.getString("biometric", null)
        set(value) = p.edit { if (value == null) remove("biometric") else putString("biometric", value) }

    /** Lock after this many minutes in the background. */
    var autoLockMinutes: Int
        get() = p.getInt("auto_lock_minutes", 5)
        set(value) = p.edit { putInt("auto_lock_minutes", value) }

    fun clear() = p.edit { clear() }
}
