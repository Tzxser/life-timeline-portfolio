package com.tzxser.lifetimeline.mobile

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.FileProvider
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import java.security.MessageDigest
import java.io.File
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SecretArgs {
    lateinit var data: String
    var decrypt: Boolean = false
}

@InvokeArg
class OpenAttachmentArgs {
    lateinit var path: String
    lateinit var mimeType: String
}

@InvokeArg
class InstallApkArgs {
    lateinit var path: String
    lateinit var packageName: String
    lateinit var versionName: String
    var versionCode: Long = 0
    lateinit var certificateSha256: String
    lateinit var sha256: String
    var size: Long = 0
}

/** API secrets never leave app-private storage except for an explicit API call.
 *  The wrapping key is non-exportable Android Keystore material, independent
 *  from the SQLite database and diary/backup archives. */
@TauriPlugin
class LifeMobilePlugin(private val activity: Activity) : Plugin(activity) {
    private val alias = "life-timeline.api-key.v1"
    private val aad = "life-timeline/api-key/android/v1".toByteArray(Charsets.UTF_8)

    @Synchronized
    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(alias, null)
        if (existing is SecretKey) return existing
        check(create) { "Keystore key unavailable" }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    @Command
    fun protectSecret(invoke: Invoke) {
        var input: ByteArray? = null
        var output: ByteArray? = null
        try {
            val args = invoke.parseArgs(SecretArgs::class.java)
            require(args.data.length in 1..45000)
            val bytes = Base64.decode(args.data, Base64.NO_WRAP)
            input = bytes
            require(bytes.size in 1..32768)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val resultBytes = if (args.decrypt) {
                require(bytes.size >= 30 && bytes[0] == 1.toByte())
                cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes, 1, 12))
                cipher.updateAAD(aad)
                cipher.doFinal(bytes, 13, bytes.size - 13)
            } else {
                require(bytes.size <= 16384)
                cipher.init(Cipher.ENCRYPT_MODE, key(true))
                cipher.updateAAD(aad)
                check(cipher.iv.size == 12)
                byteArrayOf(1) + cipher.iv + cipher.doFinal(bytes)
            }
            output = resultBytes
            val response = JSObject()
            response.put("data", Base64.encodeToString(resultBytes, Base64.NO_WRAP))
            invoke.resolve(response)
        } catch (_: Exception) {
            // Avoid including request fields or crypto/provider diagnostics.
            invoke.reject("手机密钥保护不可用，请重新输入并保存 API 密钥。")
        } finally {
            input?.fill(0)
            output?.fill(0)
        }
    }

    @Command
    fun openAttachment(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(OpenAttachmentArgs::class.java)
            val source = File(args.path).canonicalFile
            val shared = File(activity.cacheDir, "shared-attachments").canonicalFile
            require(source.isFile && source.parentFile?.parentFile == shared)
            require(source.parentFile?.name?.matches(Regex("[a-f0-9]{64}")) == true)
            require(args.mimeType.length in 1..160 && !args.mimeType.any { it.isISOControl() })
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", source)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, args.mimeType)
                clipData = ClipData.newRawUri("附件", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.runOnUiThread {
                try {
                    activity.startActivity(Intent.createChooser(intent, "打开附件"))
                    invoke.resolve()
                } catch (_: Exception) {
                    invoke.reject("手机没有可打开此附件的应用，请先保存附件后查看。")
                }
            }
        } catch (_: Exception) {
            invoke.reject("附件路径无效，未交给其他应用。")
        }
    }

    /**
     * Validate identity with Android's package parser and then open the
     * user-confirmed package installer. This method never calls a hidden or
     * privileged install API.
     */
    @Command
    fun installApk(invoke: Invoke) {
        installVerifiedApk(invoke, true)
    }

    @ActivityCallback
    @Suppress("UNUSED_PARAMETER")
    fun installPermissionResult(invoke: Invoke, result: ActivityResult) {
        // Settings result codes differ by Android/OEM. Recheck the actual
        // grant, and validate the APK again after the user returns.
        Thread({ installVerifiedApk(invoke, false) }, "life-timeline-update-check").start()
    }

    private fun installVerifiedApk(invoke: Invoke, mayRequestPermission: Boolean) {
        try {
            val args = invoke.parseArgs(InstallApkArgs::class.java)
            require(args.packageName == activity.packageName)
            require(args.versionName.matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?")))
            require(args.versionCode > 0)
            require(args.certificateSha256.matches(Regex("[0-9a-fA-F]{64}")))
            require(args.sha256.matches(Regex("[0-9a-f]{64}")) && args.size > 0)
            val source = File(args.path).canonicalFile
            val updaterDir = File(activity.cacheDir, "android-updates").canonicalFile
            require(source.isFile && source.parentFile?.canonicalFile == updaterDir)
            require(source.length() == args.size && sha256File(source) == args.sha256)

            val flags = if (Build.VERSION.SDK_INT >= 28) {
                PackageManager.GET_SIGNING_CERTIFICATES
            } else {
                @Suppress("DEPRECATION")
                PackageManager.GET_SIGNATURES
            }
            val archive = activity.packageManager.getPackageArchiveInfo(source.path, flags)
                ?: throw IllegalArgumentException("archive")
            require(archive.packageName == args.packageName)
            require(archive.versionName == args.versionName)
            val archiveVersionCode = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else {
                @Suppress("DEPRECATION")
                archive.versionCode.toLong()
            }
            require(archiveVersionCode == args.versionCode)
            val current = activity.packageManager.getPackageInfo(activity.packageName, 0)
            val currentVersionCode = if (Build.VERSION.SDK_INT >= 28) current.longVersionCode else {
                @Suppress("DEPRECATION")
                current.versionCode.toLong()
            }
            require(archiveVersionCode > currentVersionCode)
            val signatures = if (Build.VERSION.SDK_INT >= 28) {
                archive.signingInfo?.apkContentsSigners
            } else {
                @Suppress("DEPRECATION")
                archive.signatures
            }
            require(!signatures.isNullOrEmpty())
            val certificate = sha256(signatures.first().toByteArray())
            require(certificate.equals(args.certificateSha256, ignoreCase = true))
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", source)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                clipData = ClipData.newRawUri("life-timeline 更新包", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.runOnUiThread {
                try {
                    if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
                        if (mayRequestPermission) {
                            openInstallPermission(invoke)
                        } else {
                            invoke.reject("未允许安装更新。可以稍后重试，已下载的更新包会保留。", "install_permission")
                        }
                        return@runOnUiThread
                    }
                    // Let Android route the APK directly to its installer;
                    // an attachment chooser can select an unrelated file app.
                    activity.startActivity(intent)
                    invoke.resolve()
                } catch (_: ActivityNotFoundException) {
                    invoke.reject("未找到系统安装器，请从下载页下载后使用系统文件管理器安装。", "installer_unavailable")
                } catch (_: SecurityException) {
                    invoke.reject("系统阻止了安装界面，请检查本应用的安装授权或设备限制。", "install_blocked")
                } catch (_: Exception) {
                    invoke.reject("无法打开系统安装界面，请稍后重试。", "installer_unavailable")
                }
            }
        } catch (_: Exception) {
            // Do not expose paths, package details or parser diagnostics.
            invoke.reject("更新包校验失败，已停止安装。", "package_invalid")
        }
    }

    private fun openInstallPermission(invoke: Invoke) {
        val packageUri = Uri.parse("package:${activity.packageName}")
        try {
            startActivityForResult(invoke, Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, packageUri), "installPermissionResult")
        } catch (_: ActivityNotFoundException) {
            // Some vendors expose the setting only through app details.
            try {
                startActivityForResult(invoke, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri), "installPermissionResult")
            } catch (_: Exception) {
                invoke.reject("无法打开安装授权设置，请在系统设置中允许 life-timeline 安装未知应用后重试。", "install_settings")
            }
        } catch (_: Exception) {
            invoke.reject("无法打开安装授权设置，请在系统设置中允许 life-timeline 安装未知应用后重试。", "install_settings")
        }
    }

    private fun sha256File(source: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        source.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
}
