package app.openagentd.shell

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.annotation.RequiresApi
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource

/**
 * The phone's OpenAgentd account keys (Remote control), for the Rust shell
 * (`mobile/src-tauri/src/cloud.rs`). The Android counterpart of the iOS
 * Keychain bridge (`mobile/ios-widget/App/KeychainBridge.swift`), with the
 * same three items (`appv3/contract/tunnel-threats.md`, "Storage"):
 *
 * * 0 `identity`: the device's auth and box seeds, account id and last
 *   verified roster (the sign seed kept apart);
 * * 1 `box`: the box seed alone, which the push service reads to open
 *   letters while the phone is locked;
 * * 2 `sign`: the seed that signs rosters.
 *
 * Items 0 and 1 are encrypted with an AES-256-GCM Keystore key that needs
 * no user check (usable after the first unlock, like the iOS items).
 *
 * Item 2 is encrypted to an RSA-2048 Keystore key pair whose private half
 * needs the user on every use: a strong biometric or the screen lock's PIN,
 * pattern or password (Android 11+). Encrypting uses only the public half,
 * so storing new keys asks nothing, as on iOS; reading asks through the
 * system prompt. Adding a fingerprint does not invalidate it (as iOS
 * `.userPresence`); turning the screen lock off does, permanently.
 *
 * Neither Keystore key leaves the device or travels with a backup, so a
 * restored copy of the ciphertext cannot be read. Only ciphertext is kept, in
 * app-private SharedPreferences.
 */
internal class CloudKeyStore(context: Context) {
    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** What a read answers: `status` is ok, not_found, cancelled, invalidated or error. */
    class Read(val status: String, val value: String? = null, val message: String? = null)

    /** Whether this phone can hold the account keys now. */
    class Availability(val api: Int, val secureLock: Boolean, val hardware: Boolean)

    fun availability(): Availability {
        val keyguard = app.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        val api = Build.VERSION.SDK_INT
        if (api < Build.VERSION_CODES.R) return Availability(api, keyguard.isDeviceSecure, false)
        val hardware = try {
            isInSecureHardware(identityKey())
        } catch (_: Exception) {
            false
        }
        return Availability(api, keyguard.isDeviceSecure, hardware)
    }

    @Synchronized
    fun set(item: Int, value: String) {
        val payload = when (item) {
            IDENTITY, BOX -> encryptAes(value)
            SIGN -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                    throw IllegalStateException("Accounts need Android 11 or later.")
                }
                // Only brand-new keys are stored (`finish` in cloud.rs), so a
                // key pair already there belongs to the keys being replaced.
                deleteAlias(SIGN_ALIAS)
                encryptToSignKey(newSignKey(), value)
            }
            else -> throw IllegalArgumentException("Unknown key item")
        }
        val written = prefs.edit().putString(entry(item), payload).commit()
        if (!written) throw IllegalStateException("Could not store the account keys")
    }

    /** Items 0 and 1; never asks the user. */
    @Synchronized
    fun get(item: Int): Read {
        if (item != IDENTITY && item != BOX) return Read("error", message = "Unknown key item")
        val stored = prefs.getString(entry(item), null) ?: return Read("not_found")
        val key = keyStore().getKey(IDENTITY_ALIAS, null) as? SecretKey
        if (key == null) {
            // Ciphertext without its key: restored from a backup or moved to
            // another phone. It can never be read again; forget it, so the
            // phone is a guest as an iPhone restored from a backup is.
            prefs.edit().remove(entry(IDENTITY)).remove(entry(BOX)).remove(entry(SIGN)).commit()
            return Read("not_found")
        }
        return try {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(AES_TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES))
            Read("ok", String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8))
        } catch (_: AEADBadTagException) {
            // Sealed under another key (a backup restored after this phone
            // made a new one): as unreadable as a missing key.
            prefs.edit().remove(entry(IDENTITY)).remove(entry(BOX)).remove(entry(SIGN)).commit()
            Read("not_found")
        } catch (ex: Exception) {
            // Not deleted: a passing Keystore failure must not sign the
            // phone out.
            Read("error", message = ex.message ?: ex.javaClass.simpleName)
        }
    }

    /**
     * Item 2, behind the system prompt showing `reason`. Calls `done` once,
     * on the main thread or the caller's.
     */
    @RequiresApi(Build.VERSION_CODES.R)
    fun unlockSign(activity: Activity, reason: String, done: (Read) -> Unit) {
        val stored = synchronized(this) { prefs.getString(entry(SIGN), null) }
            ?: return done(Read("not_found"))
        val cipher = try {
            val key = keyStore().getKey(SIGN_ALIAS, null) as? PrivateKey
                ?: return done(Read("invalidated"))
            Cipher.getInstance(RSA_TRANSFORMATION).apply { init(Cipher.DECRYPT_MODE, key, OAEP) }
        } catch (_: KeyPermanentlyInvalidatedException) {
            return done(Read("invalidated"))
        } catch (ex: Exception) {
            return done(Read("error", message = ex.message ?: ex.javaClass.simpleName))
        }
        val bytes = Base64.decode(stored, Base64.NO_WRAP)
        activity.runOnUiThread {
            try {
                prompt(activity, reason, cipher, bytes, done)
            } catch (ex: Exception) {
                done(Read("error", message = ex.message ?: ex.javaClass.simpleName))
            }
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun prompt(activity: Activity, reason: String, cipher: Cipher, sealed: ByteArray, done: (Read) -> Unit) {
        val prompt = BiometricPrompt.Builder(activity)
            .setTitle("OpenAgentd")
            .setSubtitle(reason.ifBlank { "Approve with your account key" })
            .setAllowedAuthenticators(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL)
            .build()
        prompt.authenticate(
            BiometricPrompt.CryptoObject(cipher),
            CancellationSignal(),
            activity.mainExecutor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val read = try {
                        val opened = result.cryptoObject?.cipher?.doFinal(sealed)
                            ?: throw IllegalStateException("The prompt returned no key")
                        Read("ok", String(opened, Charsets.UTF_8))
                    } catch (_: KeyPermanentlyInvalidatedException) {
                        Read("invalidated")
                    } catch (ex: Exception) {
                        Read("error", message = ex.message ?: ex.javaClass.simpleName)
                    }
                    done(read)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    val read = when (errorCode) {
                        BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED,
                        BiometricPrompt.BIOMETRIC_ERROR_CANCELED -> Read("cancelled")
                        else -> Read("error", message = errString.toString())
                    }
                    done(read)
                }
                // onAuthenticationFailed (a finger not recognised): the
                // prompt stays up and the person tries again.
            },
        )
    }

    /** Signing out: every item and both Keystore keys. */
    @Synchronized
    fun clear() {
        prefs.edit().clear().commit()
        deleteAlias(SIGN_ALIAS)
        deleteAlias(IDENTITY_ALIAS)
    }

    /** Whether any Keystore key of the account is left (for checks after sign-out). */
    @Synchronized
    fun hasAnyKey(): Boolean {
        val ks = keyStore()
        return ks.containsAlias(SIGN_ALIAS) || ks.containsAlias(IDENTITY_ALIAS) || prefs.all.isNotEmpty()
    }

    // ---- Keys ---------------------------------------------------------

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun deleteAlias(alias: String) {
        val ks = keyStore()
        if (ks.containsAlias(alias)) ks.deleteEntry(alias)
    }

    private fun hasStrongBox(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            app.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

    private fun identityKey(): SecretKey {
        (keyStore().getKey(IDENTITY_ALIAS, null) as? SecretKey)?.let { return it }
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(
            IDENTITY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .apply { if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true) }
            .build()
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        if (hasStrongBox()) {
            try {
                generator.init(spec(true))
                return generator.generateKey()
            } catch (_: StrongBoxUnavailableException) {
                // Falls back to the TEE below.
            }
        }
        generator.init(spec(false))
        return generator.generateKey()
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun newSignKey(): java.security.PublicKey {
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(
            SIGN_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setKeySize(2048)
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(
                0,
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
            )
            .setInvalidatedByBiometricEnrollment(false)
            .apply { if (strongBox) setIsStrongBoxBacked(true) }
            .build()
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEYSTORE)
        val pair = if (hasStrongBox()) {
            try {
                generator.initialize(spec(true))
                generator.generateKeyPair()
            } catch (_: StrongBoxUnavailableException) {
                generator.initialize(spec(false))
                generator.generateKeyPair()
            }
        } else {
            generator.initialize(spec(false))
            generator.generateKeyPair()
        }
        return pair.public
    }

    private fun isInSecureHardware(key: SecretKey): Boolean {
        val info = SecretKeyFactory.getInstance(key.algorithm, ANDROID_KEYSTORE)
            .getKeySpec(key, KeyInfo::class.java) as KeyInfo
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            info.securityLevel != KeyProperties.SECURITY_LEVEL_SOFTWARE &&
                info.securityLevel != KeyProperties.SECURITY_LEVEL_UNKNOWN
        } else {
            @Suppress("DEPRECATION")
            info.isInsideSecureHardware
        }
    }

    // ---- Ciphers ------------------------------------------------------

    private fun encryptAes(value: String): String {
        val cipher = Cipher.getInstance(AES_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, identityKey())
        val payload = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(payload, Base64.NO_WRAP)
    }

    /** Encrypts with the public half only (in software), so nothing asks the user. */
    private fun encryptToSignKey(keystorePublic: java.security.PublicKey, value: String): String {
        val bytes = value.toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_SIGN_BYTES) { "The signing key text is too long" }
        val public = KeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_RSA)
            .generatePublic(X509EncodedKeySpec(keystorePublic.encoded))
        val cipher = Cipher.getInstance(RSA_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, public, OAEP)
        return Base64.encodeToString(cipher.doFinal(bytes), Base64.NO_WRAP)
    }

    private fun entry(item: Int): String = when (item) {
        IDENTITY -> "identity"
        BOX -> "box"
        SIGN -> "sign"
        else -> throw IllegalArgumentException("Unknown key item")
    }

    companion object {
        const val IDENTITY = 0
        const val BOX = 1
        const val SIGN = 2

        private const val PREFS_NAME = "openagentd.cloud.keys"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val IDENTITY_ALIAS = "openagentd.cloud.identity.v1"
        private const val SIGN_ALIAS = "openagentd.cloud.sign.v1"
        private const val AES_TRANSFORMATION = "AES/GCM/NoPadding"
        private const val RSA_TRANSFORMATION = "RSA/ECB/OAEPWithSHA-256AndMGF1Padding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
        /** RSA-2048 with OAEP-SHA-256: 256 - 2 * 32 - 2. */
        private const val MAX_SIGN_BYTES = 190

        /** The Keystore takes MGF1 with SHA-1 on every Android version. */
        private val OAEP = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT)
    }
}
