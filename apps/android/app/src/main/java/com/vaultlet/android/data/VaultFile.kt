package com.vaultlet.android.data

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import uniffi.vault_ffi.Vault
import java.io.FileNotFoundException

/**
 * The vault as a `.kdbx` the user picked with the system document picker: Google Drive, 坚果云,
 * OneDrive, a local folder... anything with a documents provider. Vaultlet keeps a persistable
 * read/write grant on it and merges both ways on every sync, so the file is shared with the
 * desktop app and other KeePass clients through the provider's own sync.
 */
object VaultFile {
    /** Read + merge + (maybe) write-back result. */
    class SyncOutcome(val changedLocally: Boolean, val cacheBytes: ByteArray?)

    /** The document is gone or the grant was revoked; the user has to pick the file again. */
    class Gone(cause: Throwable) : Exception("The vault file is no longer accessible", cause)

    const val PERMISSIONS = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

    fun displayName(resolver: ContentResolver, uri: Uri): String {
        runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (i >= 0) c.getString(i)?.takeIf { it.isNotBlank() }?.let { return it }
                }
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/')?.substringAfterLast(':') ?: "Vault.kdbx"
    }

    fun read(resolver: ContentResolver, uri: Uri): ByteArray = guard {
        resolver.openInputStream(uri)?.use { it.readBytes() } ?: throw FileNotFoundException(uri.toString())
    }

    fun write(resolver: ContentResolver, uri: Uri, bytes: ByteArray) = guard {
        // "wt" truncates; providers that do not support it get the plain "w" mode, which on
        // every stock provider also replaces the content.
        val out = try {
            resolver.openOutputStream(uri, "wt")
        } catch (e: IllegalArgumentException) {
            resolver.openOutputStream(uri, "w")
        } ?: throw FileNotFoundException(uri.toString())
        out.use { it.write(bytes); it.flush() }
    }

    /**
     * Merge the file into the open vault and, when the vault has changes the file lacks, write
     * it back. Mirrors the iOS file mode.
     */
    fun sync(resolver: ContentResolver, uri: Uri, vault: Vault): SyncOutcome {
        val onDisk = read(resolver, uri)
        val merged = vault.mergeFile(onDisk)
        if (merged.pendingUpload) {
            val bytes = vault.serialize()
            // Edits made while the write is in flight set the flag again.
            vault.markUploaded()
            try {
                write(resolver, uri, bytes)
            } catch (e: Exception) {
                vault.setSyncState(null, true)
                throw e
            }
            return SyncOutcome(merged.changedLocally, bytes)
        }
        return SyncOutcome(merged.changedLocally, if (merged.changedLocally) vault.serialize() else null)
    }

    private inline fun <T> guard(f: () -> T): T = try {
        f()
    } catch (e: FileNotFoundException) {
        throw Gone(e)
    } catch (e: SecurityException) {
        throw Gone(e)
    }
}
