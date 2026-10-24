package com.vaultlet.android.ui

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.automirrored.outlined.StickyNote2
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AutoFixHigh
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.StarBorder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import com.vaultlet.android.R
import com.vaultlet.android.data.VaultStore
import com.vaultlet.android.data.vaultMessage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import uniffi.vault_ffi.ItemDetail
import uniffi.vault_ffi.ItemInput
import uniffi.vault_ffi.ItemSummary
import uniffi.vault_ffi.Vault
import uniffi.vault_ffi.VaultException
import uniffi.vault_ffi.generatePassword

private sealed interface Page {
    data object List : Page
    data class Detail(val id: String) : Page
    /** `id == null`: new login */
    data class Edit(val id: String?) : Page
}

@Suppress("UNUSED_PARAMETER") // activity: kept for screens that need system prompts
@Composable
fun VaultScreen(store: VaultStore, vault: Vault, activity: FragmentActivity) {
    var page by remember { mutableStateOf<Page>(Page.List) }
    var toast by remember { mutableStateOf<String?>(null) }
    var toastSeq by remember { mutableIntStateOf(0) }
    val show: (String) -> Unit = { toast = it; toastSeq++ }
    LaunchedEffect(toastSeq) {
        if (toast != null) {
            delay(1800)
            toast = null
        }
    }

    Box(Modifier.fillMaxSize().background(P.bg)) {
        when (val p = page) {
            Page.List -> ListPage(store, vault, onOpen = { page = Page.Detail(it) }, onNew = { page = Page.Edit(null) })
            is Page.Detail -> {
                BackHandler { page = Page.List }
                DetailPage(store, vault, p.id, show, onBack = { page = Page.List }, onEdit = { page = Page.Edit(p.id) })
            }
            is Page.Edit -> {
                val back = { page = if (p.id != null) Page.Detail(p.id) else Page.List }
                BackHandler { back() }
                val saved = stringResource(R.string.saved)
                val trashed = stringResource(R.string.trashed)
                EditPage(
                    store, vault, p.id,
                    onCancel = back,
                    onSaved = { id -> show(saved); page = Page.Detail(id) },
                    onTrashed = { show(trashed); page = Page.List },
                )
            }
        }
        toast?.let {
            Toast(it, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 96.dp))
        }
    }
}

private fun kindIcon(kind: String): ImageVector? = when (kind) {
    "card" -> Icons.Outlined.CreditCard
    "note" -> Icons.AutoMirrored.Outlined.StickyNote2
    "identity" -> Icons.Outlined.Person
    else -> null
}

@Composable
private fun kindLabel(kind: String): String = stringResource(
    when (kind) {
        "card" -> R.string.kind_card
        "note" -> R.string.kind_note
        "identity" -> R.string.kind_identity
        else -> R.string.kind_login
    },
)

/** Back arrow / title / actions, on the page background. */
@Composable
private fun TopBar(onBack: (() -> Unit)?, backLabel: String, title: String? = null, actions: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().statusBarsPadding().height(56.dp).padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (onBack != null) IconAction(Icons.AutoMirrored.Outlined.ArrowBack, backLabel, tint = P.text, onClick = onBack)
        Text(title ?: "", style = Type.headline, color = P.text, modifier = Modifier.weight(1f).padding(start = 6.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) { actions() }
        Spacer(Modifier.width(6.dp))
    }
}

// ---- list ---------------------------------------------------------------------------------------

@Composable
private fun ListPage(store: VaultStore, vault: Vault, onOpen: (String) -> Unit, onNew: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val revision by store.revision.collectAsState()
    val sync by store.sync.collectAsState()
    var items by remember { mutableStateOf<List<ItemSummary>>(emptyList()) }
    var menu by remember { mutableStateOf(false) }
    var bioOn by remember { mutableStateOf(store.prefs.biometricBlob != null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(query, revision) { items = if (query.isBlank()) vault.items() else vault.search(query) }
    val favorites = if (query.isBlank()) items.filter { it.favorite } else emptyList()

    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize().tag("item_list"),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 120.dp),
        ) {
            item {
                Column(Modifier.statusBarsPadding().padding(top = 12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(vault.name(), style = Type.largeTitle, color = P.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            SyncLine(sync)
                        }
                        IconAction(Icons.Outlined.Lock, stringResource(R.string.lock), Modifier.tag("lock"), tint = P.text) { store.lock() }
                        Box {
                            IconAction(Icons.Outlined.MoreHoriz, stringResource(R.string.more), tint = P.text) { menu = true }
                            DropdownMenu(menu, { menu = false }, containerColor = P.surface, shape = RoundedCornerShape(14.dp)) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.sync_now), style = Type.callout) },
                                    leadingIcon = { Icon(Icons.Outlined.Refresh, null, tint = P.muted) },
                                    onClick = { menu = false; scope.launch { store.syncNow() } },
                                )
                                if (bioOn) {
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.fingerprint_off), style = Type.callout) },
                                        onClick = { menu = false; store.prefs.biometricBlob = null; bioOn = false },
                                    )
                                }
                            }
                        }
                    }
                    SearchBox(query, { query = it }, Modifier.padding(top = 16.dp, bottom = 4.dp))
                }
            }
            if (items.isEmpty()) {
                item { EmptyState(if (query.isBlank()) R.string.empty_vault else R.string.no_results) }
            } else {
                if (favorites.isNotEmpty()) {
                    item { SectionLabel(stringResource(R.string.favorites), trailing = "${favorites.size}") }
                    groupRows(favorites, "fav", onOpen)
                }
                item { SectionLabel(stringResource(if (query.isBlank()) R.string.all_items else R.string.results), trailing = "${items.size}") }
                groupRows(items, "all", onOpen)
            }
        }
        // New login: accent tile like the desktop "+ New".
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .navigationBarsPadding()
                .padding(20.dp)
                .size(56.dp)
                .shadow(10.dp, RoundedCornerShape(18.dp), ambientColor = P.accent, spotColor = P.accent)
                .clip(RoundedCornerShape(18.dp))
                .background(P.accent)
                .clickable(onClick = onNew)
                .tag("new_login"),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.Add, stringResource(R.string.new_login), tint = Color.White, modifier = Modifier.size(26.dp))
        }
    }
}

/** One rounded group whose rows are separate lazy items (so long lists stay lazy). */
private fun androidx.compose.foundation.lazy.LazyListScope.groupRows(items: List<ItemSummary>, prefix: String, onOpen: (String) -> Unit) {
    itemsIndexed(items, key = { _, it -> prefix + it.id }) { i, item ->
        val first = i == 0
        val last = i == items.lastIndex
        val shape = RoundedCornerShape(
            topStart = if (first) 16.dp else 0.dp, topEnd = if (first) 16.dp else 0.dp,
            bottomStart = if (last) 16.dp else 0.dp, bottomEnd = if (last) 16.dp else 0.dp,
        )
        Column(Modifier.clip(shape).background(P.surface)) {
            ItemRow(item) { onOpen(item.id) }
            if (!last) GroupDivider(inset = 70.dp)
        }
    }
}

@Composable
private fun SyncLine(sync: VaultStore.SyncStatus) {
    val (color, text) = when (sync) {
        VaultStore.SyncStatus.Idle -> P.success to stringResource(R.string.synced)
        VaultStore.SyncStatus.Syncing -> P.accent to stringResource(R.string.syncing)
        is VaultStore.SyncStatus.Failed -> P.danger to stringResource(R.string.sync_failed, sync.message)
    }
    Row(Modifier.padding(top = 4.dp).tag("sync_status"), verticalAlignment = Alignment.CenterVertically) {
        if (sync == VaultStore.SyncStatus.Syncing) {
            CircularProgressIndicator(Modifier.size(10.dp), color = color, strokeWidth = 1.5.dp)
        } else {
            Box(Modifier.size(7.dp).clip(CircleShape).background(color))
        }
        Text(text, style = Type.subhead, color = if (sync is VaultStore.SyncStatus.Failed) P.danger else P.muted, modifier = Modifier.padding(start = 6.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun SearchBox(query: String, onChange: (String) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().height(44.dp).clip(RoundedCornerShape(12.dp)).background(if (P.dark) P.surface2 else P.surface3.copy(alpha = 0.7f)).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Search, null, tint = P.faint, modifier = Modifier.size(19.dp))
        BasicTextField(
            value = query,
            onValueChange = onChange,
            singleLine = true,
            textStyle = Type.body.copy(color = P.text),
            cursorBrush = SolidColor(P.accent),
            modifier = Modifier.weight(1f).padding(start = 8.dp).tag("search"),
            decorationBox = { inner ->
                Box {
                    if (query.isEmpty()) Text(stringResource(R.string.search), style = Type.body, color = P.faint)
                    inner()
                }
            },
        )
        if (query.isNotEmpty()) IconAction(Icons.Rounded.Close, stringResource(R.string.clear), tint = P.faint) { onChange("") }
    }
}

@Composable
private fun EmptyState(text: Int) {
    Column(Modifier.fillMaxWidth().padding(top = 80.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(56.dp).clip(CircleShape).background(P.surface3), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Key, null, tint = P.faint, modifier = Modifier.size(26.dp))
        }
        Text(stringResource(text), style = Type.callout, color = P.muted, modifier = Modifier.padding(top = 12.dp))
    }
}

@Composable
fun ItemRow(item: ItemSummary, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Monogram(item.title, 40.dp, kindIcon(item.kind))
        Column(Modifier.weight(1f).padding(start = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(item.title, style = Type.body.copy(fontWeight = FontWeight.Medium), color = P.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (item.favorite) Icon(Icons.Rounded.Star, stringResource(R.string.favorite), tint = P.warning, modifier = Modifier.padding(start = 4.dp).size(14.dp))
            }
            Text(
                item.username.ifEmpty { if (item.kind == "login") stringResource(R.string.no_username) else kindLabel(item.kind) },
                style = Type.subhead, color = P.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        if (item.hasPasskey) Icon(Icons.Outlined.Key, stringResource(R.string.passkey_saved), tint = P.faint, modifier = Modifier.padding(start = 8.dp).size(16.dp))
    }
}

// ---- detail -------------------------------------------------------------------------------------

@Composable
private fun DetailPage(store: VaultStore, vault: Vault, id: String, toast: (String) -> Unit, onBack: () -> Unit, onEdit: () -> Unit) {
    val revision by store.revision.collectAsState()
    var item by remember { mutableStateOf<ItemDetail?>(null) }
    LaunchedEffect(id, revision) {
        item = vault.item(id)
        if (item == null) onBack()
    }
    val i = item ?: return
    val context = LocalContext.current
    val copy: (String, String, Boolean) -> Unit = { what, value, secret ->
        context.copyToClipboard(what, value, secret)
        toast(context.getString(R.string.copied, what))
    }
    Column(Modifier.fillMaxSize()) {
        TopBar(onBack, stringResource(R.string.back)) {
            if (i.kind == "login") Pill(stringResource(R.string.edit), Icons.Outlined.Edit, onEdit, Modifier.tag("edit"), filled = true)
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding()) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp, bottom = 8.dp, start = 4.dp)) {
                Monogram(i.title, 56.dp, kindIcon(i.kind))
                Column(Modifier.padding(start = 14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(i.title, style = Type.title, color = P.text, modifier = Modifier.weight(1f, fill = false).tag("detail_title"))
                        if (i.favorite) Icon(Icons.Rounded.Star, stringResource(R.string.favorite), tint = P.warning, modifier = Modifier.padding(start = 6.dp).size(18.dp))
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                        Text(kindLabel(i.kind), style = Type.subhead, color = P.muted)
                        if (i.hasPasskey) {
                            Text("  ·  ", style = Type.subhead, color = P.faint)
                            Icon(Icons.Outlined.Key, null, tint = P.muted, modifier = Modifier.size(13.dp))
                            Text(" " + stringResource(R.string.passkey), style = Type.subhead, color = P.muted)
                        }
                    }
                }
            }

            SectionLabel(stringResource(R.string.account))
            Group {
                val user = stringResource(R.string.username)
                FieldRow(user, trailing = { if (i.username.isNotEmpty()) IconAction(Icons.Outlined.ContentCopy, stringResource(R.string.copy)) { copy(user, i.username, false) } }) {
                    Text(i.username.ifEmpty { stringResource(R.string.no_username) }, style = Type.body, color = if (i.username.isEmpty()) P.faint else P.text, modifier = Modifier.tag("detail_username"))
                }
                if (i.password.isNotEmpty()) {
                    GroupDivider()
                    PasswordRow(i.password) { copy(context.getString(R.string.password), i.password, true) }
                }
                if (i.hasTotp) {
                    GroupDivider()
                    TotpRow(vault, id) { code -> copy(context.getString(R.string.totp), code, true) }
                }
            }

            if (i.urls.isNotEmpty()) {
                SectionLabel(stringResource(R.string.websites))
                Group {
                    i.urls.forEachIndexed { n, u ->
                        if (n > 0) GroupDivider()
                        val web = u.startsWith("http://") || u.startsWith("https://")
                        Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(start = 16.dp, end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(u.removePrefix("https://").removePrefix("http://"), style = Type.callout, color = if (web) P.accent else P.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            if (web) IconAction(Icons.AutoMirrored.Outlined.OpenInNew, stringResource(R.string.open)) { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u))) } }
                            IconAction(Icons.Outlined.ContentCopy, stringResource(R.string.copy)) { copy(context.getString(R.string.website), u, false) }
                        }
                    }
                }
            }
            if (i.notes.isNotEmpty()) {
                SectionLabel(stringResource(R.string.notes))
                Group { Text(i.notes, style = Type.callout, color = P.text, modifier = Modifier.padding(16.dp)) }
            }
            if (i.fields.isNotEmpty()) {
                SectionLabel(stringResource(R.string.fields))
                Group {
                    i.fields.forEachIndexed { n, f ->
                        if (n > 0) GroupDivider()
                        FieldRow(f.name, trailing = { IconAction(Icons.Outlined.ContentCopy, stringResource(R.string.copy)) { copy(f.name, f.value, f.protected) } }) {
                            Text(if (f.protected) "••••••••" else f.value, style = Type.body, color = P.text, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            if (i.kind != "login") {
                Text(stringResource(R.string.edit_on_desktop), style = Type.caption, color = P.faint, modifier = Modifier.padding(16.dp))
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}

@Composable
private fun PasswordRow(password: String, onCopy: () -> Unit) {
    var shown by remember { mutableStateOf(false) }
    FieldRow(
        stringResource(R.string.password),
        trailing = {
            IconAction(if (shown) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, stringResource(if (shown) R.string.hide else R.string.show), Modifier.tag("toggle_password")) { shown = !shown }
            IconAction(Icons.Outlined.ContentCopy, stringResource(R.string.copy), onClick = onCopy)
        },
    ) {
        Text(
            if (shown) password else "••••••••••••",
            style = if (shown) Type.mono.copy(fontSize = 16.sp) else Type.body.copy(letterSpacing = 2.sp),
            color = P.text,
            modifier = Modifier.tag("detail_password"),
        )
    }
}

@Composable
private fun TotpRow(vault: Vault, id: String, onCopy: (String) -> Unit) {
    var code by remember { mutableStateOf<String?>(null) }
    var remaining by remember { mutableIntStateOf(0) }
    var period by remember { mutableIntStateOf(30) }
    LaunchedEffect(id) {
        while (true) {
            val c = runCatching { vault.totp(id) }.getOrNull()
            code = c?.code
            remaining = c?.remaining?.toInt() ?: 0
            period = c?.period?.toInt() ?: 30
            delay(1000)
        }
    }
    val c = code ?: return
    FieldRow(stringResource(R.string.totp), trailing = { IconAction(Icons.Outlined.ContentCopy, stringResource(R.string.copy)) { onCopy(c) } }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (c.length == 6) c.take(3) + " " + c.drop(3) else c,
                style = Type.mono.copy(fontSize = 22.sp, fontWeight = FontWeight.Medium, letterSpacing = 1.5.sp),
                color = if (remaining <= 5) P.danger else P.text,
                modifier = Modifier.tag("detail_totp"),
            )
            TotpRing(remaining, period, Modifier.padding(start = 10.dp))
        }
    }
}

// ---- edit ---------------------------------------------------------------------------------------

private sealed interface TotpEdit {
    data object Keep : TotpEdit
    data object Remove : TotpEdit
    data class Set(val value: String) : TotpEdit
}

private data class GeneratorOptions(val length: Int = 20, val upper: Boolean = true, val lower: Boolean = true, val digits: Boolean = true, val symbols: Boolean = true)

@Composable
private fun EditPage(store: VaultStore, vault: Vault, id: String?, onCancel: () -> Unit, onSaved: (String) -> Unit, onTrashed: () -> Unit) {
    val existing = remember(id) { id?.let { vault.item(it) } }
    var title by rememberSaveable { mutableStateOf(existing?.title ?: "") }
    var username by rememberSaveable { mutableStateOf(existing?.username ?: "") }
    var password by remember { mutableStateOf(existing?.password ?: "") }
    val urls = remember { mutableStateListOf<String>().apply { addAll(existing?.urls ?: emptyList()) } }
    var notes by rememberSaveable { mutableStateOf(existing?.notes ?: "") }
    var favorite by rememberSaveable { mutableStateOf(existing?.favorite ?: false) }
    val hadTotp = existing?.hasTotp == true
    var totp by remember { mutableStateOf<TotpEdit>(TotpEdit.Keep) }
    var generator by remember { mutableStateOf<GeneratorOptions?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmTrash by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val errTitle = stringResource(R.string.err_title)
    val errTotp = stringResource(R.string.err_totp)

    fun regenerate(o: GeneratorOptions) {
        generator = o
        password = runCatching { generatePassword(o.length.toUInt(), o.upper, o.lower, o.digits, o.symbols) }.getOrDefault(password)
    }

    fun save() {
        if (busy) return
        if (title.isBlank()) { error = errTitle; return }
        if (totp is TotpEdit.Set && (totp as TotpEdit.Set).value.isBlank()) { error = errTotp; return }
        busy = true
        error = null
        val input = ItemInput(
            id = id, title = title.trim(), username = username, password = password,
            urls = urls.map { it.trim() }.filter { it.isNotEmpty() }, notes = notes, favorite = favorite,
            totp = when (val t = totp) { TotpEdit.Keep -> null; TotpEdit.Remove -> ""; is TotpEdit.Set -> t.value.trim() },
        )
        scope.launch {
            try {
                onSaved(store.saveItem(input))
            } catch (e: VaultException.Failed) {
                error = if (e.code == "invalid-totp") errTotp else e.vaultMessage()
                busy = false
            } catch (e: Exception) {
                error = e.vaultMessage()
                busy = false
            }
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar(onCancel, stringResource(R.string.cancel), stringResource(if (id == null) R.string.new_login else R.string.edit_login)) {
            if (busy) CircularProgressIndicator(Modifier.padding(end = 12.dp).size(20.dp), color = P.accent, strokeWidth = 2.dp)
            else Pill(stringResource(R.string.save), null, { save() }, Modifier.tag("save"), filled = true)
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding()) {
            error?.let { Text(it, style = Type.subhead, color = P.danger, modifier = Modifier.padding(start = 4.dp, top = 4.dp).tag("edit_error")) }

            SectionLabel(stringResource(R.string.account))
            Group(Modifier.padding(0.dp)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Field(title, { title = it }, stringResource(R.string.name), tag = "edit_title")
                    Field(username, { username = it }, stringResource(R.string.username), keyboardType = KeyboardType.Email, tag = "edit_username")
                    Field(password, { password = it }, stringResource(R.string.password), secret = true, mono = true, tag = "edit_password") {
                        IconAction(Icons.Outlined.AutoFixHigh, stringResource(R.string.generate), Modifier.tag("generate"), tint = if (generator != null) P.accent else P.muted) {
                            if (generator == null) regenerate(GeneratorOptions()) else generator = null
                        }
                    }
                    generator?.let { GeneratorPanel(it) { o -> regenerate(o) } }
                }
                GroupDivider(0.dp)
                Row(Modifier.fillMaxWidth().clickable { favorite = !favorite }.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (favorite) Icons.Rounded.Star else Icons.Rounded.StarBorder, null, tint = if (favorite) P.warning else P.muted, modifier = Modifier.size(20.dp))
                    Text(stringResource(R.string.favorite), style = Type.body, color = P.text, modifier = Modifier.weight(1f).padding(start = 12.dp))
                    Switch(favorite, { favorite = it }, colors = SwitchDefaults.colors(checkedTrackColor = P.accent, uncheckedTrackColor = P.surface3, uncheckedBorderColor = Color.Transparent, uncheckedThumbColor = Color.White))
                }
            }

            SectionLabel(stringResource(R.string.totp))
            Group {
                Column(Modifier.padding(16.dp)) {
                    when (val t = totp) {
                        TotpEdit.Keep -> if (hadTotp) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(stringResource(R.string.totp_set), style = Type.body, color = P.muted, modifier = Modifier.weight(1f))
                                TextButton(onClick = { totp = TotpEdit.Set("") }) { Text(stringResource(R.string.totp_replace)) }
                                TextButton(onClick = { totp = TotpEdit.Remove }, modifier = Modifier.tag("totp_remove")) { Text(stringResource(R.string.totp_remove), color = P.danger) }
                            }
                        } else {
                            Field("", { totp = if (it.isEmpty()) TotpEdit.Keep else TotpEdit.Set(it) }, null, placeholder = "otpauth://totp/… / JBSWY3DPEHPK3PXP", mono = true, tag = "edit_totp")
                        }
                        TotpEdit.Remove -> Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(R.string.totp_removed), style = Type.body, color = P.muted, modifier = Modifier.weight(1f))
                            TextButton(onClick = { totp = TotpEdit.Keep }) { Text(stringResource(R.string.undo)) }
                        }
                        is TotpEdit.Set -> Field(t.value, { totp = TotpEdit.Set(it) }, null, placeholder = "otpauth://totp/… / JBSWY3DPEHPK3PXP", mono = true, tag = "edit_totp")
                    }
                }
            }

            SectionLabel(stringResource(R.string.websites))
            Group {
                Column(Modifier.padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    urls.forEachIndexed { n, u ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Field(u, { urls[n] = it }, null, placeholder = "https://", keyboardType = KeyboardType.Uri, modifier = Modifier.weight(1f), tag = "edit_url_$n")
                            IconAction(Icons.Outlined.RemoveCircleOutline, stringResource(R.string.remove), tint = P.danger) { urls.removeAt(n) }
                        }
                    }
                    Row(
                        Modifier.clip(RoundedCornerShape(10.dp)).clickable { urls.add("") }.padding(vertical = 10.dp, horizontal = 4.dp).tag("add_url"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Outlined.Add, null, tint = P.accent, modifier = Modifier.size(20.dp))
                        Text(stringResource(R.string.add_website), style = Type.callout.copy(fontWeight = FontWeight.Medium), color = P.accent, modifier = Modifier.padding(start = 6.dp))
                    }
                }
            }

            SectionLabel(stringResource(R.string.notes))
            Group { Field(notes, { notes = it }, null, singleLine = false, minLines = 3, modifier = Modifier.padding(16.dp)) }

            if (id != null) {
                Text(stringResource(R.string.kept_hint), style = Type.caption, color = P.faint, modifier = Modifier.padding(start = 4.dp, top = 12.dp))
                TonalButton(stringResource(R.string.trash), { confirmTrash = true }, Modifier.fillMaxWidth().padding(top = 24.dp).tag("trash"), icon = Icons.Outlined.DeleteOutline, color = P.danger)
            }
            Spacer(Modifier.height(40.dp))
        }
    }

    if (confirmTrash && id != null) {
        AlertDialog(
            onDismissRequest = { confirmTrash = false },
            containerColor = P.surface,
            text = { Text(stringResource(R.string.trash_confirm), style = Type.body, color = P.text) },
            confirmButton = {
                TextButton(onClick = {
                    confirmTrash = false
                    scope.launch {
                        try { store.trashItem(id); onTrashed() } catch (e: Exception) { error = e.vaultMessage() }
                    }
                }) { Text(stringResource(R.string.trash), color = P.danger, fontWeight = FontWeight.SemiBold) }
            },
            dismissButton = { TextButton(onClick = { confirmTrash = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun GeneratorPanel(o: GeneratorOptions, onChange: (GeneratorOptions) -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(P.surface2).padding(horizontal = 14.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.length, o.length), style = Type.subhead, color = P.muted, modifier = Modifier.width(76.dp))
            Slider(
                value = o.length.toFloat(), onValueChange = { onChange(o.copy(length = it.toInt())) }, valueRange = 8f..64f,
                colors = SliderDefaults.colors(thumbColor = P.accent, activeTrackColor = P.accent, inactiveTrackColor = P.surface3),
                modifier = Modifier.weight(1f),
            )
            IconAction(Icons.Outlined.Refresh, stringResource(R.string.regenerate)) { onChange(o.copy()) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp)) {
            listOf("A-Z" to o.upper, "a-z" to o.lower, "0-9" to o.digits, "!@#" to o.symbols).forEachIndexed { n, (label, on) ->
                Box(
                    Modifier
                        .weight(1f)
                        .height(34.dp)
                        .clip(RoundedCornerShape(9.dp))
                        .background(if (on) P.accentSoft else P.surface)
                        .clickable {
                            val next = when (n) { 0 -> o.copy(upper = !on); 1 -> o.copy(lower = !on); 2 -> o.copy(digits = !on); else -> o.copy(symbols = !on) }
                            if (next.upper || next.lower || next.digits || next.symbols) onChange(next)
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(label, style = Type.subhead.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium), color = if (on) P.accent else P.faint)
                }
            }
        }
    }
}
