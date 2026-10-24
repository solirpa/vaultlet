package com.vaultlet.android.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.crypto.Cipher
import kotlin.coroutines.resume

private const val CLEAR_CLIPBOARD_MS = 30_000L

/**
 * Copy to the clipboard. Secrets are flagged sensitive (hidden from clipboard previews on
 * Android 13+) and cleared after 30 s if they are still there.
 */
fun Context.copyToClipboard(label: String, text: String, secret: Boolean) {
    val cm = getSystemService(ClipboardManager::class.java) ?: return
    val clip = ClipData.newPlainText(label, text)
    if (secret) {
        clip.description.extras = PersistableBundle().apply {
            val key = if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE"
            putBoolean(key, true)
        }
    }
    cm.setPrimaryClip(clip)
    if (secret) {
        Handler(Looper.getMainLooper()).postDelayed({
            val current = runCatching { cm.primaryClip?.getItemAt(0)?.text?.toString() }.getOrNull()
            if (current == text) {
                if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip() else cm.setPrimaryClip(ClipData.newPlainText("", ""))
            }
        }, CLEAR_CLIPBOARD_MS)
    }
}

fun Context.canUseBiometric(): Boolean =
    BiometricManager.from(this).canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS

/** Show the system fingerprint prompt for `cipher`; the authenticated cipher, or null if cancelled. */
suspend fun FragmentActivity.authenticate(cipher: Cipher, title: String, negative: String): Cipher? =
    suspendCancellableCoroutine { cont ->
        val prompt = BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (cont.isActive) cont.resume(result.cryptoObject?.cipher)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (cont.isActive) cont.resume(null)
                }
            },
        )
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setNegativeButtonText(negative)
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .build()
        prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
        cont.invokeOnCancellation { prompt.cancelAuthentication() }
    }
