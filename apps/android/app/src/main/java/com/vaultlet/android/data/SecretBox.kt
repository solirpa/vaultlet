package com.vaultlet.android.data

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-GCM keys in the Android Keystore (hardware-backed where available).
 *
 * - [APP_KEY] protects small secrets at rest (the WebDAV app password).
 * - [BIO_KEY] protects the master password for fingerprint unlock: every use needs a fresh
 *   strong biometric, and enrolling a new fingerprint invalidates it.
 */
object SecretBox {
    private const val STORE = "AndroidKeyStore"
    private const val APP_KEY = "vaultlet.app"
    private const val BIO_KEY = "vaultlet.biometric"
    private const val TRANSFORM = "AES/GCM/NoPadding"

    private val keyStore: KeyStore by lazy { KeyStore.getInstance(STORE).apply { load(null) } }

    private fun key(alias: String, biometric: Boolean): SecretKey {
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
        if (biometric) {
            spec.setUserAuthenticationRequired(true)
            spec.setInvalidatedByBiometricEnrollment(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            }
        }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE).run {
            init(spec.build())
            generateKey()
        }
    }

    /** `base64(iv):base64(ciphertext)` */
    private fun pack(iv: ByteArray, ct: ByteArray) =
        Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)

    private fun unpack(blob: String): Pair<ByteArray, ByteArray> {
        val (iv, ct) = blob.split(":", limit = 2)
        return Base64.decode(iv, Base64.NO_WRAP) to Base64.decode(ct, Base64.NO_WRAP)
    }

    fun seal(plain: String): String {
        val c = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, key(APP_KEY, false)) }
        return pack(c.iv, c.doFinal(plain.toByteArray()))
    }

    fun open(blob: String): String {
        val (iv, ct) = unpack(blob)
        val c = Cipher.getInstance(TRANSFORM).apply { init(Cipher.DECRYPT_MODE, key(APP_KEY, false), GCMParameterSpec(128, iv)) }
        return String(c.doFinal(ct))
    }

    // ---- fingerprint unlock -------------------------------------------------------------

    /** Cipher to unlock with a BiometricPrompt before [sealBiometric]. */
    fun biometricEncryptCipher(): Cipher {
        return try {
            Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, key(BIO_KEY, true)) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            deleteBiometricKey()
            Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, key(BIO_KEY, true)) }
        }
    }

    fun sealBiometric(authenticated: Cipher, plain: String): String = pack(authenticated.iv, authenticated.doFinal(plain.toByteArray()))

    /**
     * Cipher to unlock with a BiometricPrompt before [openBiometric]; null when the key is gone
     * (a fingerprint was added or removed), in which case the stored password is useless.
     */
    fun biometricDecryptCipher(blob: String): Cipher? = try {
        val (iv, _) = unpack(blob)
        val k = keyStore.getKey(BIO_KEY, null) as? SecretKey ?: return null
        Cipher.getInstance(TRANSFORM).apply { init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(128, iv)) }
    } catch (e: KeyPermanentlyInvalidatedException) {
        deleteBiometricKey()
        null
    }

    fun openBiometric(authenticated: Cipher, blob: String): String = String(authenticated.doFinal(unpack(blob).second))

    fun deleteBiometricKey() {
        if (keyStore.containsAlias(BIO_KEY)) keyStore.deleteEntry(BIO_KEY)
    }
}
