package com.vaultlet.android.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.Fingerprint
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.vaultlet.android.R
import com.vaultlet.android.data.SecretBox
import com.vaultlet.android.data.VaultFile
import com.vaultlet.android.data.VaultSource
import com.vaultlet.android.data.VaultStore
import com.vaultlet.android.data.vaultMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.vault_ffi.WebDavConfig

@Composable
fun VaultletRoot(store: VaultStore, activity: FragmentActivity, unlocked: @Composable (VaultStore.State.Unlocked) -> Unit = { VaultScreen(store, it.vault, activity) }) {
    // Lives here, not in UnlockScreen: the offer appears after the switch to the unlocked screen.
    var biometricOffer by remember { mutableStateOf<String?>(null) }
    when (val s = store.state.collectAsState().value) {
        VaultStore.State.NotConfigured -> SetupScreen(store)
        VaultStore.State.Locked -> UnlockScreen(store, activity, onOfferBiometric = { biometricOffer = it })
        is VaultStore.State.Unlocked -> {
            unlocked(s)
            biometricOffer?.let { password -> EnableBiometricDialog(store, activity, password) { biometricOffer = null } }
        }
    }
}

/** Desktop AuthShell: logo and heading above a floating card, quiet actions below. */
@Composable
private fun AuthShell(
    title: String,
    subtitle: String?,
    footer: @Composable ColumnScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(56.dp))
        VaultLogo(64.dp)
        Text(title, style = Type.title, color = P.text, modifier = Modifier.padding(top = 20.dp), textAlign = TextAlign.Center)
        if (subtitle != null) {
            Text(subtitle, style = Type.callout, color = P.muted, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 6.dp).widthIn(max = 340.dp))
        }
        Column(
            Modifier
                .padding(top = 28.dp)
                .widthIn(max = 440.dp)
                .fillMaxWidth()
                .shadow(if (P.dark) 0.dp else 18.dp, RoundedCornerShape(24.dp), ambientColor = P.text.copy(alpha = 0.25f), spotColor = P.text.copy(alpha = 0.25f))
                .clip(RoundedCornerShape(24.dp))
                .background(P.surface)
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            content = content,
        )
        Column(Modifier.padding(top = 16.dp).widthIn(max = 440.dp).fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, content = footer)
        Spacer(Modifier.height(32.dp))
    }
}

@Composable
private fun ErrorText(text: String?, tag: String? = null) {
    if (text == null) return
    Text(text, style = Type.subhead, color = P.danger, modifier = if (tag != null) Modifier.tag(tag) else Modifier)
}

/** [vaultMessage], with `fileGone` (resolved in composition) for a vanished or revoked file. */
private fun Throwable.messageFor(fileGone: String): String = if (this is VaultFile.Gone) fileGone else vaultMessage()

/** A quiet footer link ("choose another", "use another vault"). */
@Composable
private fun FooterLink(text: String, onClick: () -> Unit) {
    Text(
        text,
        style = Type.subhead,
        color = P.muted,
        modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
    )
}

private sealed interface SetupStep {
    data object Choose : SetupStep
    data class File(val uri: Uri) : SetupStep
    data object WebDav : SetupStep
}

@Composable
private fun SetupScreen(store: VaultStore) {
    var step by remember { mutableStateOf<SetupStep>(SetupStep.Choose) }
    when (val st = step) {
        SetupStep.Choose -> ChooseSourceScreen(onFile = { step = SetupStep.File(it) }, onWebDav = { step = SetupStep.WebDav })
        is SetupStep.File -> FileSetupScreen(store, st.uri) { step = SetupStep.Choose }
        SetupStep.WebDav -> WebDavSetupScreen(store) { step = SetupStep.Choose }
    }
}

@Composable
private fun ChooseSourceScreen(onFile: (Uri) -> Unit, onWebDav: () -> Unit) {
    // OpenDocument (not GetContent): its grant can be made persistable, and it is read/write.
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if (uri != null) onFile(uri) }
    AuthShell(
        stringResource(R.string.setup_title),
        stringResource(R.string.setup_body),
        footer = { Text(stringResource(R.string.setup_footer), style = Type.caption, color = P.faint, textAlign = TextAlign.Center) },
    ) {
        SourceChoice(Icons.Outlined.FolderOpen, stringResource(R.string.setup_file), stringResource(R.string.setup_file_body), Modifier.tag("setup_file")) {
            // .kdbx has no registered MIME type; providers report it as octet-stream or nothing.
            pick.launch(arrayOf("*/*"))
        }
        SourceChoice(Icons.Outlined.Cloud, stringResource(R.string.setup_webdav), stringResource(R.string.setup_webdav_body), Modifier.tag("setup_webdav"), onWebDav)
    }
}

@Composable
private fun SourceChoice(icon: ImageVector, title: String, detail: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(P.surface2).clickable(onClick = onClick).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = P.accent, modifier = Modifier.size(26.dp))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = Type.headline, color = P.text)
            Text(detail, style = Type.subhead, color = P.muted, modifier = Modifier.padding(top = 3.dp))
        }
        Icon(Icons.Outlined.ChevronRight, null, tint = P.faint, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun FileSetupScreen(store: VaultStore, uri: Uri, onBack: () -> Unit) {
    val context = LocalContext.current
    var name by remember { mutableStateOf<String?>(null) }
    // Cloud providers may take a moment to answer the name query; keep it off the main thread.
    LaunchedEffect(uri) { name = withContext(Dispatchers.IO) { VaultFile.displayName(context.contentResolver, uri) } }
    var master by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val fileGone = stringResource(R.string.err_file_gone)
    val open = {
        if (!busy && master.isNotEmpty()) {
            busy = true
            error = null
            scope.launch {
                try {
                    store.setUpFile(uri, master)
                } catch (e: Exception) {
                    error = e.messageFor(fileGone)
                } finally {
                    busy = false
                }
            }
        }
    }
    AuthShell(stringResource(R.string.unlock_title), name, footer = { FooterLink(stringResource(R.string.choose_another), onBack) }) {
        Field(master, { master = it }, stringResource(R.string.master_password), secret = true, onDone = open, tag = "setup_master")
        ErrorText(error)
        PrimaryButton(stringResource(R.string.open), open, enabled = master.isNotEmpty(), busy = busy, modifier = Modifier.tag("setup_open"))
    }
}

@Composable
private fun WebDavSetupScreen(store: VaultStore, onBack: () -> Unit) {
    var url by rememberSaveable { mutableStateOf("https://dav.jianguoyun.com/dav/") }
    var user by rememberSaveable { mutableStateOf("") }
    var appPassword by remember { mutableStateOf("") }
    var path by rememberSaveable { mutableStateOf("/我的坚果云/Vaultlet/Vaultlet.kdbx") }
    var master by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ready = user.isNotBlank() && appPassword.isNotEmpty() && master.isNotEmpty()
    val connect = {
        if (!busy && ready) {
            busy = true
            error = null
            scope.launch {
                try {
                    store.setUp(WebDavConfig(url.trim(), user.trim(), appPassword, path.trim()), master)
                } catch (e: Exception) {
                    error = e.vaultMessage()
                } finally {
                    busy = false
                }
            }
        }
    }
    AuthShell(stringResource(R.string.setup_webdav), stringResource(R.string.setup_webdav_hint), footer = { FooterLink(stringResource(R.string.choose_another), onBack) }) {
        Field(url, { url = it }, stringResource(R.string.setup_url), keyboardType = KeyboardType.Uri, tag = "setup_url")
        Field(user, { user = it }, stringResource(R.string.setup_user), keyboardType = KeyboardType.Email, tag = "setup_user")
        Column {
            Field(appPassword, { appPassword = it }, stringResource(R.string.setup_app_password), secret = true, tag = "setup_app_password")
            Text(stringResource(R.string.setup_app_password_hint), style = Type.caption, color = P.muted, modifier = Modifier.padding(start = 4.dp, top = 6.dp))
        }
        Field(path, { path = it }, stringResource(R.string.setup_path), tag = "setup_path")
        Field(master, { master = it }, stringResource(R.string.master_password), secret = true, onDone = connect, tag = "setup_master")
        ErrorText(error)
        PrimaryButton(stringResource(R.string.setup_connect), connect, enabled = ready, busy = busy, modifier = Modifier.tag("setup_connect"))
    }
}

@Composable
private fun UnlockScreen(store: VaultStore, activity: FragmentActivity, onOfferBiometric: (String) -> Unit) {
    var master by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmSignOut by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val canBio = remember { activity.canUseBiometric() }
    val bioTitle = stringResource(R.string.biometric_title)
    val cancel = stringResource(R.string.cancel)
    val invalidated = stringResource(R.string.biometric_invalidated)

    val fileGone = stringResource(R.string.err_file_gone)

    fun unlockWith(password: String, askBiometric: Boolean) {
        busy = true
        error = null
        scope.launch {
            try {
                store.unlock(password)
                if (askBiometric && canBio && store.prefs.biometricBlob == null) onOfferBiometric(password)
            } catch (e: Exception) {
                error = e.messageFor(fileGone)
            } finally {
                busy = false
            }
        }
    }

    fun unlockWithFingerprint() {
        val blob = store.prefs.biometricBlob ?: return
        val cipher = SecretBox.biometricDecryptCipher(blob)
        if (cipher == null) {
            store.prefs.biometricBlob = null
            error = invalidated
            return
        }
        scope.launch {
            val ok = activity.authenticate(cipher, bioTitle, cancel) ?: return@launch
            val password = runCatching { SecretBox.openBiometric(ok, blob) }.getOrNull()
            if (password == null) {
                store.prefs.biometricBlob = null
                error = invalidated
            } else {
                unlockWith(password, askBiometric = false)
            }
        }
    }

    // Offer the fingerprint right away when it is set up.
    LaunchedEffect(Unit) { if (canBio && store.prefs.biometricBlob != null) unlockWithFingerprint() }

    val hasBio = canBio && store.prefs.biometricBlob != null
    val source = remember { store.prefs.source }
    AuthShell(
        title = stringResource(R.string.unlock_title),
        subtitle = source?.label,
        footer = { FooterLink(stringResource(R.string.sign_out)) { confirmSignOut = true } },
    ) {
        Field(master, { master = it }, stringResource(R.string.master_password), secret = true, onDone = { if (master.isNotEmpty()) unlockWith(master, true) }, tag = "unlock_password")
        ErrorText(error, "unlock_error")
        PrimaryButton(stringResource(R.string.unlock), { unlockWith(master, true) }, enabled = master.isNotEmpty(), busy = busy, modifier = Modifier.tag("unlock_button"))
        if (hasBio) {
            TonalButton(stringResource(R.string.unlock_fingerprint), { unlockWithFingerprint() }, Modifier.fillMaxWidth(), icon = Icons.Outlined.Fingerprint)
        }
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            containerColor = P.surface,
            text = { Text(stringResource(if (source is VaultSource.File) R.string.sign_out_confirm_file else R.string.sign_out_confirm), style = Type.body, color = P.text) },
            confirmButton = { TextButton(onClick = { confirmSignOut = false; store.signOut() }) { Text(stringResource(R.string.sign_out), color = P.danger) } },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

/** Seal the master password with the fingerprint key (needs one fingerprint now). */
@Composable
fun EnableBiometricDialog(store: VaultStore, activity: FragmentActivity, password: String, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    val title = stringResource(R.string.biometric_enable_title)
    val cancel = stringResource(R.string.cancel)
    AlertDialog(
        onDismissRequest = onDone,
        containerColor = P.surface,
        icon = { androidx.compose.material3.Icon(Icons.Outlined.Fingerprint, null, tint = P.accent) },
        title = { Text(title, style = Type.headline, color = P.text) },
        text = { Text(stringResource(R.string.biometric_enable_body), style = Type.callout, color = P.muted) },
        confirmButton = {
            TextButton(onClick = {
                scope.launch {
                    val cipher = activity.authenticate(SecretBox.biometricEncryptCipher(), title, cancel)
                    if (cipher != null) store.prefs.biometricBlob = SecretBox.sealBiometric(cipher, password)
                    onDone()
                }
            }) { Text(stringResource(R.string.biometric_enable), fontWeight = FontWeight.SemiBold) }
        },
        dismissButton = { TextButton(onClick = onDone) { Text(stringResource(R.string.not_now), color = P.muted) } },
    )
}
