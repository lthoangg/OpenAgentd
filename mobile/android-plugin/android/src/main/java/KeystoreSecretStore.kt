package app.openagentd.shell

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Secrets encrypted with a non-exportable AES-256-GCM key held in the Android
 * Keystore; the ciphertext lives in app-private SharedPreferences.
 *
 * Stored values are base64 strings produced by the Rust side, so this class
 * never interprets them.
 */
internal class KeystoreSecretStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun get(service: String, user: String): String? {
        val name = entryName(service, user)
        val stored = prefs.getString(name, null) ?: return null
        return try {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES))
            String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
        } catch (_: Exception) {
            // The Keystore key does not travel with backups or device
            // transfers, so restored ciphertext is unreadable. Drop it and
            // report "no key" so the app asks for the access key again
            // instead of failing every request.
            prefs.edit().remove(name).commit()
            null
        }
    }

    @Synchronized
    fun set(service: String, user: String, value: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val payload = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val written = prefs.edit()
            .putString(entryName(service, user), Base64.encodeToString(payload, Base64.NO_WRAP))
            .commit()
        if (!written) throw IllegalStateException("Could not persist the credential")
    }

    @Synchronized
    fun delete(service: String, user: String): Boolean {
        val name = entryName(service, user)
        if (!prefs.contains(name)) return false
        prefs.edit().remove(name).commit()
        return true
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    /** Base64url keeps arbitrary service/origin strings safe as XML keys. */
    private fun entryName(service: String, user: String): String =
        Base64.encodeToString(
            "$service\n$user".toByteArray(Charsets.UTF_8),
            Base64.NO_WRAP or Base64.URL_SAFE,
        )

    private companion object {
        const val PREFS_NAME = "openagentd.credentials"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "openagentd.credentials.v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}
