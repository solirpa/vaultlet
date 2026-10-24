package com.vaultlet.android.data

import android.content.Context
import androidx.core.content.edit
import uniffi.vault_ffi.WebDavConfig

/** Where the vault lives and what the app remembers about it. Secrets are sealed by [SecretBox]. */
class Prefs(context: Context) {
    private val p = context.getSharedPreferences("vaultlet", Context.MODE_PRIVATE)

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

    /** ETag of the remote copy the local cache corresponds to. */
    var etag: String?
        get() = p.getString("etag", null)
        set(value) = p.edit { putString("etag", value) }

    /** Local changes not on the server yet. */
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
